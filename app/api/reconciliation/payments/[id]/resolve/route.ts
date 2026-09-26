import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import {
  getOrCreateCase,
  lockPayment,
  requireEvidence,
  updateCaseState,
} from '@/lib/reconciliation';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({
  resolutionCode: z.enum(['NO_FINANCIAL_ACTION', 'DUPLICATE_REVIEWED', 'OUT_OF_SCOPE']),
  note: z.string().trim().min(1).max(2000),
});

/**
 * Close a human-reviewed exception without changing authoritative payment,
 * invoice, allocation, reversal, refund, or receipt state. Those consequences
 * remain on their existing state-machine endpoints.
 */
export const POST = withAuthorizedRoute(
  { action: 'reconciliation.resolve', method: 'POST', bodySchema: Schema },
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
        scope: 'reconciliation.resolve',
        path: `/api/reconciliation/payments/${id}/resolve`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      const caseRow = await getOrCreateCase(tx, ctx, payment);
      if (caseRow.state === 'ALLOCATED')
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Allocated cases are already resolved.', 409);
      await requireEvidence(tx, ctx, caseRow.id);
      const updatedCase = await updateCaseState(tx, ctx, {
        caseId: caseRow.id,
        state: 'RECONCILED',
        kind: 'FLAGGED_EXCEPTION',
        close: true,
        resolutionCode: data.resolutionCode,
        resolutionNote: data.note,
        reason: data.note,
        requestId,
        auditAction: 'reconciliation.resolve',
        beforeExtra: { paymentStatus: payment.status, state: caseRow.state },
        afterExtra: { paymentStatus: payment.status, financialAction: 'none' },
      });
      const response = {
        reconciliation: {
          caseId: updatedCase.id,
          state: updatedCase.state,
          closedAt: updatedCase.closedAt,
          resolutionCode: updatedCase.resolutionCode,
        },
        financialAction: 'none',
      };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
