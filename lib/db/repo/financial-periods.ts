/**
 * H-2 — financial periods: the term-boundary control surface.
 *
 * Measured gap: nothing in the product used a term's `starts_on` as a cut-over,
 * and there was no way to freeze a window. A period is a bounded,
 * non-overlapping window; closing it is refused while the window still holds
 * unresolved money (PENDING / DUPLICATE_SUSPECT payments) or unapplied
 * confirmed money (allocatable credit), so a close can never launder work into
 * the next period.
 *
 * The valuation is derived from ledger timestamps (invoice issue date,
 * allocation time, payment creation), not from a stored snapshot: the report
 * for a CLOSED window therefore does not move when later money arrives, which
 * is exactly what makes it usable as boundary evidence.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { financialPeriods } from '@/lib/db/schema/platform';
import { periodValuation, type PeriodValuationRow } from './aggregates';
import type { TenantScopedDb, TenantCtx, UUID } from './_context';

export type PeriodStatus = 'OPEN' | 'CLOSED';

export interface FinancialPeriod {
  id: UUID;
  name: string;
  startsOn: string;
  endsOn: string;
  status: PeriodStatus;
  createdAt: string;
  createdBy: UUID | null;
  closedAt: string | null;
  closedBy: UUID | null;
}

/** The window holds payments that have not been resolved yet. */
export class PeriodCloseBlockedError extends Error {
  readonly code: 'PERIOD_HAS_UNRESOLVED_PAYMENTS' | 'PERIOD_HAS_UNALLOCATED_PAYMENTS';
  readonly details: Record<string, number>;
  constructor(
    code: PeriodCloseBlockedError['code'],
    message: string,
    details: Record<string, number>,
  ) {
    super(message);
    this.name = 'PeriodCloseBlockedError';
    this.code = code;
    this.details = details;
  }
}

/** Two periods may not claim the same day (enforced again by a DB trigger). */
export class PeriodOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodOverlapError';
  }
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function serialise(row: typeof financialPeriods.$inferSelect): FinancialPeriod {
  return {
    id: row.id as UUID,
    name: row.name,
    startsOn: String(row.startsOn),
    endsOn: String(row.endsOn),
    status: row.closedAt ? 'CLOSED' : 'OPEN',
    createdAt: iso(row.createdAt)!,
    createdBy: (row.createdBy as UUID | null) ?? null,
    closedAt: iso(row.closedAt),
    closedBy: (row.closedBy as UUID | null) ?? null,
  };
}

export async function listPeriods(
  db: TenantScopedDb,
  ctx: TenantCtx,
  limit = 50,
): Promise<FinancialPeriod[]> {
  const rows = await db
    .select()
    .from(financialPeriods)
    .where(eq(financialPeriods.organizationId, ctx.organizationId))
    .orderBy(desc(financialPeriods.endsOn), desc(financialPeriods.createdAt))
    .limit(limit);
  return rows.map(serialise);
}

export async function countPeriods(db: TenantScopedDb, ctx: TenantCtx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(financialPeriods)
    .where(eq(financialPeriods.organizationId, ctx.organizationId));
  return Number(rows[0]?.n ?? 0);
}

export async function getPeriod(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FinancialPeriod | null> {
  const rows = await db
    .select()
    .from(financialPeriods)
    .where(and(eq(financialPeriods.organizationId, ctx.organizationId), eq(financialPeriods.id, id)))
    .limit(1);
  return rows[0] ? serialise(rows[0]) : null;
}

export async function createPeriod(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: { name: string; startsOn: string; endsOn: string },
): Promise<FinancialPeriod> {
  try {
    const rows = await db
      .insert(financialPeriods)
      .values({
        organizationId: ctx.organizationId,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        createdBy: ctx.userId,
      })
      .returning();
    return serialise(rows[0]!);
  } catch (e: any) {
    // 23P01 = exclusion_violation, raised by trg_financial_period_no_overlap.
    // The driver error arrives wrapped (DrizzleQueryError), so the SQLSTATE and
    // the trigger's message live on the cause chain — reading only the top-level
    // error turned a correct database refusal into a 500.
    const chain: any[] = [];
    for (let cur: any = e; cur && chain.length < 5; cur = cur.cause) chain.push(cur);
    const pg = chain.find((c) => typeof c?.code === 'string');
    if (pg?.code === '23P01') {
      const detail = chain
        .map((c) => (typeof c?.message === 'string' ? c.message : ''))
        .find((m) => /overlap/i.test(m));
      throw new PeriodOverlapError(detail ?? 'Periods overlap');
    }
    throw e;
  }
}

export interface CloseResult {
  period: FinancialPeriod;
  valuation: { buckets: PeriodValuationRow[]; allTerm: PeriodValuationRow };
  alreadyClosed: boolean;
}

/**
 * Close a period. Refuses while the window holds unresolved or unapplied money.
 * The precondition read and the state transition share one transaction and the
 * period row is locked, so a payment cannot slip in between the check and the
 * close.
 */
export async function closePeriod(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<CloseResult | null> {
  const locked = await db
    .select()
    .from(financialPeriods)
    .where(and(eq(financialPeriods.organizationId, ctx.organizationId), eq(financialPeriods.id, id)))
    .limit(1)
    .for('update');
  if (!locked[0]) return null;

  const period = serialise(locked[0]);
  const valuation = await periodValuation(db, ctx, id);

  if (period.status === 'CLOSED') {
    // Idempotent by design: closing a closed period reports the frozen state
    // rather than mutating or erroring.
    return { period, valuation, alreadyClosed: true };
  }

  const { paymentsPendingCount, paymentsDuplicateCount, unallocatedConfirmedCount, paymentsUnallocatedKobo } =
    valuation.allTerm;
  if (paymentsPendingCount > 0 || paymentsDuplicateCount > 0) {
    throw new PeriodCloseBlockedError(
      'PERIOD_HAS_UNRESOLVED_PAYMENTS',
      'This period still holds payments awaiting confirmation or duplicate review.',
      { pendingCount: paymentsPendingCount, duplicateSuspectCount: paymentsDuplicateCount },
    );
  }
  if (unallocatedConfirmedCount > 0) {
    throw new PeriodCloseBlockedError(
      'PERIOD_HAS_UNALLOCATED_PAYMENTS',
      'This period still holds confirmed money that has not been applied to an invoice.',
      { unallocatedCount: unallocatedConfirmedCount, unallocatedKobo: paymentsUnallocatedKobo },
    );
  }

  const updated = await db
    .update(financialPeriods)
    .set({ closedAt: sql`now()`, closedBy: ctx.userId })
    .where(and(eq(financialPeriods.organizationId, ctx.organizationId), eq(financialPeriods.id, id)))
    .returning();

  return { period: serialise(updated[0]!), valuation, alreadyClosed: false };
}

/** The audit detail written when a period closes: flat, bounded, no rows. */
export function closeAuditDetail(result: CloseResult) {
  const { allTerm } = result.valuation;
  return {
    periodId: result.period.id,
    startsOn: result.period.startsOn,
    endsOn: result.period.endsOn,
    invoiceCount: allTerm.invoiceCount,
    billedKobo: allTerm.billedKobo,
    collectedKobo: allTerm.collectedKobo,
    outstandingKobo: allTerm.outstandingKobo,
  };
}
