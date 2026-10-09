// @vitest-environment node
/**
 * Rich deterministic seed coherence tests (§XI).
 *
 * Loads applyRichSeed against a fresh two-org base fixture and asserts every
 * documented balance/status invariant holds. This doubles as a "deterministic
 * seed smoke" — if future trigger changes break these invariants, the seed
 * (and any dev/demo script that relies on it) fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { testDb, testSql } from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import { applyRichSeed } from '../support/rich-seed';
import { eq } from 'drizzle-orm';
import { invoices, payments, paymentAllocations, reversals, paymentLinks, auditEvents, webhookEvents, idempotencyKeys } from '@/lib/db/schema';

describe('Rich seed financial coherence', () => {
  it('all invoices have consistent status/paid/total', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const rich = await applyRichSeed(testSql(), ids);
    const db = testDb();

    const [draft] = await db.select().from(invoices).where(eq(invoices.id, rich.invDraftId)).limit(1);
    expect(draft!.status).toBe('DRAFT');
    expect(draft!.totalKobo).toBe(0);
    expect(draft!.paidKobo).toBe(0);

    const [paid] = await db.select().from(invoices).where(eq(invoices.id, rich.invPaidId)).limit(1);
    expect(paid!.status).toBe('PAID');
    expect(paid!.paidKobo).toBe(paid!.totalKobo);

    const [partial] = await db.select().from(invoices).where(eq(invoices.id, rich.invPartialId)).limit(1);
    expect(partial!.status).toBe('PARTIALLY_PAID');
    expect(partial!.paidKobo).toBeGreaterThan(0);
    expect(partial!.paidKobo).toBeLessThan(partial!.totalKobo);

    const [over] = await db.select().from(invoices).where(eq(invoices.id, rich.invOverpaidId)).limit(1);
    expect(over!.status).toBe('PAID');
    expect(over!.paidKobo).toBe(over!.totalKobo);

    const [rev] = await db.select().from(invoices).where(eq(invoices.id, rich.invReversedId)).limit(1);
    expect(rev!.status).toBe('ISSUED');
    expect(rev!.paidKobo).toBe(0);
  });

  it('overpayment preserved on payment', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const rich = await applyRichSeed(testSql(), ids);
    const db = testDb();
    const [p] = await db.select().from(payments).where(eq(payments.id, rich.payPosId)).limit(1);
    expect(p!.unallocatedKobo).toBe(rich.overpaymentKobo);
    expect(p!.status).toBe('CONFIRMED');
  });

  it('reversed payment flipped to REVERSED, allocation REVERSED, reversal row exists', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const rich = await applyRichSeed(testSql(), ids);
    const db = testDb();
    const [p] = await db.select().from(payments).where(eq(payments.id, rich.payReversedId)).limit(1);
    expect(p!.status).toBe('REVERSED');
    expect(p!.unallocatedKobo).toBe(p!.amountKobo);
    const [a] = await db.select().from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, rich.payReversedId)).limit(1);
    expect(a!.status).toBe('REVERSED');
    expect(a!.reversalId).toBeTruthy();
    const [r] = await db.select().from(reversals).where(eq(reversals.paymentId, rich.payReversedId)).limit(1);
    expect(r!.reason).toBe('parent dispute');
    expect(r!.amountKobo).toBeGreaterThan(0);
  });

  it('payment link, audit, webhook, idempotency rows all present in org A', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const rich = await applyRichSeed(testSql(), ids);
    const db = testDb();

    const [link] = await db.select().from(paymentLinks).where(eq(paymentLinks.invoiceId, rich.invPartialId)).limit(1);
    expect(link).toBeTruthy();
    expect(link!.status).toBe('ACTIVE');
    expect(link!.token.startsWith('rich-pl-token-')).toBe(true);

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, rich.invPaidId as any)).limit(5);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]!.action).toBe('invoice.issued');

    const [wh] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, 'evt_rich_001')).limit(1);
    expect(wh!.status).toBe('PROCESSED');
    expect(wh!.organizationId).toBe(rich.orgId);

    const [ik] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'ik-rich-001')).limit(1);
    expect(ik).toBeTruthy();
    expect(ik!.scope).toBe('API');
  });
});
