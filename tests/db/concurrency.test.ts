// @vitest-environment node
/**
 * Concurrency tests using genuinely separate Postgres connections (§X).
 *
 * Each test uses setupConcurrencyFixtures() to create a fresh organization
 * via AUTOCOMMIT on a new connection (so writes are visible to concurrent
 * connections). Each concurrent worker gets its own short-lived connection.
 * Teardown DROPs the organization between tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupConcurrencyFixtures, type ConcurrencyFixtures } from '../support/concurrent-seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import { kobo } from '@/lib/money';
import { invoices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/db';

const URL = process.env.DATABASE_URL ?? 'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';

function withConn<T>(orgId: string, userId: string, fn: (args: { sql: postgres.Sql; db: Database }) => Promise<T>): Promise<T> {
  return new Promise<T>(async (resolve, reject) => {
    const sql = postgres(URL, { max: 1 });
    try {
      await sql`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
      const db = drizzle(sql) as unknown as Database;
      const r = await fn({ sql, db });
      resolve(r);
    } catch (e) { reject(e); }
    finally {
      await sql`SELECT set_config('app.organization_id', '', false), set_config('app.user_id', '', false), set_config('app.is_platform_admin', '0', false)`.catch(() => {});
      await sql.end({ timeout: 5 });
    }
  });
}

async function issueInvoice(f: ConcurrencyFixtures, amount: number) {
  // Use dedicated connection for setup (autocommit outside the per-test txn).
  return withConn(f.orgId, f.userId, async ({ db }) => {
    const ctx = { organizationId: f.orgId, userId: f.userId };
    const inv = await invoicesRepo.createDraft(db as any, ctx, {
      studentId: f.studentId, termId: f.termId, sessionId: f.sessionId,
    });
    await invoiceLinesRepo.addLines(db as any, ctx, inv.id, [
      { description: 'Tuition', quantity: 1, unitRateKobo: kobo(amount), amountKobo: kobo(amount) },
    ]);
    return invoicesRepo.issue(db as any, ctx, inv.id);
  });
}

async function recordPayment(f: ConcurrencyFixtures, amount: number) {
  return withConn(f.orgId, f.userId, async ({ db }) => {
    const ctx = { organizationId: f.orgId, userId: f.userId };
    return paymentsRepo.record(db as any, ctx, {
      method: 'BANK_TRANSFER', amountKobo: kobo(amount), reference: 'CR-' + randomUUID(),
    });
  });
}

async function readInvoice(f: ConcurrencyFixtures, id: string) {
  return withConn(f.orgId, f.userId, async ({ db }) => {
    const rows = await db.select().from(invoices).where(eq(invoices.id, id as any)).limit(1);
    return rows[0];
  });
}

describe('Concurrency — real PG sessions', () => {
  let fx: ConcurrencyFixtures;

  afterEach(async () => {
    if (fx) { await fx.teardown(); }
  });

  it('concurrent invoice inserts never produce duplicate invoice numbers', async () => {
    fx = await setupConcurrencyFixtures();
    const N = 6;
    const numbers = new Set<string>();
    const errs: any[] = [];

    await Promise.all(
      Array.from({ length: N }).map(() =>
        withConn(fx.orgId, fx.userId, async ({ db }) => {
          try {
            const ctx = { organizationId: fx.orgId, userId: fx.userId };
            const inv = await invoicesRepo.createDraft(db as any, ctx, {
              studentId: fx.studentId, termId: fx.termId, sessionId: fx.sessionId,
            });
            await invoiceLinesRepo.addLines(db as any, ctx, inv.id, [
              { description: 'Cc', quantity: 1, unitRateKobo: kobo(1000), amountKobo: kobo(1000) },
            ]);
            const issued = await invoicesRepo.issue(db as any, ctx, inv.id);
            numbers.add(issued.invoiceNumber);
          } catch (e) { errs.push(e); }
        }),
      ),
    );

    expect(errs.length).toBe(0);
    expect(numbers.size).toBe(N);
  });

  it('allocation contention: two oversize payments against same invoice → exactly one wins, no over-allocation', async () => {
    fx = await setupConcurrencyFixtures();
    const inv = await issueInvoice(fx, 10_000_000);
    const p1 = await recordPayment(fx, 6_000_000);
    const p2 = await recordPayment(fx, 6_000_000);

    const winners: any[] = [];
    const losers: any[] = [];
    await Promise.all([
      withConn(fx.orgId, fx.userId, async ({ db }) => {
        const ctx = { organizationId: fx.orgId, userId: fx.userId };
        try {
          const r = await allocationsRepo.allocate(db as any, ctx, { paymentId: p1.id, invoiceId: inv.id, amountKobo: kobo(6_000_000) });
          winners.push({ pay: p1.id, r });
        } catch (e) { losers.push({ pay: p1.id, e }); }
      }),
      withConn(fx.orgId, fx.userId, async ({ db }) => {
        const ctx = { organizationId: fx.orgId, userId: fx.userId };
        try {
          const r = await allocationsRepo.allocate(db as any, ctx, { paymentId: p2.id, invoiceId: inv.id, amountKobo: kobo(6_000_000) });
          winners.push({ pay: p2.id, r });
        } catch (e) { losers.push({ pay: p2.id, e }); }
      }),
    ]);

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    const invAfter = await readInvoice(fx, inv.id);
    expect(invAfter!.paidKobo).toBe(6_000_000);
    expect(invAfter!.paidKobo).toBeLessThanOrEqual(10_000_000);
    expect(invAfter!.status).toBe('PARTIALLY_PAID');
  });

  it('concurrent legitimate payments → both survive, no lost updates, full PAID', async () => {
    fx = await setupConcurrencyFixtures();
    const inv = await issueInvoice(fx, 20_000_000);
    const p1 = await recordPayment(fx, 10_000_000);
    const p2 = await recordPayment(fx, 10_000_000);

    const errs: any[] = [];
    await Promise.all([
      withConn(fx.orgId, fx.userId, async ({ db }) => {
        const ctx = { organizationId: fx.orgId, userId: fx.userId };
        try { await allocationsRepo.allocate(db as any, ctx, { paymentId: p1.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) }); }
        catch (e) { errs.push(e); }
      }),
      withConn(fx.orgId, fx.userId, async ({ db }) => {
        const ctx = { organizationId: fx.orgId, userId: fx.userId };
        try { await allocationsRepo.allocate(db as any, ctx, { paymentId: p2.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) }); }
        catch (e) { errs.push(e); }
      }),
    ]);

    expect(errs.length).toBe(0);
    const invAfter = await readInvoice(fx, inv.id);
    expect(invAfter!.paidKobo).toBe(20_000_000);
    expect(invAfter!.status).toBe('PAID');
  });
});
