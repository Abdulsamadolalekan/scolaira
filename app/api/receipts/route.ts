/**
 * POST /api/receipts — issue a receipt for a payment.
 *
 * A receipt is issued against a single CONFIRMED payment for the amount of
 * ACTIVE allocations on it (or amount - unallocated if fully allocated;
 * unallocated credit is listed on the receipt as "held on account" — not
 * receipted). Issuance is idempotent per payment (only one ISSUED receipt per
 * payment at a time; if an ISSUED receipt already exists it is returned).
 *
 * This is the only sanctioned way to create a receipt row. The receipt table
 * has append-only semantics (UPDATE is blocked on immutable columns); status
 * can move ISSUED → VOID via /api/receipts/[id]/void in a later pass if needed.
 *
 * R2 (H-7) — exceptional-path integrity:
 *   * The whole issuance is ONE transaction: read payment → read allocations →
 *     guard → insert receipt (with its frozen allocation snapshot) → audit.
 *     Before R2 the reads and writes were separate autocommit statements, so a
 *     concurrent reversal could land between the read and the insert and freeze
 *     an amount that no longer matched the allocations at rest.
 *   * `Idempotency-Key` is REQUIRED (the same boundary M9 introduced for
 *     academic mutations). A retry cannot silently issue a second document.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as receiptRepo from '@/lib/db/repo/receipts';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { sqlState } from '@/lib/db/pg-error';
import { receipts, paymentAllocations, invoices, students } from '@/lib/db/schema';

export const runtime = 'nodejs';

const Schema = z.object({
  paymentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

function serialize(receipt: {
  id: string;
  receiptNumber: string;
  amountKobo: unknown;
  status: string;
}) {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    amountKobo: Number(receipt.amountKobo),
    status: receipt.status,
  };
}

export const POST = withAuthorizedRoute(
  { action: 'receipt.issue', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }) => {
    const data = Schema.parse(body);

    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'receipt.issue',
          path: '/api/receipts',
          payload: data,
          required: true,
        });
        if (idem.replay) return idem.replay;

        const payment = await payRepo.get(tx, ctx, data.paymentId as any);
        assertResourceInOrg(ctx, payment, 'Payment');
        if (payment!.status !== 'CONFIRMED') {
          throw new AuthzError(
            AuthzErrorCode.BAD_REQUEST,
            `Receipts can only be issued for CONFIRMED payments (current status: ${payment!.status}).`,
            400,
          );
        }

        // Allocated amount (sum of ACTIVE allocations) is what is receipted —
        // read inside the transaction, so the snapshot below is the allocation
        // set this amount was actually computed from.
        const allocRows = await tx
          .select({
            id: paymentAllocations.id,
            invoiceId: paymentAllocations.invoiceId,
            amountKobo: paymentAllocations.amountKobo,
            invoiceNumber: invoices.invoiceNumber,
            studentId: invoices.studentId,
            studentFirstName: students.firstName,
            studentLastName: students.lastName,
          })
          .from(paymentAllocations)
          .leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
          .leftJoin(students, eq(students.id, invoices.studentId))
          .where(
            and(
              eq(paymentAllocations.paymentId, data.paymentId),
              eq(paymentAllocations.status, 'ACTIVE'),
            ),
          );
        const receipted = allocRows.reduce((s, r) => s + Number(r.amountKobo), 0);
        if (receipted <= 0) {
          throw new AuthzError(
            AuthzErrorCode.BAD_REQUEST,
            'Cannot issue a receipt for an unallocated payment. Allocate to at least one invoice first.',
            400,
          );
        }
        // One receipt per payment covering all allocations. Student is taken
        // from the first allocation (parent payers typically pay for one child;
        // multi-child split payments are M7).
        const studentId = allocRows[0]!.studentId;
        if (!studentId) {
          throw new AuthzError(
            AuthzErrorCode.BAD_REQUEST,
            'Could not resolve student for receipt.',
            400,
          );
        }

        // Idempotency: an already-ISSUED receipt for this payment is returned.
        const existing = await tx
          .select()
          .from(receipts)
          .where(
            and(eq(receipts.paymentId, data.paymentId), eq(receipts.status, 'ISSUED')),
          )
          .orderBy(desc(receipts.issuedAt))
          .limit(1);
        if (existing[0]) {
          const response = { receipt: serialize(existing[0] as any) };
          await completeIdempotency(tx, ctx, idem.key, 200, response);
          return NextResponse.json(response, { status: 200 });
        }

        const snapshot: receiptRepo.ReceiptAllocationSnapshotLine[] = allocRows.map((r) => ({
          allocationId: r.id,
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber ?? null,
          studentId: r.studentId ?? null,
          studentName:
            [r.studentFirstName, r.studentLastName].filter(Boolean).join(' ').trim() || null,
          amountKobo: Number(r.amountKobo),
        }));

        const receipt = await receiptRepo.issue(tx, ctx, {
          paymentId: data.paymentId as any,
          studentId: studentId as any,
          amountKobo: receipted as any,
          allocationsSnapshot: snapshot,
        });
        await auditRepo.record(tx, ctx, {
          action: 'receipt.issue',
          entityType: 'receipt',
          entityId: receipt.id,
          after: {
            receiptNumber: receipt.receiptNumber,
            paymentId: data.paymentId,
            amountKobo: receipted,
            lines: snapshot.length,
          },
          metadata: { requestId, note: data.note ?? null },
        });

        const response = { receipt: serialize(receipt as any) };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      });
    } catch (e: any) {
      if (sqlState(e) === '23505') {
        // M9 database uniqueness is the winner under a concurrent issue race.
        // Re-read the committed ISSUED receipt (the failed transaction is gone)
        // and return it as the idempotent result instead of a conflict.
        const winner = await db
          .select()
          .from(receipts)
          .where(
            and(eq(receipts.paymentId, data.paymentId), eq(receipts.status, 'ISSUED')),
          )
          .orderBy(desc(receipts.issuedAt))
          .limit(1);
        if (winner[0]) {
          return NextResponse.json({ receipt: serialize(winner[0] as any) }, { status: 200 });
        }
      }
      if (e instanceof RepoInvariantError) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      }
      throw e;
    }
  },
);
