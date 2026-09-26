// @vitest-environment node
/**
 * State-machine negative tests (§IX).
 *
 * For each guarded entity we seed a valid initial row, then attempt an
 * invalid transition via raw UPDATE and assert it raises. Valid transitions
 * are exercised in the financial-invariants / flows tests.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import {
  invoices, payments, paymentAllocations, receipts,
  paymentLinks, academicSessions, terms, feeAssignments, feeDefinitions,
} from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as paymentLinksRepo from '@/lib/db/repo/payment-links';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';
import type { SeededIds } from '../support/seed';

function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function seedAndLogin() {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb(), ctx: ctxFor(ids.orgId, ids.aliceId) };
}

async function expectRejects<T>(p: Promise<T>, pattern: RegExp = /Invalid status transition|check_violation|invalid_input/i): Promise<void> {
  let threw = false;
  try { await p; } catch (e: any) {
    threw = true;
    const msg = (e?.message ?? '') + ' | ' + (e?.cause?.message ?? '');
    expect(msg).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

async function issueInvoice(db: any, ctx: TenantCtx, ids: SeededIds, amount: number) {
  const inv = await invoicesRepo.createDraft(db, ctx, {
    studentId: ids.studentAId, termId: ids.termId, sessionId: ids.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, inv.id, [
    { description: 'T', quantity: 1, unitRateKobo: kobo(amount), amountKobo: kobo(amount) },
  ]);
  return invoicesRepo.issue(db, ctx, inv.id);
}

describe('State machines — invalid transitions are rejected', () => {
  it('invoices: ISSUED -> DRAFT rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await issueInvoice(db, ctx, ids, 10_000_000);
    await expectRejects(
      db.update(invoices).set({ status: 'DRAFT' } as any).where(eq(invoices.id, inv.id)),
    );
  });

  it('invoices: PAID -> ISSUED without reversal rejected (balance guard)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await issueInvoice(db, ctx, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    await expectRejects(
      db.update(invoices).set({ status: 'ISSUED' } as any).where(eq(invoices.id, inv.id)),
      /Invalid/,
    );
  });

  it('invoices: VOID -> ISSUED rejected', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await issueInvoice(db, ctx, ids, 10_000_000);
    await db.update(invoices).set({ status: 'VOID', voidedReason: 'err' } as any).where(eq(invoices.id, inv.id));
    await expectRejects(
      db.update(invoices).set({ status: 'ISSUED' } as any).where(eq(invoices.id, inv.id)),
    );
  });

  it('payments: CONFIRMED -> PENDING regression rejected', async () => {
    const { db, ctx } = await seedAndLogin();
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000) });
    await expectRejects(
      db.update(payments).set({ status: 'PENDING' } as any).where(eq(payments.id, pay.id)),
    );
  });

  it('payment_allocations: REVERSED -> ACTIVE regression rejected (once reversed cannot flip back)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const inv = await issueInvoice(db, ctx, ids, 10_000_000);
    const pay = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000_000) });
    await allocationsRepo.allocate(db, ctx, { paymentId: pay.id, invoiceId: inv.id, amountKobo: kobo(10_000_000) });
    // Create a reversal to flip the allocation to REVERSED
    await reversalsRepo.create(db, ctx, { paymentId: pay.id, amountKobo: kobo(10_000_000), reason: 'oops' });
    const [allocation] = await db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, pay.id)).limit(1);
    expect(allocation!.status).toBe('REVERSED');
    // Now attempt to flip back to ACTIVE — pg_trigger_depth guard blocks direct UPDATE.
    await expectRejects(
      db.update(paymentAllocations).set({ status: 'ACTIVE' } as any).where(eq(paymentAllocations.id, allocation!.id)),
      /(append.?only|forbidden|permission denied|Invalid status transition)/i,
    );
  });

  it('receipts: invalid status (PAID) rejected — cast fails on enum', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    // Receipts are not auto-created by allocation triggers in M2 (repo layer
    // issues them). Insert one directly.
    const [rcpt] = await db.insert(receipts).values({
      organizationId: ctx.organizationId,
      paymentId: (await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(10_000) })).id,
      studentId: ids.studentAId,
      amountKobo: kobo(10_000),
      status: 'ISSUED',
    } as any).returning();
    expect(rcpt).toBeTruthy();
    await expectRejects(
      db.update(receipts).set({ status: 'PAID' as any }).where(eq(receipts.id, rcpt!.id)),
      /./,
    );
  });

  it('payment_links: PAID -> ACTIVE regression rejected', async () => {
    const { db, ctx } = await seedAndLogin();
    const link = await paymentLinksRepo.create(db, ctx, { token: 'tk_' + Date.now(), amountKobo: kobo(10_000) });
    await db.update(paymentLinks).set({ status: 'PAID' } as any).where(eq(paymentLinks.id, link.id));
    await expectRejects(
      db.update(paymentLinks).set({ status: 'ACTIVE' } as any).where(eq(paymentLinks.id, link.id)),
    );
  });

  it('payment_links: ACTIVE -> bogus enum value REVOKED_BAD rejected', async () => {
    const { db, ctx } = await seedAndLogin();
    const link = await paymentLinksRepo.create(db, ctx, { token: 'tk2_' + Date.now(), amountKobo: kobo(10_000) });
    await expectRejects(
      db.update(paymentLinks).set({ status: 'BOGUS' as any }).where(eq(paymentLinks.id, link.id)),
      /./,
    );
  });

  it('academic_sessions: ACTIVE -> PLANNED regression rejected', async () => {
    const { db, ids } = await seedAndLogin();
    await expectRejects(
      db.update(academicSessions).set({ status: 'PLANNED' } as any).where(eq(academicSessions.id, ids.sessionId)),
    );
  });

  it('terms: ACTIVE -> PLANNED regression rejected', async () => {
    const { db, ids } = await seedAndLogin();
    await expectRejects(
      db.update(terms).set({ status: 'PLANNED' } as any).where(eq(terms.id, ids.termId)),
    );
  });

  it('fee_assignments: DRAFT -> ARCHIVED rejected (must go DRAFT->ACTIVE first)', async () => {
    const { db, ctx, ids } = await seedAndLogin();
    const [fd] = await db.insert(feeDefinitions).values({
      organizationId: ctx.organizationId, code: 'TUITION', name: 'Tuition',
    } as any).returning();
    const [fa] = await db.insert(feeAssignments).values({
      organizationId: ctx.organizationId, feeDefinitionId: fd!.id, termId: ids.termId,
      classId: ids.classId, amountKobo: kobo(5000), status: 'DRAFT',
    } as any).returning();
    await expectRejects(
      db.update(feeAssignments).set({ status: 'ARCHIVED' } as any).where(eq(feeAssignments.id, fa!.id)),
    );
  });
});
