import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import {
  getOrCreateCase,
  lockPayment,
  requireEvidence,
  updateCaseState,
} from '@/lib/reconciliation';
import type { ReconciliationState } from '@/lib/db/repo/reconciliation';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({ note: z.string().trim().max(1000).optional() });

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
        scope: 'reconciliation.confirm',
        path: `/api/reconciliation/payments/${id}/confirm`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      const caseRow = await getOrCreateCase(tx, ctx, payment);
      if (caseRow.state === 'FLAGGED')
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'Unflag the case or resolve the exception before confirming the payment.',
          409,
        );
      await requireEvidence(tx, ctx, caseRow.id);
      let confirmed = payment;
      if (payment.status === 'DUPLICATE_SUSPECT' && payment.unallocatedKobo <= 0) {
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'This duplicate-suspect payment is fully allocated; use the existing reversal/refund correction path rather than reinitializing its allocation balance.',
          409,
        );
      }
      if (payment.status === 'PENDING' || payment.status === 'DUPLICATE_SUSPECT') {
        const confirmedRow = await payRepo.confirm(tx, ctx, id as any);
        confirmed = {
          ...payment,
          status: confirmedRow.status,
          unallocatedKobo: Number(confirmedRow.unallocatedKobo),
        };
        await auditRepo.record(tx, ctx, {
          action: 'payment.confirm',
          entityType: 'payment',
          entityId: id as any,
          before: { status: payment.status },
          after: { status: confirmedRow.status, paidAt: confirmedRow.paidAt },
          reason: data.note,
          metadata: { requestId, via: 'reconciliation' },
        });
      } else if (payment.status !== 'CONFIRMED') {
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          `Cannot confirm a payment in status ${payment.status}.`,
          409,
        );
      }

      const updatedCase = await updateCaseState(tx, ctx, {
        caseId: caseRow.id,
        state: caseRow.state as ReconciliationState,
        kind: confirmed.unallocatedKobo > 0 ? 'TO_MATCH' : 'TO_ALLOCATE',
        reason: data.note ?? caseRow.reason,
        requestId,
        auditAction: 'reconciliation.confirm',
        beforeExtra: { paymentStatus: payment.status },
        afterExtra: { paymentStatus: confirmed.status, unallocatedKobo: confirmed.unallocatedKobo },
      });
      const response = {
        payment: { id: id, status: confirmed.status, unallocatedKobo: confirmed.unallocatedKobo },
        reconciliation: {
          caseId: updatedCase.id,
          state: updatedCase.state,
          kind: updatedCase.kind,
        },
      };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
