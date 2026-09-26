/**
 * H-2 — the aggregate boundary.
 *
 * Every headline figure on every surface is produced here from ONE source: the
 * `auth_invoice_scope_buckets` / `auth_period_valuation` SQL functions, which
 * classify each invoice once into an exhaustive three-way partition
 *
 *   CURRENT_TERM  billed by the active term
 *   PRIOR_TERM    an earlier term, already due when the active term began
 *   OTHER_TERM    an earlier term not yet due at the cut-over (and everything
 *                 when no term is active, because no cut-over exists)
 *
 * The contract the H-2 reconciliation tests enforce is structural:
 * `sum(CURRENT_TERM, PRIOR_TERM, OTHER_TERM) === ALL_TERM`, for every figure,
 * for every tenant. A headline that disagrees with the classified buckets is a
 * bug by construction, not a judgement call.
 *
 * These functions are SECURITY INVOKER: RLS still applies, and the tenant GUC
 * still decides what is visible.
 */
import { sql } from 'drizzle-orm';
import type { TenantScopedDb, TenantCtx, UUID } from './_context';
import type { InvoiceScope } from './scoping';

export type BucketKey = 'CURRENT_TERM' | 'PRIOR_TERM' | 'OTHER_TERM';

export const BUCKET_KEYS: readonly BucketKey[] = ['CURRENT_TERM', 'PRIOR_TERM', 'OTHER_TERM'];

export const BUCKET_LABELS: Record<BucketKey, string> = {
  CURRENT_TERM: 'This term',
  PRIOR_TERM: 'Prior-term debt (due before the current term began)',
  OTHER_TERM: 'Other terms (not yet due at the cut-over)',
};

export interface ScopeBucket {
  bucket: BucketKey;
  invoiceCount: number;
  billedKobo: number;
  collectedKobo: number;
  outstandingKobo: number;
  overdueKobo: number;
  draftCount: number;
}

