/**
 * Payment allocations repository.
 *
 * Allocation is the ONLY legitimate way to move money from a payment onto an
 * invoice. The BEFORE INSERT trigger trg_allocations_insert:
 *   - FOR UPDATE locks payment and invoice (deterministic payment→invoice order)
 *   - verifies amount ≤ payment.unallocated_kobo
 *   - verifies amount ≤ invoice_outstanding_kobo(invoice)
 *   - decrements payment.unallocated_kobo
 *   - increments invoice.paid_kobo
 *   - recomputes invoice status (ISSUED → PARTIALLY_PAID → PAID)
 *
 * The repo therefore simply inserts the allocation row and returns the inserted
 * row together with the updated payment and invoice state (re-read after
 * commit-carrying; for transactional callers this is visible within the txn).
 */
import { eq, and } from 'drizzle-orm';
import { paymentAllocations, payments, invoices } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';
import type { Kobo } from '@/lib/money';

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;

export interface AllocateInput {
  paymentId: UUID;
  invoiceId: UUID;
  amountKobo: Kobo;
  note?: string;
}

export interface AllocationResult {
  allocation: PaymentAllocation;
  payment: typeof payments.$inferSelect;
  invoice: typeof invoices.$inferSelect;
}

export async function allocate(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: AllocateInput,
): Promise<AllocationResult> {
  if (input.amountKobo <= 0) {
    throw new RepoInvariantError(`Allocation amount must be positive; got ${input.amountKobo}`);
  }
  const inserted = await db
    .insert(paymentAllocations)
    .values({
      organizationId: ctx.organizationId,
      paymentId: input.paymentId,
      invoiceId: input.invoiceId,
      amountKobo: input.amountKobo,
      note: input.note ?? null,
      createdBy: ctx.userId ?? undefined,
      status: 'ACTIVE',
    } as unknown as typeof paymentAllocations.$inferInsert)
    .returning();
  const allocation = inserted[0]!;

  // Re-read payment and invoice so the caller sees post-trigger state.
  const [p, i] = await Promise.all([
    db
      .select()
      .from(payments)
      .where(and(eq(payments.id, input.paymentId), eq(payments.organizationId, ctx.organizationId)))
      .limit(1)
      .then((r) => r[0]!),
    db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.organizationId, ctx.organizationId)))
      .limit(1)
      .then((r) => r[0]!),
  ]);
  return { allocation, payment: p, invoice: i };
}

export async function listForInvoice(
  db: TenantScopedDb,
  ctx: TenantCtx,
  invoiceId: UUID,
): Promise<PaymentAllocation[]> {
  return db
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.organizationId, ctx.organizationId),
        eq(paymentAllocations.invoiceId, invoiceId),
      ),
    );
}

export async function listForPayment(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<PaymentAllocation[]> {
  return db
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.organizationId, ctx.organizationId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    );
}
