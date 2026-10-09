import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { addEvidence, getOrCreateCase, lockPayment } from '@/lib/reconciliation';
import * as auditRepo from '@/lib/db/repo/audit-events';
import type { ReconciliationEvidenceKind } from '@/lib/db/repo/reconciliation';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({
  kind: z.enum(['BANK_REFERENCE', 'CASH_RECEIPT', 'POS_SLIP', 'OPERATOR_NOTE', 'PROVIDER_EVENT']),
  reference: z.string().trim().max(255).optional(),
  observedAt: z.string().datetime().optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  contentHash: z.string().trim().max(128).optional(),
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
    if (!data.reference && !data.note)
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        'Evidence requires a reference or note.',
        400,
      );
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'reconciliation.evidence',
        path: `/api/reconciliation/payments/${id}/evidence`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      const caseRow = await getOrCreateCase(tx, ctx, payment);
      if (caseRow.closedAt)
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'This reconciliation case is already closed.',
          409,
        );
      const evidence = await addEvidence(tx, ctx, {
        caseId: caseRow.id,
        kind: data.kind as ReconciliationEvidenceKind,
        reference: data.reference ?? null,
        observedAt: data.observedAt ? new Date(data.observedAt) : null,
        note: data.note ?? null,
        contentHash: data.contentHash ?? null,
      });
      await auditRepo.record(tx, ctx, {
        action: 'reconciliation.evidence.add',
        entityType: 'reconciliation_evidence',
        entityId: evidence.id,
        after: { caseId: caseRow.id, kind: evidence.kind, reference: evidence.reference },
        metadata: { requestId },
      });
      const response = {
        caseId: caseRow.id,
        evidence: {
          id: evidence.id,
          kind: evidence.kind,
          reference: evidence.reference,
          observedAt: evidence.observedAt,
          note: evidence.note,
        },
      };
      await completeIdempotency(tx, ctx, idem.key, 201, response);
      return NextResponse.json(response, { status: 201 });
    });
  },
);