export interface PeriodValuationRow extends Omit<ScopeBucket, 'bucket'> {
  bucket: BucketKey | 'ALL_TERM';
  paymentsReceivedKobo: number;
  paymentsUnallocatedKobo: number;
  paymentsPendingCount: number;
  paymentsDuplicateCount: number;
  unallocatedConfirmedCount: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const EMPTY: Omit<ScopeBucket, 'bucket'> = {
  invoiceCount: 0,
  billedKobo: 0,
  collectedKobo: 0,
  outstandingKobo: 0,
  overdueKobo: 0,
  draftCount: 0,
};

/**
 * Classify and aggregate the book. `cutoverOn` is the active term's starts_on;
 * pass null when no term is active (then everything is OTHER_TERM and a
 * TERM-scoped headline is legitimately zero).
 */
export async function invoiceBuckets(
  db: TenantScopedDb,
  ctx: TenantCtx,
  term: { id: UUID | null; startsOn: string | null },
): Promise<ScopeBucket[]> {
  void ctx; // tenant is carried by the RLS GUC the route established
  const rows = (await db.execute(sql`
    SELECT bucket, invoice_count, billed_kobo, collected_kobo, outstanding_kobo, overdue_kobo, draft_count
      FROM auth_invoice_scope_buckets(${term.id}::uuid, ${term.startsOn}::date)
  `)) as unknown as Array<Record<string, unknown>>;

  const byKey = new Map<BucketKey, ScopeBucket>();
  for (const r of rows ?? []) {
    const bucket = String(r.bucket) as BucketKey;
    byKey.set(bucket, {
      bucket,
      invoiceCount: num(r.invoice_count),
      billedKobo: num(r.billed_kobo),
      collectedKobo: num(r.collected_kobo),
      outstandingKobo: num(r.outstanding_kobo),
      overdueKobo: num(r.overdue_kobo),
      draftCount: num(r.draft_count),
    });
  }
  // Always return all three buckets, in a stable order: a surface that renders
  // a partition must never have to guess whether an absent bucket means zero.
  return BUCKET_KEYS.map((k) => byKey.get(k) ?? { bucket: k, ...EMPTY });
}

/** Sum a set of buckets — the tie-back every headline is computed with. */
export function sumBuckets(buckets: ScopeBucket[], keys: readonly BucketKey[] = BUCKET_KEYS): Omit<ScopeBucket, 'bucket'> {
  const total = { ...EMPTY };
  for (const b of buckets) {
    if (!keys.includes(b.bucket)) continue;
    total.invoiceCount += b.invoiceCount;
    total.billedKobo += b.billedKobo;
    total.collectedKobo += b.collectedKobo;
    total.outstandingKobo += b.outstandingKobo;
    total.overdueKobo += b.overdueKobo;
    total.draftCount += b.draftCount;
  }
  return total;
}

/**
 * Headline figures for a declared scope. `ALL_TERM` is the full partition sum;
 * `TERM` is the CURRENT_TERM bucket alone. Both come from the same classified
 * rows, so they cannot drift.
 */
export function headlineForScope(
  buckets: ScopeBucket[],
  scope: InvoiceScope,
): { scope: InvoiceScope; current: ScopeBucket; totals: Omit<ScopeBucket, 'bucket'> } {
  const current =
    buckets.find((b) => b.bucket === 'CURRENT_TERM') ?? { bucket: 'CURRENT_TERM' as BucketKey, ...EMPTY };
  return {
    scope,
    current,
    totals: scope === 'TERM' ? sumBuckets([current]) : sumBuckets(buckets),
  };
}

/** The as-of valuation of a financial period (see migration 0048 §4). */
export async function periodValuation(
  db: TenantScopedDb,
  ctx: TenantCtx,
  periodId: UUID,
): Promise<{ buckets: PeriodValuationRow[]; allTerm: PeriodValuationRow }> {
  void ctx;
  const rows = (await db.execute(sql`
    SELECT bucket, invoice_count, billed_kobo, collected_kobo, outstanding_kobo, overdue_kobo,
           payments_received_kobo, payments_unallocated_kobo, payments_pending_count,
           payments_duplicate_count, unallocated_confirmed_count
      FROM auth_period_valuation(${periodId}::uuid)
  `)) as unknown as Array<Record<string, unknown>>;

  const mapped: PeriodValuationRow[] = (rows ?? []).map((r) => ({
    bucket: String(r.bucket) as BucketKey | 'ALL_TERM',
    invoiceCount: num(r.invoice_count),
    billedKobo: num(r.billed_kobo),
    collectedKobo: num(r.collected_kobo),
    outstandingKobo: num(r.outstanding_kobo),
    overdueKobo: num(r.overdue_kobo),
    draftCount: 0,
    paymentsReceivedKobo: num(r.payments_received_kobo),
    paymentsUnallocatedKobo: num(r.payments_unallocated_kobo),
    paymentsPendingCount: num(r.payments_pending_count),
    paymentsDuplicateCount: num(r.payments_duplicate_count),
    unallocatedConfirmedCount: num(r.unallocated_confirmed_count),
  }));

  const empty: PeriodValuationRow = {
    bucket: 'ALL_TERM',
    ...EMPTY,
    paymentsReceivedKobo: 0,
    paymentsUnallocatedKobo: 0,
    paymentsPendingCount: 0,
    paymentsDuplicateCount: 0,
    unallocatedConfirmedCount: 0,
  };
  const allTerm = mapped.find((r) => r.bucket === 'ALL_TERM') ?? empty;
  return { buckets: mapped.filter((r) => r.bucket !== 'ALL_TERM'), allTerm };
}

/**
 * The invoice register's headline strip: counted from source rows with the SAME
 * filters the list uses, never by summing the returned page (measured defect:
 * a >200-row tenant's strip under-reported by 15,050,000 kobo).
 */
export interface RegisterTotals {
  total: number;
  billedKobo: number;
  collectedKobo: number;
  outstandingKobo: number;
  overdueKobo: number;
  draftCount: number;
}

export async function invoiceRegisterTotals(
  db: TenantScopedDb,
  ctx: TenantCtx,
  filters: { status?: string | null } = {},
): Promise<RegisterTotals> {
  void ctx;
  const status = filters.status ?? null;
  const rows = (await db.execute(sql`
    SELECT
      count(*)::int AS total,
      coalesce(sum(i.total_kobo) FILTER (WHERE i.status <> 'VOID'), 0)::bigint AS billed_kobo,
      coalesce(sum(coalesce(a.collected, 0))
               FILTER (WHERE i.status IN ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint AS collected_kobo,
      coalesce(sum(i.total_kobo - i.paid_kobo)
               FILTER (WHERE i.status IN ('ISSUED','PARTIALLY_PAID')), 0)::bigint AS outstanding_kobo,
      coalesce(sum(i.total_kobo - i.paid_kobo)
               FILTER (WHERE i.status IN ('ISSUED','PARTIALLY_PAID')
                         AND i.due_date IS NOT NULL AND i.due_date < current_date), 0)::bigint AS overdue_kobo,
      count(*) FILTER (WHERE i.status = 'DRAFT')::int AS draft_count
    FROM invoices i
    LEFT JOIN (
      SELECT pa.invoice_id, sum(pa.amount_kobo) AS collected
        FROM payment_allocations pa
        JOIN payments p ON p.id = pa.payment_id AND p.organization_id = pa.organization_id
       WHERE pa.organization_id = current_setting('app.organization_id')::uuid
         AND pa.status = 'ACTIVE'
         AND p.status = 'CONFIRMED'
       GROUP BY pa.invoice_id
    ) a ON a.invoice_id = i.id
    WHERE i.organization_id = current_setting('app.organization_id')::uuid
      AND (${status}::text IS NULL OR i.status::text = ${status}::text)
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows?.[0] ?? {};
  return {
    total: num(r.total),
    billedKobo: num(r.billed_kobo),
    collectedKobo: num(r.collected_kobo),
    outstandingKobo: num(r.outstanding_kobo),
    overdueKobo: num(r.overdue_kobo),
    draftCount: num(r.draft_count),
  };
}

/**
 * The same classification as `auth_invoice_scope_buckets`, evaluated in
 * TypeScript for a single row (registers mark rows without a second query).
 * The H-2 contract tests assert that this agrees with the SQL function on real
 * data — one definition, two evaluation sites, no drift.
 */
/**
 * Normalise a day-valued input to `YYYY-MM-DD`, or null when it is not a day.
 *
 * The classifier compares dates as strings, so a display-formatted date ("28 Nov
 * 2025") compares as text and silently lands in the wrong bucket — the register
 * shipped that way and labelled carried-forward arrears as "Other terms". Every
 * comparison therefore goes through this normaliser, and an unparseable value
 * is null (unknown) rather than a guess.
 */
export function toIsoDay(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function classifyInvoiceScope(
  invoice: { termId: string | null; dueDate: Date | string | null },
  cutover: { termId: string | null; cutoverOn: Date | string | null },
): BucketKey {
  if (cutover.termId && invoice.termId === cutover.termId) return 'CURRENT_TERM';
  const dueDate = toIsoDay(invoice.dueDate);
  const cutoverOn = toIsoDay(cutover.cutoverOn);
  if (cutover.termId && cutoverOn && dueDate && dueDate < cutoverOn) {
    return 'PRIOR_TERM';
  }
  return 'OTHER_TERM';
}
