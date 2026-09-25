import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { getOrCreateCase, lockPayment, updateCaseState } from '@/lib/reconciliation';
import type { ReconciliationCaseKind } from '@/lib/db/repo/reconciliation';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({
  flagged: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
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
        scope: 'reconciliation.flag',
        path: `/api/reconciliation/payments/${id}/flag`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      const caseRow = await getOrCreateCase(tx, ctx, payment);
      if (data.flagged && caseRow.state === 'FLAGGED')
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'This case is already flagged.', 409);
      if (!data.flagged && caseRow.state !== 'FLAGGED')
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Only flagged cases can be unflagged.', 409);
      const nextState = data.flagged
        ? ('FLAGGED' as const)
        : ((caseRow.previousState ?? 'UNMATCHED') as 'UNMATCHED' | 'RECONCILED' | 'ALLOCATED');
      const updatedCase = await updateCaseState(tx, ctx, {
        caseId: caseRow.id,
        state: nextState,
        // Keep the work kind stable; FLAGGED is the explicit exception state.
        kind: caseRow.kind as ReconciliationCaseKind,
        previousState: data.flagged ? (caseRow.state as any) : null,
        reason: data.reason,
        requestId,
        auditAction: data.flagged ? 'reconciliation.flag' : 'reconciliation.unflag',
        beforeExtra: { paymentStatus: payment.status },
        afterExtra: { paymentStatus: payment.status, reason: data.reason },
      });
      const response = {
        reconciliation: {
          caseId: updatedCase.id,
          state: updatedCase.state,
          kind: updatedCase.kind,
          reason: updatedCase.reason,
        },
      };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
