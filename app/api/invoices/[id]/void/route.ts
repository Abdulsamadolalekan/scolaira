/**
 * POST /api/invoices/[id]/void — void an invoice.
 *
 * Voiding requires the invoice to have zero paid balance (every allocation must
 * be reversed first). The repo sets status=VOID + reason/actor; the status
 * transition trigger enforces that VOID is reachable from DRAFT/ISSUED/
 * PARTIALLY_PAID/PAID, but we add an explicit balance guard here to give the
 * bursar a clear instruction ("reverse payments before voiding") instead of a
 * raw Postgres exception.
 *
 * R2 (H-7) — exceptional-path integrity:
 *   * The guard, the void and its audit row now happen inside ONE transaction.
 *     Before R2 the balance was read on the pool outside any transaction, so a
 *     concurrent allocation could land between the read and the void and the
 *     invoice would be voided on a stale balance, with an audit row and a state
 *     change that were not atomic with each other.
 *   * `Idempotency-Key` is REQUIRED: a retried void replays the original
 *     response instead of re-deciding on a fresh read.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as invRepo from '@/lib/db/repo/invoices';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const Schema = z.object({ reason: z.string().min(1).max(500) });

export const POST = withAuthorizedRoute(
  { action: 'invoice.void', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = Schema.parse(body);

    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'invoice.void',
        path: `/api/invoices/${id}/void`,
        payload: { id, reason: data.reason },
        required: true,
      });
      if (idem.replay) return idem.replay;

      const existing = await invRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Invoice');
      if (existing!.status === 'VOID') {
        const response = { invoice: existing };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response, { status: 200 }); // idempotent
      }
      const paid = Number(existing!.paidKobo) || 0;
      if (paid > 0) {
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          `Cannot void an invoice with ${paid} kobo in recorded payments. Reverse the related payment(s) first.`,
          409,
        );
      }
      try {
        const voided = await invRepo.voidInvoice(tx, ctx, id as any, data.reason);
        await auditRepo.record(tx, ctx, {
          action: 'invoice.void',
          entityType: 'invoice',
          entityId: id as any,
          after: { status: voided.status, invoiceNumber: voided.invoiceNumber },
          metadata: { requestId, reason: data.reason },
        });
        const response = {
          invoice: { id: voided.id, invoiceNumber: voided.invoiceNumber, status: voided.status },
        };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      } catch (e) {
        if (e instanceof RepoInvariantError) {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
        }
        throw e;
      }
    });
  },
);
