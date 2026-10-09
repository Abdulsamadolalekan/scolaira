// @vitest-environment node
/**
 * Financial invariant tests (§VII of the M2 mandate).
 *
 * Runs in NODE environment (not jsdom) because DB code imports `server-only`
 * and uses Postgres network clients.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { invoices, payments } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';
import type { SeededIds } from '../support/seed';

function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function seedAndLogin(): Promise<{ ids: SeededIds; db: ReturnType<typeof testDb>; ctx: TenantCtx }> {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb(), ctx: ctxFor(ids.orgId, ids.aliceId) };
}

async function createIssuedInvoice(
  ctx: TenantCtx,
  db: ReturnType<typeof testDb>,
  ids: SeededIds,
  amount: number,
) {
  const invoice = await invoicesRepo.createDraft(db, ctx, {
    studentId: ids.studentAId,
    termId: ids.termId,
    sessionId: ids.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
    { description: 'Tuition', quantity: 1, unitRateKobo: kobo(amount), amountKobo: kobo(amount) },
  ]);
  await invoicesRepo.issue(db, ctx, invoice.id);
  return invoice;
}

describe('Invoices', () => {
  it('DRAFT → add line → total_kobo recomputed → ISSUE sets issued_at', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await invoicesRepo.createDraft(db, ctx, {
      studentId: ids.studentAId,
      termId: ids.termId,
      sessionId: ids.sessionId,
    });
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);

    await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
      { description: 'Tuition', quantity: 1, unitRateKobo: kobo(45_000_000), amountKobo: kobo(45_000_000) },
    ]);
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
    expect(after!.totalKobo).toBe(45_000_000);
    expect(after!.paidKobo).toBe(0);

    const issued = await invoicesRepo.issue(db, ctx, invoice.id);
    expect(issued.status).toBe('ISSUED');
    expect(issued.issuedAt).not.toBeNull();
  });

  it('blocks post-issuance line editing', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await createIssuedInvoice(ctx, db, ids, 45_000_000);
    await expect(
      invoiceLinesRepo.addLines(db, ctx, invoice.id, [
        { description: 'Late fee', quantity: 1, unitRateKobo: kobo(500_000), amountKobo: kobo(500_000) },
      ]),
    ).rejects.toThrow();
  });

  it('blocks direct paid_kobo UPDATE (pg_trigger_depth guard)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await invoicesRepo.createDraft(db, ctx, {
      studentId: ids.studentAId,
      termId: ids.termId,
      sessionId: ids.sessionId,
    });
    let threw = false;
    try {
      await db.update(invoices).set({ paidKobo: 999_999 }).where(eq(invoices.id, invoice.id));
    } catch (e: any) {
      threw = true;
      const msg = (e.message ?? '') + ' | ' + (e.cause?.message ?? '');
      expect(msg).toMatch(/direct/i);
    }
    expect(threw).toBe(true);
  });
});

describe('Payments + allocations', () => {
  it('CONFIRMED payment seeds unallocated = amount; allocation reduces both', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await createIssuedInvoice(ctx, db, ids, 45_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    expect(pay.status).toBe('CONFIRMED');
    expect(pay.unallocatedKobo).toBe(10_000_000);

    const { invoice: invAfter, payment: payAfter } = await allocationsRepo.allocate(db, ctx, {
      paymentId: pay.id,
      invoiceId: invoice.id,
      amountKobo: kobo(10_000_000),
    });
    expect(payAfter.unallocatedKobo).toBe(0);
    expect(invAfter.paidKobo).toBe(10_000_000);
    expect(invAfter.status).toBe('PARTIALLY_PAID');
  });

  it('over-allocation is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await createIssuedInvoice(ctx, db, ids, 45_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: invoice.id, amountKobo: kobo(10_000_000) });
    let threw = false;
    try {
      await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: invoice.id, amountKobo: kobo(5_000_000) });
    } catch (e: any) {
      threw = true;
      const msg = (e.message ?? '') + ' | ' + (e.cause?.message ?? '');
      expect(msg).toMatch(/(exceeds|unalloc|over|insufficient|remain)/i);
    }
    expect(threw).toBe(true);
  });

  it('second payment + full allocation → PAID, overpayment preserved on second payment', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await createIssuedInvoice(ctx, db, ids, 45_000_000);
    const pay1 = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay1.id, invoiceId: invoice.id, amountKobo: kobo(10_000_000) });

    const pay2 = await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(40_000_000), reference: 'BANK-001' });
    const { invoice: fullyPaid, payment: p2After } = await allocationsRepo.allocate(db, ctx, {
      paymentId: pay2.id,
      invoiceId: invoice.id,
      amountKobo: kobo(35_000_000),
    });
    expect(fullyPaid.paidKobo).toBe(45_000_000);
    expect(fullyPaid.status).toBe('PAID');
    expect(p2After.unallocatedKobo).toBe(5_000_000);
  });

  it('reversal restores invoice/payment state (oldest-first)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const invoice = await createIssuedInvoice(ctx, db, ids, 45_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: invoice.id, amountKobo: kobo(10_000_000) });
    await reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(10_000_000), reason: 'Parent requested refund' });

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
    expect(inv!.paidKobo).toBe(0);
    expect(inv!.status).toBe('ISSUED');
    const [p] = await db.select().from(payments).where(eq(payments.id, pay.id)).limit(1);
    expect(p!.status).toBe('REVERSED');
    expect(p!.unallocatedKobo).toBe(10_000_000);
  });
});
