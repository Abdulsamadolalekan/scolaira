// @vitest-environment node
/**
 * Phase 2 — opening balances, tested against the real database.
 *
 * What is being proven here is not "the code runs". It is the six things that
 * make a carry-in feature safe to put next to a ledger:
 *
 *   1. A recorded figure changes nothing. No invoice, no payment, no bucket moves.
 *   2. Only an approved HISTORICAL_BALANCE can become money, and the DATABASE
 *      refuses the other three categories — not the TypeScript.
 *   3. A posted carry-in is a real prior-term invoice: the existing H-2 buckets
 *      pick it up as PRIOR_TERM debt, and this term's billing is untouched.
 *   4. A carry-in cannot be smuggled onto the term the school is billing, even by
 *      raw SQL that goes around every repository. This is the exact shortcut the
 *      design considered and rejected, so it is pinned from both sides.
 *   5. A child cannot be double-charged for the same past term, and a refused
 *      posting leaves NOTHING behind — not an orphan draft invoice.
 *   6. The register is not erasable, is invisible to other tenants, and every act
 *      is on the audit trail with the person who did it.
 *
 * The harness runs each test inside a transaction that is rolled back, so the
 * fixture is a fresh two-org school every time (see tests/setup-db.ts).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { auditEvents, invoiceLines, invoices, openingBalances } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as openingRepo from '@/lib/db/repo/opening-balances';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import { invoiceBuckets } from '@/lib/db/repo/aggregates';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

/** The seeded school's active term starts here (tests/support/seed.ts). */
const ACTIVE_STARTS = '2026-04-15';
/** A date inside the past term, before the active term began. */
const AS_AT = '2025-12-31';
const AMOUNT = 45_000_000; // ₦450,000.00

function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function seed() {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb(), ctx: ctxFor(ids.orgId, ids.aliceId) };
}

/** A real history to carry in from: a closed term of a previous session. */
async function addPriorTerm(): Promise<{ sessionId: UUID; termId: UUID }> {
  const sessionId = randomUUID() as UUID;
  const termId = randomUUID() as UUID;
  await testSql()`INSERT INTO academic_sessions (id, name, starts_on, ends_on, is_current, status)
    VALUES (${sessionId}::uuid, '2024/2025', '2024-09-01', '2025-07-31', false, 'CLOSED')`;
  await testSql()`INSERT INTO terms (id, session_id, name, label, starts_on, ends_on, due_date, is_current, status)
    VALUES (${termId}::uuid, ${sessionId}::uuid, 'Second Term', '2nd',
            '2025-01-06', '2025-04-04', '2025-03-28', false, 'CLOSED')`;
  return { sessionId, termId };
}

function errorMessage(e: unknown): string {
  const anyErr = e as { message?: string; cause?: { message?: string } };
  return `${anyErr?.message ?? ''} | ${anyErr?.cause?.message ?? ''}`;
}

/**
 * Run something that is expected to be refused, then restore the transaction with
 * a savepoint so the test can still assert what the refusal left behind. Without
 * this, a rejected statement poisons the per-test transaction and "nothing was
 * written" becomes untestable.
 */
