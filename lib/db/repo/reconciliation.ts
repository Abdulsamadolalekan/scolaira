import { and, desc, eq, sql } from 'drizzle-orm';
import { AuthzError, AuthzErrorCode } from '@/lib/authz';
import { reconciliationCandidates, reconciliationCases, reconciliationEvidence } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type ReconciliationState = 'UNMATCHED' | 'FLAGGED' | 'RECONCILED' | 'ALLOCATED';
export type ReconciliationCaseKind =
  | 'TO_CONFIRM'
  | 'TO_MATCH'
  | 'TO_ALLOCATE'
  | 'DUPLICATE_REVIEW'
  | 'FLAGGED_EXCEPTION'
  | 'LATE_EVENT';
export type ReconciliationEvidenceKind =
  'BANK_REFERENCE' | 'CASH_RECEIPT' | 'POS_SLIP' | 'OPERATOR_NOTE' | 'PROVIDER_EVENT';
export type ReconciliationCandidateState = 'PROPOSED' | 'ACCEPTED' | 'REJECTED';

export type ReconciliationCase = typeof reconciliationCases.$inferSelect;
export type ReconciliationEvidence = typeof reconciliationEvidence.$inferSelect;
export type ReconciliationCandidate = typeof reconciliationCandidates.$inferSelect;

export interface QueueRow {
  caseId: string | null;
  paymentId: string;
  organizationId: string;
  caseKind: ReconciliationCaseKind;
  state: ReconciliationState;
  reason: string | null;
  paymentNumber: string;
  paymentStatus: string;
  method: string;
  amountKobo: number;
  unallocatedKobo: number;
  reference: string | null;
  payerName: string | null;
  paidAt: string | null;
  createdAt: string;
  studentName: string | null;
  invoiceNumber: string | null;
  activeAllocationCount: number;
  evidenceCount: number;
  assignedTo: string | null;
}

function encodeCursor(createdAt: string, paymentId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, paymentId }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null): { createdAt: string; paymentId: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      paymentId?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.paymentId !== 'string') return null;
    return { createdAt: parsed.createdAt, paymentId: parsed.paymentId };
  } catch {
    return null;
  }
}

export function derivedKind(
  paymentStatus: string,
  unallocatedKobo: number,
): ReconciliationCaseKind {
  if (paymentStatus === 'DUPLICATE_SUSPECT') return 'DUPLICATE_REVIEW';
  if (paymentStatus === 'PENDING') return 'TO_CONFIRM';
  return unallocatedKobo > 0 ? 'TO_MATCH' : 'TO_ALLOCATE';
}

