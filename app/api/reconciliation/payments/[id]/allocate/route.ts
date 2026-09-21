import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { payments } from '@/lib/db/schema';
import * as invRepo from '@/lib/db/repo/invoices';
import * as allocRepo from '@/lib/db/repo/payment-allocations';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import {
  acceptedCandidate,
  getOrCreateCase,
  lockPayment,
  requireEvidence,
  updateCaseState,
} from '@/lib/reconciliation';
import type { UUID } from '@/lib/db/repo/_context';
import type { Kobo } from '@/lib/money';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().regex(UUID_RE),
        amountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});

export const POST = withAuthorizedRoute(
  { action: 'reconciliation.review', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id))
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid payment id.' } },
        { status: 400 },
      );
    const data = body as z.infer<typeof Schema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'reconciliation.allocate',
        path: `/api/reconciliation/payments/${id}/allocate`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      if (payment.status !== 'CONFIRMED')
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'Only confirmed payments can be allocated.',
          409,
        );
      const caseRow = await getOrCreateCase(tx, ctx, payment, { kind: 'TO_ALLOCATE' });
      if (caseRow.state === 'FLAGGED')
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Unflag the case before allocating it.', 409);
      await requireEvidence(tx, ctx, caseRow.id);
      const candidate = await acceptedCandidate(tx, ctx, caseRow.id);
      if (!candidate)
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'Match the payment to a student or invoice before allocating it.',
          409,
        );

      const total = data.allocations.reduce((sum, row) => sum + row.amountKobo, 0);
      if (!Number.isSafeInteger(total))
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          'Allocation total exceeds the supported safe integer range.',
          400,
        );
      if (total > payment.unallocatedKobo)
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          'Allocation exceeds the payment amount still awaiting allocation.',
          400,
        );
      const out: Array<{
        id: string;
        invoiceId: string;
        invoiceNumber: string;
        amountKobo: number;
      }> = [];
      for (const item of data.allocations) {
        const invoice = await invRepo.get(tx, ctx, item.invoiceId as UUID);
        if (!invoice) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Invoice not found.', 404);
        if (invoice.status === 'DRAFT' || invoice.status === 'VOID')
          throw new AuthzError(
            AuthzErrorCode.CONFLICT,
            `Invoice ${invoice.invoiceNumber} cannot receive an allocation in status ${invoice.status}.`,
            409,
          );
        if (candidate.invoiceId && candidate.invoiceId !== invoice.id)
          throw new AuthzError(
            AuthzErrorCode.CONFLICT,
            'The selected invoice does not match the accepted reconciliation candidate.',
            409,
          );
        if (candidate.studentId && candidate.studentId !== invoice.studentId)
          throw new AuthzError(
            AuthzErrorCode.CONFLICT,
            'The selected invoice does not match the accepted student candidate.',
            409,
          );
        try {
          const result = await allocRepo.allocate(tx, ctx, {
            paymentId: id as UUID,
            invoiceId: item.invoiceId as UUID,
            amountKobo: item.amountKobo as Kobo,
            note: item.note,
          });
          out.push({
            id: result.allocation.id,
            invoiceId: result.invoice.id,
            invoiceNumber: result.invoice.invoiceNumber,
            amountKobo: Number(result.allocation.amountKobo),
          });
        } catch (error) {
          if (error instanceof RepoInvariantError)
            throw new AuthzError(AuthzErrorCode.BAD_REQUEST, error.message, 400);
          throw error;
        }
      }
      const afterRows = await tx
        .select({ unallocatedKobo: payments.unallocatedKobo, status: payments.status })
        .from(payments)
        .where(and(eq(payments.id, id as UUID), eq(payments.organizationId, ctx.organizationId)))
        .limit(1);
      const after = afterRows[0]!;
      const fullyAllocated = Number(after.unallocatedKobo) === 0;
      await auditRepo.record(tx, ctx, {
        action: 'payment.allocate',
        entityType: 'payment',
        entityId: id as UUID,
        after: {
          allocations: out,
          unallocatedKobo: Number(after.unallocatedKobo),
          status: after.status,
        },
        metadata: { requestId, via: 'reconciliation' },
      });
      const updatedCase = await updateCaseState(tx, ctx, {
        caseId: caseRow.id,
        state: fullyAllocated ? 'ALLOCATED' : 'RECONCILED',
        kind: 'TO_ALLOCATE',
        close: fullyAllocated,
        requestId,
        auditAction: 'reconciliation.allocate',
        beforeExtra: { unallocatedKobo: payment.unallocatedKobo },
        afterExtra: { unallocatedKobo: Number(after.unallocatedKobo), allocationCount: out.length },
      });
      const response = {
        payment: { id, status: after.status, unallocatedKobo: Number(after.unallocatedKobo) },
        allocations: out,
        reconciliation: {
          caseId: updatedCase.id,
          state: updatedCase.state,
          closedAt: updatedCase.closedAt,
        },
      };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
