/**
 * Reversals / Refunds / Corrections repository.
 *
 * M2 FINANCIAL RULE (deliberate simplification, see architecture report §3 N6):
 *   - Reversals MUST reference a payment.
 *   - Partial-allocation reversal is NOT supported; reversals consume
 *     allocations oldest-first in whole-allocation units.
 *   - Reversals are append-only (UPDATE/DELETE revoked from app role; trigger
 *     raises on any mutation).
 *
 * The trg_reversals_insert trigger:
 *   - FOR UPDATE locks the payment, then ACTIVE allocations (oldest first)
 *   - verifies amount ≤ remaining reversible (amount − prior reversals)
 *   - flips allocations to REVERSED, sets reversal_id
 *   - decrements invoice.paid_kobo per reversed allocation
 *   - recomputes invoice status
 *   - increments payment.unallocated_kobo (money returns to the payment)
 *   - flips payment to REVERSED if fully reversed
 */
import { eq, and } from 'drizzle-orm';
import { reversals } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';
import type { Kobo } from '@/lib/money';

export type Reversal = typeof reversals.$inferSelect;

export interface CreateReversalInput {
  paymentId: UUID;
  type?: 'REVERSAL' | 'REFUND' | 'CORRECTION';
  amountKobo: Kobo;
  reason: string;
  reference?: string;
}

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: CreateReversalInput,
): Promise<Reversal> {
  if (!input.reason?.trim()) {
    throw new RepoInvariantError('Reversals require a non-empty reason for audit.');
  }
  if (input.amountKobo <= 0) {
    throw new RepoInvariantError(`Reversal amount must be positive; got ${input.amountKobo}`);
  }
  const rows = await db
    .insert(reversals)
    .values({
      organizationId: ctx.organizationId,
      paymentId: input.paymentId,
      type: input.type ?? 'REVERSAL',
      amountKobo: input.amountKobo,
      reason: input.reason,
      reference: input.reference ?? null,
      reversedBy: ctx.userId ?? undefined,
    } as unknown as typeof reversals.$inferInsert)
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Reversal | null> {
  const rows = await db
    .select()
    .from(reversals)
    .where(and(eq(reversals.id, id), eq(reversals.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listForPayment(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<Reversal[]> {
  return db
    .select()
    .from(reversals)
    .where(
      and(
        eq(reversals.organizationId, ctx.organizationId),
        eq(reversals.paymentId, paymentId),
      ),
    );
}
