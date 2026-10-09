/**
 * POST /api/invoices/[id]/issue — issue a DRAFT invoice.
 *
 * Idempotent: issuing an already-ISSUED/PARTIALLY_PAID/PAID invoice returns 200
 * with the current invoice (with Idempotent-Replayed if requested). The status
 * transition trigger prevents DRAFT→ISSUED on a VOID invoice.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as invRepo from '@/lib/db/repo/invoices';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as idemRepo from '@/lib/db/repo/idempotency-keys';
import { RepoInvariantError } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const Schema = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(1000).optional(),
});

export const POST = withAuthorizedRoute(
  { action: 'invoice.issue', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = Schema.parse(body);
    const idemKey = req.headers.get('idempotency-key')?.trim();

    return db.transaction(async (tx) => {
      if (idemKey) {
        const existing = await idemRepo.acquire(tx, ctx, {
          key: idemKey, scope: 'invoice.issue', requestMethod: 'POST',
          requestPath: `/api/invoices/${id}/issue`, expiresAt: new Date(Date.now()+24*60*60*1000),
        });
        if (existing && existing.responseStatus) {
          try {
            const parsed = typeof existing.responseBody === 'string' ? JSON.parse(existing.responseBody) : existing.responseBody;
            const r = NextResponse.json(parsed, { status: existing.responseStatus });
            r.headers.set('Idempotent-Replayed', 'true');
            return r;
          } catch { /* fall through */ }
        }
      }
      const inv = await invRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, inv, 'Invoice');
      if (inv!.status !== 'DRAFT') {
        // Already issued — idempotent success.
        const resp = { invoice: { id: inv!.id, invoiceNumber: inv!.invoiceNumber, status: inv!.status } };
        if (idemKey) await idemRepo.complete(tx, ctx, idemKey, 200, resp);
        return NextResponse.json(resp);
      }
      try {
        const issued = await invRepo.issue(tx, ctx, id as any, { dueDate: data.dueDate, memo: data.memo });
        await auditRepo.record(tx, ctx, {
          action: 'invoice.issue', entityType: 'invoice', entityId: id as any,
          after: { invoiceNumber: issued.invoiceNumber, status: issued.status },
          metadata: { requestId },
        });
        const resp = { invoice: { id: issued.id, invoiceNumber: issued.invoiceNumber, status: issued.status } };
        if (idemKey) await idemRepo.complete(tx, ctx, idemKey, 200, resp);
        return NextResponse.json(resp);
      } catch (e) {
        if (e instanceof RepoInvariantError) {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
        }
        throw e;
      }
    });
  },
);
