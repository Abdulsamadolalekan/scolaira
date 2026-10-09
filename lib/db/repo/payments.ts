/**
 * Payments repository.
 *
 * FINANCIAL BOUNDARY:
 *   - Insert a payment in PENDING, then confirm to transition PENDING → CONFIRMED.
 *     On first transition into CONFIRMED, trg_set_status_timestamps seeds
 *     unallocated_kobo = amount_kobo exactly once (not on every UPDATE).
 *   - unallocated_kobo is maintained by allocations/reversals triggers — repo
 *     code never writes it.
 *   - Reference duplication guard is enforced by a partial unique index /
 *     trigger (payments_reference_guard) — duplicate CONFIRMED payments with
 *     the same org+method+reference raise.
 */
import { eq, and } from 'drizzle-orm';
import { payments } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';
import type { Kobo } from '@/lib/money';
import type { paymentMethodEnum, paymentStatusEnum } from '../schema/enums';

export type Payment = typeof payments.$inferSelect;

export interface RecordPaymentInput {
  method: (typeof paymentMethodEnum.enumValues)[number];
  amountKobo: Kobo;
  reference?: string;
  payerName?: string;
  payerPhone?: string;
  payerEmail?: string;
  paidAt?: Date;
  notes?: string;
  /** Initial status: defaults to CONFIRMED for cash/bank/POS/online (the common
   *  "bursar records a payment" path); pass PENDING for deferred confirmation
   *  (e.g. bank transfer pending matching). */
  initialStatus?: (typeof paymentStatusEnum.enumValues)[number];
}

/**
 * Record a payment. Defaults to CONFIRMED (the common "bursar enters cash"
 * path). For PENDING payments, call `confirm()` separately.
 */
export async function record(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: RecordPaymentInput,
): Promise<Payment> {
  if (input.amountKobo < 0) {
    throw new RepoInvariantError(`Payment amount_kobo must be non-negative; got ${input.amountKobo}`);
  }
  const status = input.initialStatus ?? 'CONFIRMED';
  const rows = await db
    .insert(payments)
    .values({
      organizationId: ctx.organizationId,
      method: input.method,
      status,
      amountKobo: input.amountKobo,
      // For CONFIRMED, trigger seeds unallocatedKobo = amountKobo. We pass
      // undefined so defaults/trigger win.
      unallocatedKobo: undefined,
      reference: input.reference ?? null,
      payerName: input.payerName ?? null,
      payerPhone: input.payerPhone ?? null,
      payerEmail: input.payerEmail ?? null,
      paidAt: status === 'CONFIRMED' ? (input.paidAt ?? new Date()) : input.paidAt ?? null,
      notes: input.notes ?? null,
      recordedBy: ctx.userId ?? undefined,
    } as unknown as typeof payments.$inferInsert)
    .returning();
  return rows[0]!;
}

/**
 * Confirm a PENDING payment (PENDING → CONFIRMED). On first entry into CONFIRMED
 * the trigger seeds unallocated_kobo = amount_kobo and sets paid_at.
 */
export async function confirm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Payment> {
  const rows = await db
    .update(payments)
    .set({ status: 'CONFIRMED', paidAt: new Date() })
    .where(and(eq(payments.id, id), eq(payments.organizationId, ctx.organizationId)))
    .returning();
  const p = rows[0];
  if (!p) throw new RepoInvariantError(`Payment ${id} not found in tenant`);
  return p;
}

export async function markFailed(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Payment> {
  const rows = await db
    .update(payments)
    .set({ status: 'FAILED' })
    .where(and(eq(payments.id, id), eq(payments.organizationId, ctx.organizationId)))
    .returning();
  const p = rows[0];
  if (!p) throw new RepoInvariantError(`Payment ${id} not found in tenant`);
  return p;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Payment | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrThrow(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Payment> {
  const p = await get(db, ctx, id);
  if (!p) throw new RepoInvariantError(`Payment ${id} not found in tenant`);
  return p;
}

export async function findByReference(
  db: TenantScopedDb,
  ctx: TenantCtx,
  method: string,
  reference: string,
): Promise<Payment | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, ctx.organizationId),
        eq(payments.method, method as Payment['method']),
        eq(payments.reference, reference),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.organizationId, ctx.organizationId));
}
