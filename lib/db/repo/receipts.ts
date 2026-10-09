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

/**
 * One line of the receipt's frozen allocation snapshot (R2/H-7).
 *
 * Stored on the receipt row at issuance so the document of record keeps
 * showing what was receipted even after a later reversal or re-allocation.
 */
export interface ReceiptAllocationSnapshotLine {
  allocationId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  studentId: string | null;
  /** Denormalised for the printed document: a reissued receipt must show the
   *  payer-facing name exactly as it was at issuance. */
  studentName: string | null;
  amountKobo: number;
}

export interface IssueReceiptInput {
  paymentId: UUID;
  allocationId?: UUID;
  studentId: UUID;
  amountKobo: Kobo;
  pdfUrl?: string;
  /**
   * The allocation set this receipt's amount was computed from. Captured inside
   * the issuance transaction; the database enforces write-once semantics.
   */
  allocationsSnapshot?: ReceiptAllocationSnapshotLine[];
}

export async function issue(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: IssueReceiptInput,
): Promise<Receipt> {
  if (input.amountKobo <= 0) {
    throw new RepoInvariantError(`Receipt amount must be positive; got ${input.amountKobo}`);
  }
  const snapshotTotal = (input.allocationsSnapshot ?? []).reduce(
    (s, l) => s + l.amountKobo,
    0,
  );
  if (input.allocationsSnapshot && snapshotTotal !== input.amountKobo) {
    throw new RepoInvariantError(
      `Receipt snapshot sums to ${snapshotTotal} kobo but the receipted amount is ${input.amountKobo} kobo`,
    );
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
      allocationsSnapshot: input.allocationsSnapshot ?? null,
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
