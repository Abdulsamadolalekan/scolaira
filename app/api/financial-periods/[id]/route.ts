/**
 * H-2 — one financial period with its as-of valuation.
 *
 *   GET — the period, its declared scope, the cut-over term used for the
 *         classification, and the valuation computed from ledger timestamps
 *         as of the window's end date. For a CLOSED window the figures are
 *         stable evidence: money arriving later is excluded by construction.
 */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as periodRepo from '@/lib/db/repo/financial-periods';
import * as aggregates from '@/lib/db/repo/aggregates';
import * as scopingRepo from '@/lib/db/repo/scoping';
import type { UUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuthorizedRoute(
  { action: 'financial_period.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid period id.', 400);
    }
    const period = await periodRepo.getPeriod(db, ctx, id as UUID);
    if (!period) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Financial period not found.', 404);

    const [valuation, scope] = await Promise.all([
      aggregates.periodValuation(db, ctx, id as UUID),
      scopingRepo.getInvoiceScopeDeclaration(db, ctx),
    ]);

    return NextResponse.json({
      period,
      valuation: {
        buckets: valuation.buckets,
        allTerm: valuation.allTerm,
        labels: aggregates.BUCKET_LABELS,
      },
      scope,
    });
  },
);