async function attempt(fn: () => Promise<unknown>): Promise<{ refused: boolean; message: string }> {
  const sp = `probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await testSql().unsafe(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await testSql().unsafe(`RELEASE SAVEPOINT ${sp}`);
    return { refused: false, message: '(the statement was allowed — that is the failure)' };
  } catch (e) {
    await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    return { refused: true, message: errorMessage(e) };
  }
}

async function balanceCount(db: ReturnType<typeof testDb>, ctx: TenantCtx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(openingBalances)
    .where(eq(openingBalances.organizationId, ctx.organizationId));
  return Number(rows[0]?.n ?? 0);
}

async function invoiceCount(db: ReturnType<typeof testDb>, ctx: TenantCtx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.organizationId, ctx.organizationId));
  return Number(rows[0]?.n ?? 0);
}

async function outstandingBuckets(db: ReturnType<typeof testDb>, ctx: TenantCtx, termId: UUID) {
  const buckets = await invoiceBuckets(db, ctx, { id: termId, startsOn: ACTIVE_STARTS });
  return Object.fromEntries(buckets.map((b) => [b.bucket, b.outstandingKobo])) as Record<
    'CURRENT_TERM' | 'PRIOR_TERM' | 'OTHER_TERM',
    number
  >;
}

describe('opening balances — recording', () => {
  it('records a figure as a draft and derives the sign from the category', async () => {
    const { db, ctx, ids } = await seed();

    const owed = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: null,
      sourceNote: 'Old receipt book, page 14',
    });
    expect(owed.status).toBe('DRAFT');
    expect(Number(owed.amountKobo)).toBe(AMOUNT);
    expect(Number(owed.signedAmountKobo)).toBe(AMOUNT);
    expect(owed.createdBy).toBe(ids.aliceId);
    expect(owed.selfReviewed).toBe(false);

    const credit = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'CREDIT_OVERPAYMENT',
      amountKobo: 25_000_000,
      asAt: AS_AT,
      sourceNote: 'Double payment in error, March 2025',
      evidenceRef: 'bank statement 2025-03',
    });
    // The magnitude is never negative — the ledger's own domain forbids it. The
    // sign lives beside it, derived, so a credit can reduce what is owed in the
    // report without pretending to be a payment.
    expect(Number(credit.amountKobo)).toBe(25_000_000);
    expect(Number(credit.signedAmountKobo)).toBe(-25_000_000);

    const totals = await openingRepo.summary(db, ctx);
    expect(totals.count).toBe(2);
    expect(totals.byCategory.HISTORICAL_BALANCE.amountKobo).toBe(AMOUNT);
    expect(totals.byCategory.CREDIT_OVERPAYMENT.signedAmountKobo).toBe(-25_000_000);
    expect(totals.postedKobo).toBe(0);
    expect(totals.outstandingKobo).toBe(0);
  });

  it('changes nothing in the ledger — no invoice, no payment, no bucket', async () => {
    const { db, ctx, ids } = await seed();
    const before = await outstandingBuckets(db, ctx, ids.termId);
    expect(before).toEqual({ CURRENT_TERM: 0, PRIOR_TERM: 0, OTHER_TERM: 0 });

    await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Carried in from the old file',
    });

    expect(await invoiceCount(db, ctx)).toBe(0);
    const after = await outstandingBuckets(db, ctx, ids.termId);
    expect(after).toEqual({ CURRENT_TERM: 0, PRIOR_TERM: 0, OTHER_TERM: 0 });
    const pays = await testSql()`SELECT count(*)::int AS n FROM payments`;
    expect(Number(pays[0]!.n)).toBe(0);
  });

  it('refuses a figure with no source, no amount, or a fuzzy date', async () => {
    const { db, ctx, ids } = await seed();
    const base = {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE' as const,
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    };
    await expect(openingRepo.record(db, ctx, { ...base, sourceNote: 'x' })).rejects.toThrow(
      /where this figure came from/i,
    );
    await expect(openingRepo.record(db, ctx, { ...base, amountKobo: 0 })).rejects.toThrow(
      /greater than zero/i,
    );
    await expect(openingRepo.record(db, ctx, { ...base, asAt: 'Dec 2025' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(await balanceCount(db, ctx)).toBe(0);
  });

  it('refuses to book a carry-in on the term the school is billing', async () => {
    const { db, ctx, ids } = await seed();
    await expect(
      openingRepo.record(db, ctx, {
        studentId: ids.studentAId,
        category: 'HISTORICAL_BALANCE',
        amountKobo: AMOUNT,
        asAt: AS_AT,
        termId: ids.termId,
        sourceNote: 'Old receipt book, page 14',
      }),
    ).rejects.toThrow(/is the current term/i);
    expect(await balanceCount(db, ctx)).toBe(0);
  });

  it('keeps an unverified figure out of every money total', async () => {
    const { db, ctx, ids } = await seed();
    await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'UNVERIFIED',
      amountKobo: 900_000_000,
      asAt: AS_AT,
      sourceNote: 'Head-told me about 900k, no paper',
    });
    const totals = await openingRepo.summary(db, ctx);
    expect(totals.byCategory.UNVERIFIED.count).toBe(1);
    expect(totals.byCategory.UNVERIFIED.amountKobo).toBe(900_000_000);
    // Counted as a record, not as money owed: the whole point of the category.
    expect(totals.outstandingKobo).toBe(0);
    expect(totals.postedKobo).toBe(0);
  });

  it('stamps the row with the caller’s own tenant even when a foreign one is forged', async () => {
    const { db, ids } = await seed();
    await testSql()`INSERT INTO opening_balances
        (organization_id, student_id, category, amount_kobo, signed_amount_kobo,
         as_at, source_note, created_by, status)
      VALUES
        (${ids.orgBId}::uuid, ${ids.studentAId}::uuid, 'HISTORICAL_BALANCE',
         ${AMOUNT}, ${AMOUNT}, ${AS_AT}::date, 'Forged organization id', ${ids.aliceId}::uuid, 'DRAFT')`;

    const rows = await db
      .select({ organizationId: openingBalances.organizationId })
      .from(openingBalances);
    expect(rows.length).toBe(1);
    expect(rows[0]!.organizationId).toBe(ids.orgId);

    // And the rival school still cannot see it.
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const rival = await testDb()
      .select({ id: openingBalances.id })
      .from(openingBalances)
      .where(eq(openingBalances.organizationId, ids.orgBId));
    expect(rival.length).toBe(0);
  });
});

describe('opening balances — review, and the register\u2019s own immutability', () => {
  it('approves by a named person, and says so when that person is the recorder', async () => {
    const { db, ctx, ids } = await seed();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });

    const approved = await openingRepo.review(
      db,
      ctx,
      row.id,
      'APPROVE',
      'Checked against the file',
    );
    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewedBy).toBe(ids.aliceId);
    // A one-person school is not locked out — but the row records that the same
    // person recorded and approved it, and it is never presented as independent.
    expect(approved.selfReviewed).toBe(true);
  });

  it('records a genuine second reviewer as such', async () => {
    const { db, ctx, ids } = await seed();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });

    // Give the school a second member, as a school would, then review as them.
    await testSql()`SELECT auth_enter_system_context()`;
    await testSql()`SELECT set_config('app.is_platform_admin','1',false)`;
    await testSql()`INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at)
      VALUES (${ids.orgId}::uuid, ${ids.bobId}::uuid, 'SCHOOL_ADMIN', 'ACTIVE', now(), now(), now())
      ON CONFLICT DO NOTHING`;
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.bobId}::uuid)`;

    const bobCtx = ctxFor(ids.orgId, ids.bobId);
    const approved = await openingRepo.review(db, bobCtx, row.id, 'APPROVE', null);
    expect(approved.reviewedBy).toBe(ids.bobId);
    expect(approved.selfReviewed).toBe(false);
    expect(await openingRepo.getView(db, bobCtx, row.id)).not.toBeNull();
    void ctx;
  });

  it('requires a reason to reject, and refuses a review of a row that is already decided', async () => {
    const { db, ctx, ids } = await seed();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });
    await expect(openingRepo.review(db, ctx, row.id, 'REJECT', '   ')).rejects.toThrow(
      /needs a reason/i,
    );
    const rejected = await openingRepo.review(
      db,
      ctx,
      row.id,
      'REJECT',
      'The figure is for the wrong child',
    );
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reviewNote).toBe('The figure is for the wrong child');
    await expect(openingRepo.review(db, ctx, row.id, 'APPROVE', null)).rejects.toThrow(
      /cannot be approved/i,
    );
  });

  it('freezes an approved figure: no editing the amount, no erasing the row', async () => {
    const { db, ctx, ids } = await seed();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);

    const edit = await attempt(
      () => testSql()`UPDATE opening_balances SET amount_kobo = 1 WHERE id = ${row.id}::uuid`,
    );
    expect(edit.refused).toBe(true);
    expect(edit.message).toMatch(/immutable/i);

    // A tenant may not delete its own register either — it is corrected, not erased.
    const wipe = await attempt(
      () => testSql()`DELETE FROM opening_balances WHERE id = ${row.id}::uuid`,
    );
    void wipe; // refused by trigger or matched nothing under RLS — both must leave the row, asserted below
    const still = await db
      .select({ id: openingBalances.id })
      .from(openingBalances)
      .where(eq(openingBalances.id, row.id));
    expect(still.length).toBe(1);

    // And the denial is structural, not a fluke of this one row:
    const shape = await testSql()`SELECT pg_get_expr(polqual, polrelid) AS expr, polpermissive
      FROM pg_policy WHERE polrelid = 'opening_balances'::regclass
        AND polname = 'opening_balances_no_delete'`;
    expect(shape.length).toBe(1);
    expect(String(shape[0]!.expr)).toBe('false');
    expect(shape[0]!.polpermissive).toBe(false);
  });

  it('will not let the sign be typed in by hand', async () => {
    const { db, ctx, ids } = await seed();
    await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'UNVERIFIED',
      amountKobo: 10_000,
      asAt: AS_AT,
      sourceNote: 'Said on the phone, to be confirmed',
    });
    // A "credit" whose signed amount adds to what is owed is a data-entry lie, and
    // the CHECK makes it impossible rather than discouraged.
    const bad = await attempt(
      () =>
        testSql()`INSERT INTO opening_balances
          (organization_id, student_id, category, amount_kobo, signed_amount_kobo,
           as_at, source_note, created_by, status)
        VALUES
          (${ids.orgId}::uuid, ${ids.studentAId}::uuid, 'CREDIT_OVERPAYMENT',
           10000, 10000, ${AS_AT}::date, 'Sign tampered', ${ids.aliceId}::uuid, 'DRAFT')`,
    );
    expect(bad.refused).toBe(true);
    expect(bad.message).toMatch(/opening_balances_sign_matches_category|check constraint/i);
  });
});

