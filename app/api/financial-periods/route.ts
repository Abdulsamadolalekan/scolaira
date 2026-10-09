/**
 * H-2 — financial periods (the term-boundary control surface).
 *
 *   GET  — list the organization's periods, newest boundary first, with the
 *          mandatory `page` block (H-2/M-6: no list is capped silently).
 *   POST — create a bounded, non-overlapping window.
 *
 * Closing is a separate, harder decision: see `[id]/close`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as periodRepo from '@/lib/db/repo/financial-periods';
import {
  SURFACE_LIMITS,
  pageMeta,
  resolveLimit,
} from '@/lib/db/repo/pagination';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const LIMIT = { ...SURFACE_LIMITS.financialPeriods };

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  startsOn: DateSchema,
  endsOn: DateSchema,
});

export const GET = withAuthorizedRoute(
  { action: 'financial_period.read', method: 'GET' },
  async (req, { db, ctx }) => {
    const url = new URL(req.url);
    const limit = resolveLimit(LIMIT, url.searchParams.get('limit'));
    const [periods, total] = await Promise.all([
      periodRepo.listPeriods(db, ctx, limit),
      periodRepo.countPeriods(db, ctx),
    ]);
    return NextResponse.json({
      periods,
      page: pageMeta({ surface: LIMIT, limit, returned: periods.length, total }),
      asOf: new Date().toISOString(),
    });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'financial_period.manage', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof CreateSchema>;
    if (data.endsOn < data.startsOn) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        'A period cannot end before it starts.',
        400,
      );
    }
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'financial_period.create',
        path: '/api/financial-periods',
        payload: data,
        required: true,
      });
      if (idem.replay) return idem.replay;

      let period;
      try {
        period = await periodRepo.createPeriod(tx, ctx, data);
      } catch (e) {
        if (e instanceof periodRepo.PeriodOverlapError) {
          throw new AuthzError(
            AuthzErrorCode.PERIOD_OVERLAP,
            'This window overlaps a period that already exists. Financial periods must not overlap.',
            409,
          );
        }
        throw e;
      }

      await auditRepo.record(tx, ctx, {
        action: 'financial_period.create',
        entityType: 'financial_period',
        entityId: period.id as any,
        after: { name: period.name, startsOn: period.startsOn, endsOn: period.endsOn },
        requestId,
      });

      const response = NextResponse.json({ period }, { status: 201 });
      if (idem.key) await completeIdempotency(tx, ctx, idem.key, 201, { period });
      return response;
    });
  },
);
