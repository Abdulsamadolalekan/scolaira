// @vitest-environment node
/**
 * Financial-invariant ATTACKS suite (§VII).
 *
 * These tests deliberately try to break the money — negative amounts,
 * over-invoicing, void of a paid invoice without reversal, direct SQL forgery
 * of derived columns, issued→draft regression, zero/negative allocations,
 * double-reversal, etc.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { invoices, payments, paymentAllocations, reversals } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import { kobo } from '@/lib/money';
import { RepoInvariantError } from '@/lib/db/repo/_context';
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

async function createIssued(
  ctx: TenantCtx,
  db: ReturnType<typeof testDb>,
  ids: SeededIds,
  amount: number,
) {
  const invoice = await invoicesRepo.createDraft(db, ctx, {
    studentId: ids.studentAId, termId: ids.termId, sessionId: ids.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
    { description: 'Tuition', quantity: 1, unitRateKobo: kobo(amount), amountKobo: kobo(amount) },
  ]);
  await invoicesRepo.issue(db, ctx, invoice.id);
  return invoice;
}

/** Helper: assert an awaited promise rejects, and return the concatenated message (drizzle wraps). */
async function expectRejects<T>(p: Promise<T>, pattern: RegExp): Promise<void> {
  let threw = false;
  try { await p; } catch (e: any) {
    threw = true;
    const msg = (e?.message ?? '') + ' | ' + (e?.cause?.message ?? '') + ' | ' + (e?.detail ?? '');
    expect(msg).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

describe('Negative / zero amounts are rejected', () => {
  it('payment with negative amount raises RepoInvariantError', async () => {
    const { db, ctx } = await seedAndLogin();
    await expect(
      paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: -1 as any }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('allocation with zero/negative amount raises RepoInvariantError', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await expect(
      allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: 0 as any }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
    await expect(
      allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: -500 as any }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('reversal with zero/negative amount raises RepoInvariantError', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    await expect(
      reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: 0 as any, reason: 'x' }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });
});

describe('Status-machine attacks on invoices', () => {
  it('ISSUED → DRAFT regression is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    await expectRejects(
      db.update(invoices).set({ status: 'DRAFT' }).where(eq(invoices.id, inv.id)),
      /Invalid status transition/,
    );
  });

  it('PAID → ISSUED regression (without reversal) is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    await expectRejects(
      db.update(invoices).set({ status: 'ISSUED' }).where(eq(invoices.id, inv.id)),
      /(Invalid status transition|Invalid invoice state)/,
    );
  });

  it('voiding a PAID invoice leaves paid_kobo intact (app-layer reversal expected)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    // PAID->VOID is allowed by the state machine; DB does NOT silently zero
    // paid_kobo — the application MUST first reverse allocations, then void.
    // Documented M2 limitation: we don't auto-reverse on void; integrity is
    // preserved because paid_kobo remains set and any future reallocation
    // path is constrained by the status/balance checks.
    const [voided] = await db.update(invoices)
      .set({ status: 'VOID', voidedReason: 'skip-audit', voidedBy: ctx.userId } as any)
      .where(eq(invoices.id, inv.id))
      .returning();
    expect(voided!.paidKobo).toBe(10_000_000);
    expect(voided!.status).toBe('VOID');
  });
});

describe('Direct SQL forgery of derived columns', () => {
  it('direct update of invoices.total_kobo is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await invoicesRepo.createDraft(db, ctx, {
      studentId: ids.studentAId, termId: ids.termId, sessionId: ids.sessionId,
    });
    await expectRejects(
      db.update(invoices).set({ totalKobo: 999_999_999 } as any).where(eq(invoices.id, inv.id)),
      /Direct update/,
    );
  });

  it('direct update of payments.unallocated_kobo is rejected', async () => {
    const { db, ctx } = await seedAndLogin();
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(5_000_000) });
    await expectRejects(
      db.update(payments).set({ unallocatedKobo: 999_999_999 } as any).where(eq(payments.id, pay.id)),
      /Direct update/,
    );
  });

  it('direct DELETE of an ACTIVE allocation is rejected (audit append-only)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    const { allocation } = await allocationsRepo.allocate(db, ctx, {
      paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000),
    });
    await expectRejects(
      db.delete(paymentAllocations).where(eq(paymentAllocations.id, allocation.id)),
      /(append.?only|Direct|permission denied|forbidden)/i,
    );
  });

  it('direct UPDATE to an allocation amount is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    const { allocation } = await allocationsRepo.allocate(db, ctx, {
      paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000),
    });
    await expectRejects(
      db.update(paymentAllocations).set({ amountKobo: 1 } as any).where(eq(paymentAllocations.id, allocation.id)),
      /(append.?only|Direct|forbidden|permission denied)/i,
    );
  });

  it('direct UPDATE of a reversal row is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    const rev = await reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(10_000_000), reason: 'oops' });
    await expectRejects(
      db.update(reversals).set({ reason: 'tampered' } as any).where(eq(reversals.id, rev.id)),
      /(append.?only|forbidden|permission denied)/i,
    );
  });

  it('direct DELETE of a reversal row is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    const rev = await reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(10_000_000), reason: 'oops' });
    await expectRejects(
      db.delete(reversals).where(eq(reversals.id, rev.id)),
      /(append.?only|forbidden|permission denied)/i,
    );
  });
});

describe('Allocation against over-invoiced invoice is rejected', () => {
  it('cannot allocate more than invoice outstanding', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(50_000_000) });
    await expectRejects(
      allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(20_000_000) }),
      /(outstanding|exceeds|invoice)/i,
    );
  });
});

describe('Reversal guard', () => {
  it('reversing more than reversible amount is rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await createIssued(ctx, db, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    await reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(10_000_000), reason: 'first' });
    await expectRejects(
      reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(1), reason: 'double' }),
      /(revers|exceed)/i,
    );
  });
});
