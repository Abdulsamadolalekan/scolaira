/**
 * H-2 — close a financial period.
 *
 * Preconditions (all read from the ledger, inside the same transaction, with the
 * period row locked):
 *   * no PENDING or DUPLICATE_SUSPECT payment inside the window;
 *   * no CONFIRMED payment inside the window still carrying unapplied funds.
 * Either refuses with 409 and the measured counts — a close never launders work
 * into the next period, and it never "fixes" the ledger to pass.
 *
 * Idempotency-Key is required (the same key replays the same close report).
 */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as periodRepo from '@/lib/db/repo/financial-periods';
import * as aggregates from '@/lib/db/repo/aggregates';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import type { UUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'financial_period.manage', method: 'POST' },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid period id.', 400);
    }
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'financial_period.close',
        path: `/api/financial-periods/${id}/close`,
        payload: { periodId: id },
        required: true,
      });
      if (idem.replay) return idem.replay;

      let result;
      try {
        result = await periodRepo.closePeriod(tx, ctx, id as UUID);
      } catch (e) {
        if (e instanceof periodRepo.PeriodCloseBlockedError) {
          // The reason is the machine-readable code (the counts ride in
          // `details`), so a caller never has to classify prose to learn whether
          // the window holds unconfirmed or unapplied money.
          throw new AuthzError(AuthzErrorCode[e.code], e.message, 409, e.details);
        }
        throw e;
      }
      if (!result) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Financial period not found.', 404);

      if (!result.alreadyClosed) {
        await auditRepo.record(tx, ctx, {
          action: 'financial_period.close',
          entityType: 'financial_period',
          entityId: result.period.id as any,
          after: periodRepo.closeAuditDetail(result),
          reason: `Period ${result.period.name} closed with ${result.valuation.allTerm.invoiceCount} invoice(s) valued as of ${result.period.endsOn}.`,
          requestId,
        });
      }

      const body = {
        period: result.period,
        alreadyClosed: result.alreadyClosed,
        valuation: {
          buckets: result.valuation.buckets,
          allTerm: result.valuation.allTerm,
          labels: aggregates.BUCKET_LABELS,
        },
      };
      const response = NextResponse.json(body, { status: result.alreadyClosed ? 200 : 201 });
      if (idem.key) await completeIdempotency(tx, ctx, idem.key, response.status, body);
      return response;
    });
  },
);