export async function getOpenCaseForPayment(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<ReconciliationCase | null> {
  const rows = await db
    .select()
    .from(reconciliationCases)
    .where(
      and(
        eq(reconciliationCases.organizationId, ctx.organizationId),
        eq(reconciliationCases.paymentId, paymentId),
        sql`${reconciliationCases.closedAt} is null`,
      ),
    )
    .orderBy(desc(reconciliationCases.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureOpenCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    paymentId: UUID;
    kind: ReconciliationCaseKind;
    state?: ReconciliationState;
    reason?: string | null;
  },
): Promise<ReconciliationCase> {
  const existing = await getOpenCaseForPayment(db, ctx, input.paymentId);
  if (existing) return existing;
  try {
    const rows = await db
      .insert(reconciliationCases)
      .values({
        organizationId: ctx.organizationId,
        paymentId: input.paymentId,
        kind: input.kind,
        state: input.state ?? 'UNMATCHED',
        reason: input.reason ?? null,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing({
        target: reconciliationCases.paymentId,
        where: sql`${reconciliationCases.paymentId} is not null and ${reconciliationCases.closedAt} is null`,
      })
      .returning();
    if (rows[0]) return rows[0];
    const raced = await getOpenCaseForPayment(db, ctx, input.paymentId);
    if (raced) return raced;
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'The payment case changed; refresh and retry.',
      409,
    );
  } catch (error: any) {
    if (error?.code === '23505' || error?.cause?.code === '23505') {
      const raced = await getOpenCaseForPayment(db, ctx, input.paymentId);
      if (raced) return raced;
    }
    throw error;
  }
}

export async function listEvidence(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<ReconciliationEvidence[]> {
  return db
    .select()
    .from(reconciliationEvidence)
    .where(
      and(
        eq(reconciliationEvidence.organizationId, ctx.organizationId),
        eq(reconciliationEvidence.caseId, caseId),
      ),
    )
    .orderBy(desc(reconciliationEvidence.createdAt));
}

export async function listCandidates(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<ReconciliationCandidate[]> {
  return db
    .select()
    .from(reconciliationCandidates)
    .where(
      and(
        eq(reconciliationCandidates.organizationId, ctx.organizationId),
        eq(reconciliationCandidates.caseId, caseId),
      ),
    )
    .orderBy(desc(reconciliationCandidates.createdAt));
}

export async function listQueue(
  db: TenantScopedDb,
  ctx: TenantCtx,
  filters: {
    state?: ReconciliationState;
    kind?: ReconciliationCaseKind;
    paymentStatus?: string;
    unallocatedOnly?: boolean;
    limit?: number;
    cursor?: string | null;
  } = {},
): Promise<{ rows: QueueRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const cursor = decodeCursor(filters.cursor ?? null);
  const conditions = [sql`q.organization_id = ${ctx.organizationId}::uuid`];
  if (filters.state) conditions.push(sql`q.state = ${filters.state}`);
  if (filters.kind) conditions.push(sql`q.case_kind = ${filters.kind}`);
  if (filters.paymentStatus) conditions.push(sql`q.payment_status = ${filters.paymentStatus}`);
  if (filters.unallocatedOnly) conditions.push(sql`q.unallocated_kobo > 0`);
  if (cursor) {
    conditions.push(
      sql`(q.created_at < ${cursor.createdAt}::timestamptz OR (q.created_at = ${cursor.createdAt}::timestamptz AND q.payment_id < ${cursor.paymentId}::uuid))`,
    );
  }

  const rows = (await db.execute(sql`
    WITH explicit_queue AS (
      SELECT
        c.id AS case_id,
        c.payment_id,
        c.organization_id,
        c.kind AS case_kind,
        c.state,
        c.reason,
        c.assigned_to,
        c.created_at,
        p.payment_number,
        p.status AS payment_status,
        p.method,
        p.amount_kobo,
        p.unallocated_kobo,
        p.reference,
        p.payer_name,
        p.paid_at,
        COALESCE(alloc.active_count, 0)::int AS active_allocation_count,
        COALESCE(ev.evidence_count, 0)::int AS evidence_count,
        alloc.student_name,
        alloc.invoice_number
      FROM reconciliation_cases c
      JOIN payments p ON p.id = c.payment_id AND p.organization_id = c.organization_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE pa.status = 'ACTIVE') AS active_count,
          (array_agg(trim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')) ORDER BY pa.allocated_at DESC))[1] AS student_name,
          (array_agg(i.invoice_number ORDER BY pa.allocated_at DESC))[1] AS invoice_number
        FROM payment_allocations pa
        JOIN invoices i ON i.id = pa.invoice_id
        JOIN students s ON s.id = i.student_id
        WHERE pa.payment_id = p.id
      ) alloc ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS evidence_count
          FROM reconciliation_evidence e
         WHERE e.case_id = c.id
      ) ev ON true
      WHERE c.organization_id = ${ctx.organizationId}::uuid
        AND c.closed_at IS NULL
    ),
    derived_queue AS (
      SELECT
        NULL::uuid AS case_id,
        p.id AS payment_id,
        p.organization_id,
        CASE WHEN p.status = 'DUPLICATE_SUSPECT' THEN 'DUPLICATE_REVIEW'
             WHEN p.status = 'PENDING' THEN 'TO_CONFIRM'
             ELSE 'TO_MATCH' END AS case_kind,
        'UNMATCHED' AS state,
        'Derived from the current payment state; open a case to record a decision.' AS reason,
        NULL::uuid AS assigned_to,
        p.created_at,
        p.payment_number,
        p.status AS payment_status,
        p.method,
        p.amount_kobo,
        p.unallocated_kobo,
        p.reference,
        p.payer_name,
        p.paid_at,
        COALESCE(alloc.active_count, 0)::int AS active_allocation_count,
        0::int AS evidence_count,
        alloc.student_name,
        alloc.invoice_number
      FROM payments p
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE pa.status = 'ACTIVE') AS active_count,
          (array_agg(trim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')) ORDER BY pa.allocated_at DESC))[1] AS student_name,
          (array_agg(i.invoice_number ORDER BY pa.allocated_at DESC))[1] AS invoice_number
        FROM payment_allocations pa
        JOIN invoices i ON i.id = pa.invoice_id
        JOIN students s ON s.id = i.student_id
        WHERE pa.payment_id = p.id
      ) alloc ON true
      WHERE p.organization_id = ${ctx.organizationId}::uuid
        AND (
          p.status IN ('PENDING', 'DUPLICATE_SUSPECT')
          OR (p.status = 'CONFIRMED' AND p.unallocated_kobo > 0)
        )
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_cases c
           WHERE c.payment_id = p.id
             AND c.organization_id = p.organization_id
             AND c.closed_at IS NULL
        )
    ),
    queue AS (
      SELECT * FROM explicit_queue
      UNION ALL
      SELECT * FROM derived_queue
    )
    SELECT * FROM queue q
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY q.created_at DESC, q.payment_id DESC
     LIMIT ${limit + 1}
  `)) as unknown as Array<Record<string, unknown>>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const mapped = page.map((r) => ({
    caseId: (r.case_id as string | null) ?? null,
    paymentId: String(r.payment_id),
    organizationId: String(r.organization_id),
    caseKind: r.case_kind as ReconciliationCaseKind,
    state: r.state as ReconciliationState,
    reason: (r.reason as string | null) ?? null,
    paymentNumber: String(r.payment_number),
    paymentStatus: String(r.payment_status),
    method: String(r.method),
    amountKobo: Number(r.amount_kobo),
    unallocatedKobo: Number(r.unallocated_kobo),
    reference: (r.reference as string | null) ?? null,
    payerName: (r.payer_name as string | null) ?? null,
    paidAt: r.paid_at ? new Date(String(r.paid_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    studentName: (r.student_name as string | null) ?? null,
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    activeAllocationCount: Number(r.active_allocation_count),
    evidenceCount: Number(r.evidence_count),
    assignedTo: (r.assigned_to as string | null) ?? null,
  }));
  const last = mapped.at(-1);
  return {
    rows: mapped,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.paymentId) : null,
  };
}
