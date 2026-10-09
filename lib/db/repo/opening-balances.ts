/**
 * Opening balances repository — Phase 2.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS TABLE IS, AND WHAT IT IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 *   `opening_balances` is the register of money a school carries in when it
 *   starts using SCOLAIRA. It is the record of the claim, with its source and its
 *   reviewer. It is NOT a ledger: it holds no balance that anything else reads.
 *
 *   Only one of the four categories is allowed to become a financial event, and
 *   the database enforces that, not this file:
 *
 *     HISTORICAL_BALANCE   → may be POSTED, as a real invoice on a PRIOR term,
 *                            due before the active term began. That is exactly
 *                            what the existing H-2 "Prior-term debt" bucket
 *                            reports, so the carry-in becomes allocatable,
 *                            receiptable and reconcilable with no change to any
 *                            ledger invariant, policy, function or state machine.
 *     CREDIT_OVERPAYMENT   → never posted. The ledger cannot represent a signed
 *                            opening balance: `payments_amount_positive`,
 *                            `pay_unalloc_le_amount` and the `kobo_value` domain on
 *                            invoice lines all refuse it, and `payments` means
 *                            money received. Posting a credit would fabricate a
 *                            deposit and inflate that school's collections. Recorded
 *                            and reported here, with an explicit reason, until a
 *                            signed-balance concept exists (Phase 4/5 work).
 *     CURRENT_TERM_UNBILLED→ never posted from here. Term billing (`billTerm`) is
 *                            the only door allowed to create this term's invoices;
 *                            a second door double-charges the child the moment the
 *                            billing run happens. This category is a to-do that says
 *                            "run billing", not an invoice.
 *     UNVERIFIED           → never posted, and excluded from every total. A figure
 *                            nobody has confirmed is not a debt.
 *
 *   The amount actually owed is NEVER stored here as truth. `list` and `summary`
 *   derive it by joining the posted invoice and reading `total_kobo - paid_kobo` —
 *   the two columns the ledger's own triggers maintain — so if a school later voids
 *   the carry-in invoice, pays part of it, or reverses a payment against it, the
 *   register follows the ledger automatically instead of disagreeing with it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SEPARATION OF DUTIES, STATED HONESTLY
 * ════════════════════════════════════════════════════════════════════════════
 *   A figure must be reviewed before it posts. There is no database rule anywhere
 *   in this schema that forces reviewer ≠ recorder (checked: `waivers`, `reversals`
 *   and `financial_periods` all record who approved and none of them require a
 *   different person), and a one-person school would be locked out of its own
 *   opening balances if a new rule invented that requirement. So `selfReviewed` is
 *   DERIVED IN THE DATABASE (0052's BEFORE trigger computes it from
 *   `reviewed_by = created_by`, and a CHECK makes a disagreeing value impossible)
 *   and surfaced in the UI and in the audit event: self-approval is allowed, and it
 *   is never invisible. Repository code never sets the flag.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { openingBalances, invoices, students, terms } from '../schema';
import * as invoiceRepo from './invoices';
import * as lineRepo from './invoice-lines';
import * as auditRepo from './audit-events';
import { asUUID, RepoInvariantError, type TenantCtx, type TenantScopedDb } from './_context';

export type OpeningBalance = typeof openingBalances.$inferSelect;

export const OPENING_BALANCE_CATEGORIES = [
  'CURRENT_TERM_UNBILLED',
  'HISTORICAL_BALANCE',
  'CREDIT_OVERPAYMENT',
  'UNVERIFIED',
] as const;
export type OpeningBalanceCategory = (typeof OPENING_BALANCE_CATEGORIES)[number];

export const OPENING_BALANCE_STATUSES = [
  'DRAFT',
  'APPROVED',
  'REJECTED',
  'POSTED',
  'REVERSED',
] as const;
export type OpeningBalanceStatus = (typeof OPENING_BALANCE_STATUSES)[number];

/** Human labels, shared by the API and the guide so the two never disagree. */
export const OPENING_BALANCE_CATEGORY_LABELS: Record<OpeningBalanceCategory, string> = {
  CURRENT_TERM_UNBILLED: 'This term, not yet billed',
  HISTORICAL_BALANCE: 'Owed from before',
  CREDIT_OVERPAYMENT: 'Credit / overpayment',
  UNVERIFIED: 'Unverified',
};

