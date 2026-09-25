/**
 * Invoices repository.
 *
 * FINANCIAL BOUNDARY (from M2 architecture):
 *   - total_kobo / paid_kobo are maintained by database triggers; repo code
 *     NEVER writes those columns directly.
 *   - Invoices are created as DRAFT; lines are added/removed only while DRAFT
 *     (enforced by trg_invoice_lines_change). Status is transitioned by
 *     explicit UPDATE (e.g. issue, void); invalid transitions raise
 *     check_violation from trg_enforce_status_transitions.
 *   - Allocation/unallocation happen via the payment_allocations / reversals
 *     repos, which write their own rows; the resulting invoice status is
 *     recomputed by trg_allocations_insert / trg_reversals_insert.
 */
import { eq, and } from 'drizzle-orm';
import { invoices } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = Omit<
  typeof invoices.$inferInsert,
  'organizationId' | 'status' | 'totalKobo' | 'paidKobo' | 'invoiceNumber'
> & {
  // Invoices are always inserted DRAFT; status transitions are explicit.
  status?: 'DRAFT';
};

/**
 * Create a new DRAFT invoice. The BEFORE INSERT trigger assigns an invoice
 * number (e.g. INV-2026-000001) and sets timestamps.
 */
export async function createDraft(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: NewInvoice,
): Promise<Invoice> {
  if (input.status && input.status !== 'DRAFT') {
    throw new RepoInvariantError(
      `invoices.createDraft must create DRAFT invoices; got status=${input.status}`,
    );
  }
  const rows = await db
    .insert(invoices)
    .values({
      ...input,
      organizationId: ctx.organizationId,
      createdBy: input.createdBy ?? ctx.userId ?? undefined,
      status: 'DRAFT',
      // Explicitly omit total_kobo / paid_kobo / invoice_number so defaults
      // and triggers populate them.
      totalKobo: undefined,
      paidKobo: undefined,
      invoiceNumber: undefined,
    } as unknown as typeof invoices.$inferInsert)
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Invoice | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrThrow(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Invoice> {
  const row = await get(db, ctx, id);
  if (!row) throw new RepoInvariantError(`Invoice ${id} not found in tenant ${ctx.organizationId}`);
  return row;
}

/**
 * Issue a DRAFT invoice (transition DRAFT → ISSUED).
 * trg_set_status_timestamps sets issued_at and trg_enforce_status_transitions
 * rejects any transition outside the whitelist.
 */
/**
 * Coerce a Date to a yyyy-mm-dd string for drizzle date columns (mode: 'date'
 * stores as Postgres DATE). Strings pass through unchanged.
 */
function toDateString(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}

export async function issue(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  input: { dueDate?: Date | string; issueDate?: Date | string; memo?: string } = {},
): Promise<Invoice> {
  const rows = await db
    .update(invoices)
    .set({
      status: 'ISSUED',
      ...(input.dueDate !== undefined ? { dueDate: toDateString(input.dueDate) } : {}),
      ...(input.issueDate !== undefined ? { issueDate: toDateString(input.issueDate) } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    })
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, ctx.organizationId)))
    .returning();
  const row = rows[0];
  if (!row) throw new RepoInvariantError(`Invoice ${id} not found`);
  return row;
}

/**
 * Void an invoice. Requires the invoice to be in a voidable state; the
 * database enforces this (DRAFT/ISSUED/PARTIALLY_PAID are voidable, VOID is
 * terminal). Caller must first reverse allocations for paid invoices via the
 * reversals repo; M2 partial-void semantics are not supported (see architecture
 * report §3 N6).
 */
export async function voidInvoice(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  reason: string,
): Promise<Invoice> {
  if (!reason.trim()) {
    throw new RepoInvariantError('voidInvoice requires a non-empty reason');
  }
  const rows = await db
    .update(invoices)
    .set({
      status: 'VOID',
      voidedReason: reason,
      voidedBy: ctx.userId ?? undefined,
    })
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, ctx.organizationId)))
    .returning();
  const row = rows[0];
  if (!row) throw new RepoInvariantError(`Invoice ${id} not found`);
  return row;
}

export async function listForStudent(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: UUID,
): Promise<Invoice[]> {
  return db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, ctx.organizationId),
        eq(invoices.studentId, studentId),
      ),
    );
}

export async function listOutstanding(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<Invoice[]> {
  // An invoice is outstanding when status is ISSUED or PARTIALLY_PAID.
  // Use RLS; no global filter needed.
  return db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, ctx.organizationId),
      ),
    )
    .then((rows) => rows.filter((r) => r.status === 'ISSUED' || r.status === 'PARTIALLY_PAID'));
}