describe('opening balances — posting into the ledger', () => {
  it('posts an approved historical balance as a real prior-term invoice, and the buckets see it', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const before = await outstandingBuckets(db, ctx, ids.termId);

    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
    const result = await openingRepo.post(db, ctx, row.id);

    // A normal invoice, through the normal doors.
    expect(result.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(result.invoiceTotalKobo).toBe(AMOUNT);
    expect(result.lineAmountKobo).toBe(AMOUNT);
    expect(result.dueDate).toBe(AS_AT);
    const [inv] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.invoiceId as UUID));
    expect(inv!.status).toBe('ISSUED');
    expect(inv!.termId).toBe(prior.termId);
    expect(inv!.studentId).toBe(ids.studentAId);
    expect(String(inv!.dueDate)).toBe(AS_AT);
    const lines = await db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, result.invoiceId as UUID));
    expect(lines.length).toBe(1);

    const [balance] = await db
      .select()
      .from(openingBalances)
      .where(eq(openingBalances.id, row.id as UUID));
    expect(balance!.status).toBe('POSTED');
    expect(balance!.postedInvoiceId).toBe(result.invoiceId);

    // THE POINT OF THE WHOLE DESIGN: the debt lands in the bucket that means
    // "owed from before", and this term's figures do not move at all.
    const after = await outstandingBuckets(db, ctx, ids.termId);
    expect(before.PRIOR_TERM).toBe(0);
    expect(after.PRIOR_TERM).toBe(AMOUNT);
    expect(after.CURRENT_TERM).toBe(before.CURRENT_TERM);
    const sumAfter = after.CURRENT_TERM + after.PRIOR_TERM + after.OTHER_TERM;
    const sumBefore = before.CURRENT_TERM + before.PRIOR_TERM + before.OTHER_TERM;
    expect(sumAfter - sumBefore).toBe(AMOUNT);

    // And the register reads the ledger, so it cannot drift from it.
    const view = await openingRepo.getView(db, ctx, row.id);
    expect(view!.status).toBe('POSTED');
    expect(view!.outstandingKobo).toBe(AMOUNT);
    expect(view!.postedInvoiceNumber).toBe(result.invoiceNumber);
    expect(view!.canPost).toBe(false);
    const totals = await openingRepo.summary(db, ctx);
    expect(totals.postedKobo).toBe(AMOUNT);
    expect(totals.outstandingKobo).toBe(AMOUNT);
    expect(totals.collectedAgainstCarryInKobo).toBe(0);
  });

  it('refuses to post what has not been approved', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await expect(openingRepo.post(db, ctx, row.id)).rejects.toThrow(/approved/i);
    expect(await invoiceCount(db, ctx)).toBe(0);
  });

  it('refuses to post a credit, an unverified figure, or an unbilled term amount — from the database too', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    // A real, issuable prior-term invoice to point at, so the ONLY thing that can
    // refuse the update below is the category rule — not a missing target.
    const bait = await invoicesRepo.createDraft(db, ctx, {
      studentId: ids.studentAId,
      termId: prior.termId,
      sessionId: prior.sessionId,
      dueDate: AS_AT,
    });
    await invoiceLinesRepo.addLine(db, ctx, {
      invoiceId: bait.id,
      description: 'Bait invoice for a forbidden posting',
      quantity: 1,
      unitRateKobo: kobo(AMOUNT) as never,
      amountKobo: kobo(AMOUNT) as never,
    });
    await invoicesRepo.issue(db, ctx, bait.id);

    for (const category of ['CREDIT_OVERPAYMENT', 'UNVERIFIED', 'CURRENT_TERM_UNBILLED'] as const) {
      const row = await openingRepo.record(db, ctx, {
        studentId: ids.studentAId,
        category,
        amountKobo: 5_000_000,
        asAt: AS_AT,
        sourceNote: 'Recorded for the file, not for the ledger',
      });
      await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
      await expect(openingRepo.post(db, ctx, row.id)).rejects.toThrow(
        /cannot be posted|recorded here/i,
      );

      // The same attempt made in raw SQL, going around the repository entirely.
      const probe = await attempt(
        () =>
          testSql()`UPDATE opening_balances
             SET status = 'POSTED', posted_invoice_id = ${bait.id}::uuid, posted_at = now()
           WHERE id = ${row.id}::uuid`,
      );
      expect(probe.refused).toBe(true);
      expect(probe.message).toMatch(/cannot be posted/i);
    }
    // Only the bait invoice exists; none of the three forbidden postings made one.
    expect(await invoiceCount(db, ctx)).toBe(1);
  });

  it('cannot be smuggled onto the active term by back-dating an invoice', async () => {
    const { db, ctx, ids } = await seed();

    // An invoice on the ACTIVE term, deliberately back-dated to last session.
    const draft = await invoicesRepo.createDraft(db, ctx, {
      studentId: ids.studentAId,
      termId: ids.termId,
      sessionId: ids.sessionId,
      dueDate: AS_AT,
    });
    await invoiceLinesRepo.addLine(db, ctx, {
      invoiceId: draft.id,
      description: 'Back-dated',
      quantity: 1,
      unitRateKobo: kobo(AMOUNT) as never,
      amountKobo: kobo(AMOUNT) as never,
    });
    await invoicesRepo.issue(db, ctx, draft.id);

    // The row is planted by hand: `record()` would never have accepted the active
    // term. This is what a future writer that goes around the repository could do,
    // and it is what the posting guard exists to stop.
    await testSql()`INSERT INTO opening_balances
        (organization_id, student_id, category, amount_kobo, signed_amount_kobo,
         as_at, term_id, source_note, created_by, status, reviewed_by, reviewed_at)
      VALUES
        (${ids.orgId}::uuid, ${ids.studentAId}::uuid, 'HISTORICAL_BALANCE',
         ${AMOUNT}, ${AMOUNT}, ${AS_AT}::date, ${ids.termId}::uuid,
         'Back-dated onto the active term', ${ids.aliceId}::uuid, 'APPROVED',
         ${ids.aliceId}::uuid, now())`;
    const planted = (
      await testSql()`SELECT id FROM opening_balances WHERE source_note = 'Back-dated onto the active term'`
    )[0]!;

    const probe = await attempt(
      () =>
        testSql()`UPDATE opening_balances
           SET status = 'POSTED', posted_invoice_id = ${draft.id}::uuid, posted_at = now()
         WHERE id = ${planted.id}::uuid`,
    );
    expect(probe.refused).toBe(true);
    // `auth_invoice_scope_buckets` classifies `term_id = active term` as
    // CURRENT_TERM before it looks at any date, which is why this is refused.
    expect(probe.message).toMatch(/current term|active term/i);

    // Nothing was half-applied: the row is still APPROVED, unposted, and the
    // back-dated invoice is untouched.
    const after = (
      await testSql()`SELECT status, posted_invoice_id FROM opening_balances WHERE id = ${planted.id}::uuid`
    )[0]!;
    expect(after.status).toBe('APPROVED');
    expect(after.posted_invoice_id).toBeNull();
    const buckets = await outstandingBuckets(db, ctx, ids.termId);
    expect(buckets.CURRENT_TERM).toBe(AMOUNT); // the pre-existing draft invoice, not the register
    expect(buckets.PRIOR_TERM).toBe(0);
  });

  it('refuses a second posted carry-in for the same child on the same term, and leaves no orphan invoice', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const first = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, first.id, 'APPROVE', null);
    await openingRepo.post(db, ctx, first.id);
    const invoicesAfterFirst = await invoiceCount(db, ctx);
    expect(invoicesAfterFirst).toBe(1);

    // The same debt entered by a second person, on purpose this time.
    const second = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Also in the class file',
    });
    await openingRepo.review(db, ctx, second.id, 'APPROVE', null);

    const probe = await attempt(() => openingRepo.post(db, ctx, second.id));
    expect(probe.refused).toBe(true);
    expect(probe.message).toMatch(/duplicate key|already posted|unique/i);

    // The atomicity claim that matters: the rolled-back attempt created no second
    // invoice, so the family is not double-charged by a failed click.
    expect(await invoiceCount(db, ctx)).toBe(invoicesAfterFirst);
    const row = (
      await testSql()`SELECT status FROM opening_balances WHERE id = ${second.id}::uuid`
    )[0]!;
    expect(row.status).toBe('APPROVED');
  });

  it('follows the ledger afterwards: a voided carry-in invoice stops being owed', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
    const posted = await openingRepo.post(db, ctx, row.id);
    expect((await openingRepo.getView(db, ctx, row.id))!.outstandingKobo).toBe(AMOUNT);

    // Not reversed through this feature: voided from the invoices surface, the way
    // a school would actually do it. The register must not keep claiming a debt.
    await invoicesRepo.voidInvoice(
      db,
      ctx,
      posted.invoiceId as UUID,
      'This debt was settled outside',
    );
    const view = await openingRepo.getView(db, ctx, row.id);
    expect(view!.postedInvoiceStatus).toBe('VOID');
    expect(view!.outstandingKobo).toBe(0);
    expect(view!.postBlockedBecause).toMatch(/no longer owed/i);
    const totals = await openingRepo.summary(db, ctx);
    expect(totals.outstandingKobo).toBe(0);
    expect(totals.collectedAgainstCarryInKobo).toBe(0);
  });

  it('reverses cleanly when no money has touched it, and refuses when it has', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
    const posted = await openingRepo.post(db, ctx, row.id);

    // A payment is applied to the carry-in invoice by the normal allocation door.
    const pay = await paymentsRepo.record(db, ctx, {
      method: 'BANK_TRANSFER',
      amountKobo: kobo(10_000_000) as never,
    });
    await allocationsRepo.allocate(db, ctx, {
      paymentId: pay.id,
      invoiceId: posted.invoiceId as UUID,
      amountKobo: kobo(10_000_000) as never,
    });

    await expect(openingRepo.reverse(db, ctx, row.id, 'Wrong child')).rejects.toThrow(
      /Reverse the payment first|payment has already been applied/i,
    );

    // The view still derives the remaining figure from the invoice, because that is
    // where the truth is: 450,000.00 carried in, 100,000.00 received.
    const view = await openingRepo.getView(db, ctx, row.id);
    expect(view!.outstandingKobo).toBe(AMOUNT - 10_000_000);
    expect((await openingRepo.summary(db, ctx)).collectedAgainstCarryInKobo).toBe(10_000_000);

    // Pulling the payment back from here is refused on purpose — so the money is
    // reversed through the ledger's own door first, and only then is the carry-in
    // reversal allowed. Two records remain, instead of none.
    await reversalsRepo.create(db, ctx, {
      paymentId: pay.id,
      amountKobo: kobo(10_000_000) as never,
      reason: 'Paid to the wrong invoice',
    });
    const reversed = await openingRepo.reverse(
      db,
      ctx,
      row.id,
      'Wrong child — belongs to the sibling',
    );
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversalReason).toBe('Wrong child — belongs to the sibling');
    const [inv] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, posted.invoiceId as UUID));
    expect(inv!.status).toBe('VOID');
    expect(await invoiceCount(db, ctx)).toBe(1); // voided, not erased
  });

  it('refuses a reversal with no reason', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
    await openingRepo.post(db, ctx, row.id);
    await expect(openingRepo.reverse(db, ctx, row.id, '   ')).rejects.toThrow(/reason/i);
  });
});

