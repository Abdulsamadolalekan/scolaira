/**
 * POST /api/invoices/[id]/void — void an invoice.
 *
 * Voiding requires the invoice to have zero paid balance (every allocation must
 * be reversed first). The repo sets status=VOID + reason/actor; the status
 * transition trigger enforces that VOID is reachable from DRAFT/ISSUED/
 * PARTIALLY_PAID/PAID, but we add an explicit balance guard here to give the
 * bursar a clear instruction ("reverse payments before voiding") instead of a
 * raw Postgres exception.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as invRepo from '@/lib/db/repo/invoices';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const Schema = z.object({ reason: z.string().min(1).max(500) });

export const POST = withAuthorizedRoute(
  { action: 'invoice.void', method: 'POST', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = Schema.parse(body);
    const existing = await invRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, existing, 'Invoice');
    if (existing!.status === 'VOID') {
      return NextResponse.json({ invoice: existing }, { status: 200 }); // idempotent
    }
    const paid = Number(existing!.paidKobo) || 0;
    if (paid > 0) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
        `Cannot void an invoice with ${paid} kobo in recorded payments. Reverse the related payment(s) first.`, 409);
    }
    try {
      const voided = await invRepo.voidInvoice(db, ctx, id as any, data.reason);
      await auditRepo.record(db, ctx, {
        action: 'invoice.void', entityType: 'invoice', entityId: id as any,
        after: { status: voided.status, invoiceNumber: voided.invoiceNumber },
        metadata: { requestId, reason: data.reason },
      });
      return NextResponse.json({ invoice: { id: voided.id, invoiceNumber: voided.invoiceNumber, status: voided.status } });
    } catch (e) {
      if (e instanceof RepoInvariantError) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      }
      throw e;
    }
  },
);