/** The category may only be posted by `HISTORICAL_BALANCE`; mirrored from the DB CHECK. */
export function categoryIsPostable(category: OpeningBalanceCategory): boolean {
  return category === 'HISTORICAL_BALANCE';
}

/** The sign is derived from the category, never typed. Mirrors the DB CHECK. */
export function signedAmountFor(category: OpeningBalanceCategory, amountKobo: number): number {
  return category === 'CREDIT_OVERPAYMENT' ? -amountKobo : amountKobo;
}

const POSTABLE_MIN_KOBO = 1;
/** ₦10 billion. A single carry-in above this is a data error, not a fee. */
export const MAX_AMOUNT_KOBO = 1_000_000_000_000;

export interface RecordInput {
  studentId: string;
  category: OpeningBalanceCategory;
  amountKobo: number;
  asAt: string; // YYYY-MM-DD
  termId?: string | null;
  sourceNote: string;
  evidenceRef?: string | null;
}

/** What a row looks like to the surface: the record, plus who it is about and what is still owed. */
export interface OpeningBalanceView {
  id: string;
  studentId: string;
  studentName: string;
  studentNumber: string | null;
  category: OpeningBalanceCategory;
  categoryLabel: string;
  amountKobo: number;
  signedAmountKobo: number;
  asAt: string;
  termId: string | null;
  termName: string | null;
  sourceNote: string;
  evidenceRef: string | null;
  status: OpeningBalanceStatus;
  createdBy: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  selfReviewed: boolean;
  postedInvoiceId: string | null;
  postedInvoiceNumber: string | null;
  /** The posted invoice's own status — the only reason `POSTED` can move backwards. */
  postedInvoiceStatus: string | null;
  /** The invoice's own trigger-maintained figures, read back, never recomputed. */
  postedInvoiceTotalKobo: number | null;
  postedInvoicePaidKobo: number | null;
  /** Derived from the ledger, not stored: what that invoice still shows as owed.
   *  `null` when nothing has been posted; `0` when the invoice was voided, because
   *  a voided charge is not a debt. */
  outstandingKobo: number | null;
  canPost: boolean;
  postBlockedBecause: string | null;
}

function isoDate(value: unknown): string {
  return String(value).slice(0, 10);
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Everything that must be true before a row is inserted, checked HERE so the
 * caller gets a sentence a school can act on instead of a domain-violation
 * string. The database repeats each of these (0052) because a check that only
 * exists in TypeScript is a suggestion.
 */
export function validateRecord(input: RecordInput): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.amountKobo)) {
    problems.push('Amount must be a whole number of kobo.');
  } else if (input.amountKobo < POSTABLE_MIN_KOBO) {
    problems.push('Amount must be greater than zero — a zero balance is nothing to record.');
  } else if (input.amountKobo > MAX_AMOUNT_KOBO) {
    problems.push('That amount is too large to be a single carry-in balance.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asAt)) {
    problems.push('The "as at" date must be written as YYYY-MM-DD.');
  }
  if (input.sourceNote.trim().length < 5) {
    problems.push(
      'Say where this figure came from (for example "old receipt book, page 14"). A balance with no source is not a record.',
    );
  }
  if (!OPENING_BALANCE_CATEGORIES.includes(input.category)) {
    problems.push('Unknown category.');
  }
  return problems;
}

/**
 * Record one carry-in figure. It lands as DRAFT: recording and posting are
 * separate acts, and only an approved figure can be posted.
 */