describe('opening balances — tenancy and the audit trail', () => {
  it('is invisible and untouchable from another tenant', async () => {
    const { db, ctx, ids } = await seed();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const bobCtx = ctxFor(ids.orgBId, ids.bobId);
    expect(await openingRepo.get(db, bobCtx, row.id)).toBeNull();
    expect((await openingRepo.list(db, bobCtx)).length).toBe(0);
    expect((await openingRepo.summary(db, bobCtx)).count).toBe(0);

    const tamper = await attempt(
      () => testSql()`UPDATE opening_balances SET amount_kobo = 1 WHERE id = ${row.id}::uuid`,
    );
    // RLS makes the row not exist for bob, so the UPDATE matches nothing. Either
    // outcome (refused, or zero rows) leaves the figure intact — that is asserted.
    void tamper;
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const [still] = await db
      .select({ amountKobo: openingBalances.amountKobo, status: openingBalances.status })
      .from(openingBalances)
      .where(eq(openingBalances.id, row.id as UUID));
    expect(Number(still!.amountKobo)).toBe(AMOUNT);
    expect(still!.status).toBe('DRAFT');
  });

  it('writes one audit event per act, naming who and what', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', 'Checked against the file');
    await openingRepo.post(db, ctx, row.id);

    const events = await db
      .select({
        action: auditEvents.action,
        actorUserId: auditEvents.actorUserId,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, ctx.organizationId),
          eq(auditEvents.entityType, 'opening_balance'),
        ),
      );
    expect(events.map((e) => e.action).sort()).toEqual(
      ['opening_balance.approve', 'opening_balance.post', 'opening_balance.record'].sort(),
    );
    for (const e of events) {
      expect(e.entityId).toBe(row.id);
      expect(e.actorUserId).toBe(ids.aliceId);
    }
    const postEvent = events.find((e) => e.action === 'opening_balance.post')!;
    expect(JSON.stringify(postEvent.after)).toContain(String(AMOUNT));
    expect(JSON.stringify(postEvent.after)).toContain('termName');
  });

  it('reports what still needs a decision, so the guide can show one next action', async () => {
    const { db, ctx, ids } = await seed();
    const prior = await addPriorTerm();
    const a = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      termId: prior.termId,
      sourceNote: 'Old receipt book, page 14',
    });
    expect(await openingRepo.countNeedingAttention(db, ctx)).toEqual({
      drafts: 1,
      approvedUnposted: 0,
    });
    await openingRepo.review(db, ctx, a.id, 'APPROVE', null);
    expect(await openingRepo.countNeedingAttention(db, ctx)).toEqual({
      drafts: 0,
      approvedUnposted: 1,
    });

    const totals = await openingRepo.summary(db, ctx);
    expect(totals.pendingPostCount).toBe(1);
    expect(totals.hasPriorTerm).toBe(true);
    expect(totals.hasCurrentTerm).toBe(true);

    await openingRepo.post(db, ctx, a.id);
    expect(await openingRepo.countNeedingAttention(db, ctx)).toEqual({
      drafts: 0,
      approvedUnposted: 0,
    });
  });

  it('tells a school with no history yet that it cannot post, instead of inventing a term', async () => {
    const { db, ctx, ids } = await seed();
    const totals = await openingRepo.summary(db, ctx);
    expect(totals.hasPriorTerm).toBe(false);

    const row = await openingRepo.record(db, ctx, {
      studentId: ids.studentAId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: AMOUNT,
      asAt: AS_AT,
      sourceNote: 'Old receipt book, page 14',
    });
    await openingRepo.review(db, ctx, row.id, 'APPROVE', null);
    await expect(openingRepo.post(db, ctx, row.id)).rejects.toThrow(/which past term/i);
    expect(await invoiceCount(db, ctx)).toBe(0);

    const view = await openingRepo.getView(db, ctx, row.id);
    expect(view!.canPost).toBe(false);
    expect(view!.postBlockedBecause).toMatch(/which past term/i);
  });
});
