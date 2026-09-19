/**
 * POST /api/receipts — issue a receipt for a payment.
 *
 * In M6 a receipt is issued against a single CONFIRMED payment for the amount
 * of ACTIVE allocations on it (or amount - unallocated if fully allocated;
 * unallocated credit is listed on the receipt as "held on account" — not
 * receipted). Issuance is idempotent per payment (only one ISSUED receipt per
 * payment at a time; if an ISSUED receipt already exists it is returned).
 *
 * This is the only sanctioned way to create a receipt row. The receipt table
 * has append-only semantics (UPDATE is blocked on immutable columns); status
 * can move ISSUED → VOID via /api/receipts/[id]/void in a later pass if needed.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as receiptRepo from '@/lib/db/repo/receipts';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { receipts, paymentAllocations, invoices } from '@/lib/db/schema';

export const runtime = 'nodejs';

const Schema = z.object({
  paymentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

export const POST = withAuthorizedRoute(
  { action: 'receipt.issue', method: 'POST', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }) => {
    const data = Schema.parse(body);
    const payment = await payRepo.get(db, ctx, data.paymentId as any);
    assertResourceInOrg(ctx, payment, 'Payment');
    if (payment!.status !== 'CONFIRMED') {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
        `Receipts can only be issued for CONFIRMED payments (current status: ${payment!.status}).`, 400);
    }
    // Allocated amount (sum of ACTIVE allocations) is what is receipted.
    const allocRows = await db.select({
      id: paymentAllocations.id,
      invoiceId: paymentAllocations.invoiceId,
      amountKobo: paymentAllocations.amountKobo,
      studentId: invoices.studentId,
    })
      .from(paymentAllocations)
      .leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .where(and(
        eq(paymentAllocations.paymentId, data.paymentId),
        eq(paymentAllocations.status, 'ACTIVE'),
      ));
    const receipted = allocRows.reduce((s, r) => s + Number(r.amountKobo), 0);
    if (receipted <= 0) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
        'Cannot issue a receipt for an unallocated payment. Allocate to at least one invoice first.', 400);
    }
    // For M6 we issue one receipt per payment covering all allocations. Student
    // is taken from the first allocation (parent payers typically pay for one
    // child; multi-child split payments are M7).
    const studentId = allocRows[0]!.studentId;
    if (!studentId) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Could not resolve student for receipt.', 400);
    }

    // Idempotency: if there is already an ISSUED receipt for this payment, return it.
    const existing = await db.select()
      .from(receipts)
      .where(and(eq(receipts.paymentId, data.paymentId), eq(receipts.status, 'ISSUED')))
      .orderBy(desc(receipts.issuedAt))
      .limit(1);
    if (existing[0]) {
      return NextResponse.json({ receipt: { id: existing[0].id, receiptNumber: existing[0].receiptNumber, amountKobo: Number(existing[0].amountKobo), status: existing[0].status } }, { status: 200 });
    }

    try {
      const receipt = await receiptRepo.issue(db, ctx, {
        paymentId: data.paymentId as any,
        studentId: studentId as any,
        amountKobo: receipted as any,
      });
      await auditRepo.record(db, ctx, {
        action: 'receipt.issue', entityType: 'receipt', entityId: receipt.id,
        after: { receiptNumber: receipt.receiptNumber, paymentId: data.paymentId, amountKobo: receipted },
        metadata: { requestId, note: data.note ?? null },
      });
      return NextResponse.json({ receipt: { id: receipt.id, receiptNumber: receipt.receiptNumber, amountKobo: receipted, status: receipt.status } }, { status: 201 });
    } catch (e) {
      if (e instanceof RepoInvariantError) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      }
      throw e;
    }
  },
);