export async function record(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: RecordInput,
): Promise<OpeningBalance> {
  const problems = validateRecord(input);
  if (problems.length > 0) {
    throw new RepoInvariantError(problems[0]!);
  }
  if (!ctx.userId) {
    throw new RepoInvariantError(
      'An opening balance must be recorded by a named person, so the trail has a who.',
    );
  }

  const studentRows = await db
    .select({ id: students.id, status: students.status, deletedAt: students.deletedAt })
    .from(students)
    .where(
      and(
        eq(students.id, asUUID(input.studentId)),
        eq(students.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  const student = studentRows[0];
  if (!student || student.deletedAt) {
    throw new RepoInvariantError(
      'That student is not in this school, so nothing can be recorded for them.',
    );
  }

  if (input.termId) {
    const term = await loadTerm(db, ctx, input.termId);
    if (term.isCurrent) {
      throw new RepoInvariantError(
        `“${term.name}” is the current term. A carry-in cannot be booked on the term you are billing — record it as “${OPENING_BALANCE_CATEGORY_LABELS.CURRENT_TERM_UNBILLED}” and run billing for it.`,
      );
    }
  }

  const rows = await db
    .insert(openingBalances)
    .values({
      organizationId: ctx.organizationId,
      studentId: asUUID(input.studentId) as never,
      category: input.category,
      amountKobo: input.amountKobo as never,
      signedAmountKobo: signedAmountFor(input.category, input.amountKobo) as never,
      asAt: input.asAt,
      termId: input.termId ? (asUUID(input.termId) as never) : null,
      sourceNote: input.sourceNote.trim(),
      evidenceRef: input.evidenceRef?.trim() ? input.evidenceRef.trim().slice(0, 160) : null,
      status: 'DRAFT',
      createdBy: ctx.userId as never,
    })
    .returning();
  const row = rows[0]!;

  await auditRepo.record(db, ctx, {
    action: 'opening_balance.record',
    entityType: 'opening_balance',
    entityId: row.id,
    after: {
      studentId: row.studentId,
      category: row.category,
      amountKobo: row.amountKobo,
      signedAmountKobo: row.signedAmountKobo,
      asAt: String(row.asAt),
      termId: row.termId,
      sourceNote: row.sourceNote,
      evidenceRef: row.evidenceRef,
      status: row.status,
    },
  });
  return row;
}

async function loadTerm(db: TenantScopedDb, ctx: TenantCtx, termId: string) {
  const rows = await db
    .select({
      id: terms.id,
      name: terms.name,
      startsOn: terms.startsOn,
      isCurrent: terms.isCurrent,
      sessionId: terms.sessionId,
    })
    .from(terms)
    .where(and(eq(terms.id, asUUID(termId)), eq(terms.organizationId, ctx.organizationId)))
    .limit(1);
  const term = rows[0];
  if (!term) throw new RepoInvariantError('That term is not in this school.');
  return term;
}

/** The school's current term, or null. The posting guard is defined against it. */
export async function currentTerm(db: TenantScopedDb, ctx: TenantCtx) {
  const rows = await db
    .select({
      id: terms.id,
      name: terms.name,
      startsOn: terms.startsOn,
      sessionId: terms.sessionId,
    })
    .from(terms)
    .where(and(eq(terms.organizationId, ctx.organizationId), eq(terms.isCurrent, true)))
    .orderBy(desc(terms.startsOn))
    .limit(1);
  return rows[0] ?? null;
}

/** Prior terms, oldest last — the only terms a carry-in may be booked against. */
export async function priorTerms(db: TenantScopedDb, ctx: TenantCtx) {
  const rows = await db
    .select({
      id: terms.id,
      name: terms.name,
      startsOn: terms.startsOn,
      sessionId: terms.sessionId,
      isCurrent: terms.isCurrent,
    })
    .from(terms)
    .where(and(eq(terms.organizationId, ctx.organizationId), eq(terms.isCurrent, false)))
    .orderBy(desc(terms.startsOn));
  return rows;
}

async function hydrate(
  db: TenantScopedDb,
  where: ReturnType<typeof and>,
  limit: number | null,
): Promise<OpeningBalanceView[]> {
  const rows = (await db
    .select({
      id: openingBalances.id,
      studentId: openingBalances.studentId,
      studentFirst: students.firstName,
      studentLast: students.lastName,
      studentNumber: students.studentId,
      category: openingBalances.category,
      amountKobo: openingBalances.amountKobo,
      signedAmountKobo: openingBalances.signedAmountKobo,
      asAt: openingBalances.asAt,
      termId: openingBalances.termId,
      termName: terms.name,
      sourceNote: openingBalances.sourceNote,
      evidenceRef: openingBalances.evidenceRef,
      status: openingBalances.status,
      createdBy: openingBalances.createdBy,
      reviewedBy: openingBalances.reviewedBy,
      reviewNote: openingBalances.reviewNote,
      selfReviewed: openingBalances.selfReviewed,
      postedInvoiceId: openingBalances.postedInvoiceId,
      postedInvoiceNumber: invoices.invoiceNumber,
      postedInvoiceStatus: invoices.status,
      postedInvoiceTotalKobo: invoices.totalKobo,
      postedInvoicePaidKobo: invoices.paidKobo,
    })
    .from(openingBalances)
    .innerJoin(students, eq(students.id, openingBalances.studentId))
    .leftJoin(terms, eq(terms.id, openingBalances.termId))
    .leftJoin(invoices, eq(invoices.id, openingBalances.postedInvoiceId))
    .where(where!)
    .orderBy(desc(openingBalances.createdAt), desc(openingBalances.id))
    .limit(limit ?? 500)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const category = String(r.category) as OpeningBalanceCategory;
    const status = String(r.status) as OpeningBalanceStatus;
    const invoiceStatus = str(r.postedInvoiceStatus);
    const total = r.postedInvoiceTotalKobo === null ? null : num(r.postedInvoiceTotalKobo);
    const paid = r.postedInvoicePaidKobo === null ? null : num(r.postedInvoicePaidKobo);
    const posted = r.postedInvoiceId !== null;
    // A voided invoice stops being owed. Reading it this way — instead of storing
    // a second "still owed" number here — is what keeps the register unable to
    // disagree with the ledger.
    const live = posted && invoiceStatus !== null && invoiceStatus !== 'VOID';
    const outstanding = posted ? (live ? Math.max((total ?? 0) - (paid ?? 0), 0) : 0) : null;
    const canPost = status === 'APPROVED' && categoryIsPostable(category) && r.termId !== null;
    let blocked: string | null = null;
    if (!canPost && status !== 'POSTED' && status !== 'REJECTED' && status !== 'REVERSED') {
      if (status === 'DRAFT') blocked = 'It has to be approved before it can be posted.';
      else if (!categoryIsPostable(category)) {
        blocked =
          category === 'CREDIT_OVERPAYMENT'
            ? 'A credit cannot be posted: SCOLAIRA has no signed opening balance yet, and calling it a payment would report money the school never received.'
            : category === 'CURRENT_TERM_UNBILLED'
              ? 'This term’s fees come from billing, not from opening balances — posting one here would charge the child twice when you bill the term.'
              : 'An unverified figure is not a debt. Verify it, then record it as what it turns out to be.';
      } else if (r.termId === null) {
        blocked =
          'Record which past term it belongs to, so it lands where the school’s own history is kept.';
      }
    }
    if (
      status === 'POSTED' &&
      invoiceStatus &&
      invoiceStatus !== 'ISSUED' &&
      invoiceStatus !== 'PARTIALLY_PAID' &&
      invoiceStatus !== 'PAID'
    ) {
      blocked = `The invoice it was posted to is now ${invoiceStatus.toLowerCase()}, so this carry-in is no longer owed.`;
    }
    return {
      id: String(r.id),
      studentId: String(r.studentId),
      studentName: `${str(r.studentFirst) ?? ''} ${str(r.studentLast) ?? ''}`.trim(),
      studentNumber: str(r.studentNumber),
      category,
      categoryLabel: OPENING_BALANCE_CATEGORY_LABELS[category],
      amountKobo: num(r.amountKobo),
      signedAmountKobo: num(r.signedAmountKobo),
      asAt: isoDate(r.asAt),
      termId: str(r.termId),
      termName: str(r.termName),
      sourceNote: String(r.sourceNote ?? ''),
      evidenceRef: str(r.evidenceRef),
      status,
      createdBy: str(r.createdBy),
      reviewedBy: str(r.reviewedBy),
      reviewNote: str(r.reviewNote),
      selfReviewed: Boolean(r.selfReviewed),
      postedInvoiceId: str(r.postedInvoiceId),
      postedInvoiceNumber: str(r.postedInvoiceNumber),
      postedInvoiceStatus: invoiceStatus,
      postedInvoiceTotalKobo: posted ? total : null,
      postedInvoicePaidKobo: posted ? paid : null,
      outstandingKobo: outstanding,
      canPost,
      postBlockedBecause: blocked,
    };
  });
}

export interface ListFilter {
  studentId?: string | null;
  status?: OpeningBalanceStatus | null;
  category?: OpeningBalanceCategory | null;
  limit?: number | null;
}

export async function list(
  db: TenantScopedDb,
  ctx: TenantCtx,
  filter: ListFilter = {},
): Promise<OpeningBalanceView[]> {
  const clauses = [eq(openingBalances.organizationId, ctx.organizationId)];
  if (filter.studentId) clauses.push(eq(openingBalances.studentId, asUUID(filter.studentId)));
  if (filter.status) clauses.push(eq(openingBalances.status, filter.status));
  if (filter.category) clauses.push(eq(openingBalances.category, filter.category));
  return hydrate(db, and(...clauses), filter.limit ?? 200);
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: string,
): Promise<OpeningBalance | null> {
  const rows = await db
    .select()
    .from(openingBalances)
    .where(
      and(
        eq(openingBalances.id, asUUID(id)),
        eq(openingBalances.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getView(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: string,
): Promise<OpeningBalanceView | null> {
  const views = await hydrate(
    db,
    and(eq(openingBalances.organizationId, ctx.organizationId), eq(openingBalances.id, asUUID(id))),
    1,
  );
  return views[0] ?? null;
}

/**
 * The register as the guide reads it. Every money figure is either a recorded
 * claim (per category, never added across categories) or is derived from the
 * ledger (`outstandingKobo`, `collectedAgainstCarryInKobo`) — there is no
 * "total owed" that mixes a credit, an unverified guess and a posted invoice.
 */
export interface OpeningBalanceSummary {
  count: number;
  byCategory: Record<
    OpeningBalanceCategory,
    { count: number; amountKobo: number; signedAmountKobo: number; outstandingKobo: number }
  >;
  /** Approved-but-unposted historical balances — the work still to do. */
  pendingReviewCount: number;
  pendingPostCount: number;
  /**
   * Every APPROVED row, whether or not it can be posted right now. `pendingPostCount`
   * counts only what the ledger could take today, so a school with no past term would
   * otherwise have an approved figure that no consumer can see — and the setup guide
   * would call a register with work outstanding "reviewed and posted". A count that
   * is read-only and derived from status, so it changes no rule.
   */
  approvedNotPostedCount: number;
  /** What is actually owed, taken from the ledger rather than from this register. */
  postedKobo: number;
  outstandingKobo: number;
  /** Money the ledger actually received against live posted carry-ins. */
  collectedAgainstCarryInKobo: number;
  /** A school with no prior term cannot post a carry-in yet; the guide says so. */
  hasPriorTerm: boolean;
  hasCurrentTerm: boolean;
}

const EMPTY_CATEGORY = {
  count: 0,
  amountKobo: 0,
  signedAmountKobo: 0,
  outstandingKobo: 0,
};

export async function summary(db: TenantScopedDb, ctx: TenantCtx): Promise<OpeningBalanceSummary> {
  const rows = await list(db, ctx, { limit: 500 });
  const byCategory = {
    CURRENT_TERM_UNBILLED: { ...EMPTY_CATEGORY },
    HISTORICAL_BALANCE: { ...EMPTY_CATEGORY },
    CREDIT_OVERPAYMENT: { ...EMPTY_CATEGORY },
    UNVERIFIED: { ...EMPTY_CATEGORY },
  };

  let postedKobo = 0;
  let outstandingKobo = 0;
  let collectedKobo = 0;
  let pendingReviewCount = 0;
  let pendingPostCount = 0;
  let approvedNotPostedCount = 0;

  for (const r of rows) {
    const bucket = byCategory[r.category];
    bucket.count += 1;
    bucket.amountKobo += r.amountKobo;
    bucket.signedAmountKobo += r.signedAmountKobo;
    if (r.status === 'DRAFT') pendingReviewCount += 1;
    if (r.status === 'APPROVED') approvedNotPostedCount += 1;
    if (r.canPost) pendingPostCount += 1;
    if (r.status !== 'POSTED' || r.outstandingKobo === null) continue;

    // What is still owed, and what has already been collected against the
    // carry-in, are READ BACK from the posted invoice. UNVERIFIED rows are
    // counted nowhere in the money totals: an unconfirmed number is not a debt,
    // and adding one to what families owe would invent income the ledger does
    // not have.
    if (r.category !== 'UNVERIFIED') {
      bucket.outstandingKobo += r.outstandingKobo ?? 0;
      outstandingKobo += r.outstandingKobo ?? 0;
      postedKobo += r.amountKobo;
      // What has been received against a carry-in is the invoice's own
      // `paid_kobo` — money the allocation triggers put there. It is never
      // inferred from a remainder, and a voided invoice contributes nothing.
      collectedKobo += r.postedInvoicePaidKobo ?? 0;
    }
  }

  const [prior, current] = await Promise.all([priorTerms(db, ctx), currentTerm(db, ctx)]);

  return {
    count: rows.length,
    byCategory,
    pendingReviewCount,
    pendingPostCount,
    approvedNotPostedCount,
    postedKobo,
    outstandingKobo,
    collectedAgainstCarryInKobo: collectedKobo,
    hasPriorTerm: prior.length > 0,
    hasCurrentTerm: current !== null,
  };
}

/**
 * Approve or reject a recorded figure. `reviewed_by` is whoever is acting, and
 * `self_reviewed` is derived by the database from `reviewed_by = created_by`.
 */
export async function review(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: string,
  decision: 'APPROVE' | 'REJECT',
  note?: string | null,
): Promise<OpeningBalance> {
  if (!ctx.userId) {
    throw new RepoInvariantError('A review must be made by a named person.');
  }
  const row = await get(db, ctx, id);
  if (!row) throw new RepoInvariantError('That opening balance was not found in this school.');
  if (row.status !== 'DRAFT' && !(decision === 'REJECT' && row.status === 'APPROVED')) {
    throw new RepoInvariantError(
      `An opening balance that is ${row.status.toLowerCase()} cannot be ${decision === 'APPROVE' ? 'approved' : 'rejected'} — ${decision === 'APPROVE' ? 'only a draft can be approved' : 'correct it by recording a new figure'}.`,
    );
  }
  if (decision === 'REJECT' && !note?.trim()) {
    throw new RepoInvariantError('Rejecting needs a reason, so the next person knows why.');
  }

  const rows = await db
    .update(openingBalances)
    .set({
      status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewedBy: ctx.userId as never,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(openingBalances.id, asUUID(id)),
        eq(openingBalances.organizationId, ctx.organizationId),
      ),
    )
    .returning();
  const updated = rows[0]!;

  await auditRepo.record(db, ctx, {
    action: decision === 'APPROVE' ? 'opening_balance.approve' : 'opening_balance.reject',
    entityType: 'opening_balance',
    entityId: updated.id,
    before: { status: row.status, reviewedBy: row.reviewedBy },
    after: {
      status: updated.status,
      amountKobo: updated.amountKobo,
      category: updated.category,
      reviewNote: updated.reviewNote,
      selfReviewed: updated.selfReviewed,
    },
    reason: note?.trim() || undefined,
  });
  return updated;
}

export interface PostResult {
  balance: OpeningBalance;
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotalKobo: number;
  lineId: string;
  lineAmountKobo: number;
  dueDate: string;
  termId: string;
  termName: string;
}

/**
 * Post an approved historical balance: create a DRAFT invoice on the prior term,
 * add one ad-hoc line for the carried-in amount, issue it, and mark the register
 * row POSTED with the invoice it became.
 *
 * Every write here goes through the SAME repository functions the billing run uses
 * (`invoices.createDraft` → `invoice-lines.addLine` → `invoices.issue`), so the
 * invoice number sequence, `total_kobo`, the status machine and the allocation
 * rules all behave exactly as they do for a normally-billed invoice. Nothing in
 * this function writes `total_kobo`, `paid_kobo` or an allocation.
 *
 * The last UPDATE is where the database gets its chance to refuse: 0052's
 * transition trigger re-checks the invoice's term, due date and student, and the
 * partial unique index refuses a second posted carry-in for the same child on the
 * same term. If either raises, the whole transaction rolls back — there is no
 * state in which the register says POSTED and the invoice does not exist.
 */
export async function post(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: string,
  options: { memo?: string | null } = {},
): Promise<PostResult> {
  if (!ctx.userId) {
    throw new RepoInvariantError(
      'Only a signed-in person may post an opening balance to the ledger.',
    );
  }
  const row = await get(db, ctx, id);
  if (!row) throw new RepoInvariantError('That opening balance was not found in this school.');
  if (row.status !== 'APPROVED') {
    throw new RepoInvariantError(
      row.status === 'DRAFT'
        ? 'This figure has to be approved before it can be posted to the ledger.'
        : `This opening balance is already ${row.status.toLowerCase()}.`,
    );
  }
  if (!categoryIsPostable(row.category as OpeningBalanceCategory)) {
    throw new RepoInvariantError(
      `A ${OPENING_BALANCE_CATEGORY_LABELS[row.category as OpeningBalanceCategory].toLowerCase()} is recorded here but cannot be posted — see the reason in the register.`,
    );
  }
  if (!row.termId) {
    throw new RepoInvariantError(
      'Say which past term this was owed for before posting it, so it lands in the school’s history instead of in the current term.',
    );
  }

  const term = await loadTerm(db, ctx, row.termId);
  const current = await currentTerm(db, ctx);
  if (term.isCurrent) {
    throw new RepoInvariantError(
      `“${term.name}” is the current term, and a carry-in cannot be booked on it.`,
    );
  }
  if (current) {
    if (current.id === term.id) {
      throw new RepoInvariantError(
        `“${term.name}” is the term you are billing. Record this as “${OPENING_BALANCE_CATEGORY_LABELS.CURRENT_TERM_UNBILLED}” and run billing.`,
      );
    }
    if (isoDate(row.asAt) >= isoDate(current.startsOn)) {
      throw new RepoInvariantError(
        `The balance is stated as at ${row.asAt}, which is not before the current term began (${String(current.startsOn)}). Post it against the term it belongs to, or correct the date — otherwise it would be reported as this term’s billing.`,
      );
    }
  }

  const description = `Opening balance carried in (as at ${row.asAt})`;
  const memo =
    options.memo?.trim() || `Opening balance recorded from: ${row.sourceNote}`.slice(0, 500);

  const draft = await invoiceRepo.createDraft(db, ctx, {
    studentId: row.studentId,
    termId: row.termId,
    sessionId: term.sessionId,
    dueDate: row.asAt,
    createdBy: ctx.userId ?? undefined,
    memo,
  } as never);

  const line = await lineRepo.addLine(db, ctx, {
    invoiceId: draft.id,
    description: description.slice(0, 255),
    quantity: 1,
    unitRateKobo: Number(row.amountKobo) as never,
    adjustmentKobo: 0,
    amountKobo: Number(row.amountKobo) as never,
  } as never);

  const issued = await invoiceRepo.issue(db, ctx, draft.id);

  const rows = await db
    .update(openingBalances)
    .set({
      status: 'POSTED',
      postedInvoiceId: issued.id as never,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(openingBalances.id, asUUID(id)),
        eq(openingBalances.organizationId, ctx.organizationId),
      ),
    )
    .returning();
  const postedRow = rows[0];
  if (!postedRow) {
    throw new RepoInvariantError(
      'The invoice was prepared but the register row could not be updated. Nothing has been saved — the whole operation rolled back.',
    );
  }

  await auditRepo.record(db, ctx, {
    action: 'opening_balance.post',
    entityType: 'opening_balance',
    entityId: postedRow.id,
    before: { status: 'APPROVED', postedInvoiceId: null },
    after: {
      status: 'POSTED',
      invoiceId: issued.id,
      invoiceNumber: issued.invoiceNumber,
      amountKobo: postedRow.amountKobo,
      termId: postedRow.termId,
      termName: term.name,
      dueDate: String(issued.dueDate ?? row.asAt),
      selfReviewed: postedRow.selfReviewed,
    },
    reason: 'Carry-in balance posted to the prior term it was owed on.',
  });

  return {
    balance: postedRow,
    invoiceId: issued.id,
    invoiceNumber: issued.invoiceNumber,
    invoiceTotalKobo: Number(issued.totalKobo),
    lineId: line.id,
    lineAmountKobo: Number(line.amountKobo),
    dueDate: String(issued.dueDate ?? row.asAt),
    termId: term.id,
    termName: term.name,
  };
}

/**
 * Undo a posting. The register row is never deleted and the invoice is never
 * erased: the invoice goes through `invoices.voidInvoice` — the same door the
 * invoices surface uses, with the same rules — and the row moves to REVERSED with
 * the reason attached.
 *
 * If the carry-in invoice already has money allocated to it, the ledger refuses
 * the void and this function says so plainly: the payment has to be reversed
 * first. Taking the money off the invoice from here would mean a second code path
 * that can move `paid_kobo`, and there is exactly one of those on purpose.
 */
export async function reverse(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: string,
  reason: string,
): Promise<OpeningBalance> {
  if (!reason.trim()) {
    throw new RepoInvariantError(
      'Reversing a posted opening balance needs a reason on the record.',
    );
  }
  const row = await get(db, ctx, id);
  if (!row) throw new RepoInvariantError('That opening balance was not found in this school.');
  if (row.status !== 'POSTED') {
    throw new RepoInvariantError('Only a posted opening balance can be reversed.');
  }
  const invoiceRows = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      totalKobo: invoices.totalKobo,
      paidKobo: invoices.paidKobo,
    })
    .from(invoices)
    .where(
      and(eq(invoices.id, row.postedInvoiceId!), eq(invoices.organizationId, ctx.organizationId)),
    )
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) {
    throw new RepoInvariantError('The invoice this balance was posted to cannot be found.');
  }
  if (Number(invoice.paidKobo) > 0) {
    throw new RepoInvariantError(
      'A payment has already been applied to this carry-in invoice. Reverse the payment first — opening balances do not move money, the ledger does.',
    );
  }

  await invoiceRepo.voidInvoice(db, ctx, invoice.id, `Opening balance reversed: ${reason.trim()}`);

  const rows = await db
    .update(openingBalances)
    .set({
      status: 'REVERSED',
      reversalReason: reason.trim(),
      reversedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(openingBalances.id, asUUID(id)),
        eq(openingBalances.organizationId, ctx.organizationId),
      ),
    )
    .returning();
  const updated = rows[0]!;

  await auditRepo.record(db, ctx, {
    action: 'opening_balance.reverse',
    entityType: 'opening_balance',
    entityId: updated.id,
    before: { status: 'POSTED', invoiceId: invoice.id },
    after: { status: 'REVERSED', invoiceId: invoice.id, invoiceStatus: 'VOID' },
    reason: reason.trim(),
  });
  return updated;
}

/**
 * The student-page read: what a child carried in, and what of it is still owed.
 * Kept separate from `list` so a future surface cannot accidentally pull the
 * whole register.
 */
export async function listForStudent(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: string,
): Promise<OpeningBalanceView[]> {
  return list(db, ctx, { studentId, limit: 50 });
}

/** Used by the tests and the guide: does anything in the register still need a decision? */
export async function countNeedingAttention(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<{ drafts: number; approvedUnposted: number }> {
  const rows = (await db
    .select({
      drafts: sql<number>`count(*) filter (where ${openingBalances.status} = 'DRAFT')::int`,
      approvedUnposted: sql<number>`count(*) filter (where ${openingBalances.status} = 'APPROVED')::int`,
    })
    .from(openingBalances)
    .where(eq(openingBalances.organizationId, ctx.organizationId))) as unknown as Array<
    Record<string, unknown>
  >;
  return {
    drafts: num(rows[0]?.drafts),
    approvedUnposted: num(rows[0]?.approvedUnposted),
  };
}
