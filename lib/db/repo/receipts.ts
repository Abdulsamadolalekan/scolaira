/**
 * Receipts repository (append-only).
 *
 * M2: receipts are issued manually after allocation; auto-issuance on
 * payment confirmation can be added at the service layer but the DB model
 * supports it.
 */
import { eq, and } from 'drizzle-orm';
import { receipts } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';
import type { Kobo } from '@/lib/money';

export type Receipt = typeof receipts.$inferSelect;

export interface IssueReceiptInput {
  paymentId: UUID;
  allocationId?: UUID;
  studentId: UUID;
  amountKobo: Kobo;
  pdfUrl?: string;
}

export async function issue(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: IssueReceiptInput,
): Promise<Receipt> {
  if (input.amountKobo <= 0) {
    throw new RepoInvariantError(`Receipt amount must be positive; got ${input.amountKobo}`);
  }
  const rows = await db
    .insert(receipts)
    .values({
      organizationId: ctx.organizationId,
      paymentId: input.paymentId,
      allocationId: input.allocationId ?? null,
      studentId: input.studentId,
      amountKobo: input.amountKobo,
      pdfUrl: input.pdfUrl ?? null,
      issuedBy: ctx.userId ?? undefined,
      status: 'ISSUED',
    } as unknown as typeof receipts.$inferInsert)
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Receipt | null> {
  const rows = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, id), eq(receipts.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listForPayment(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<Receipt[]> {
  return db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, ctx.organizationId),
        eq(receipts.paymentId, paymentId),
      ),
    );
}
