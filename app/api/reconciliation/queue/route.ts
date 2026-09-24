import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import {
  listQueue,
  type ReconciliationCaseKind,
  type ReconciliationState,
} from '@/lib/reconciliation';
import { SURFACE_LIMITS, pageMeta, resolveLimit } from '@/lib/db/repo/pagination';

export const runtime = 'nodejs';

const STATES = ['UNMATCHED', 'FLAGGED', 'RECONCILED', 'ALLOCATED'] as const;
const KINDS = [
  'TO_CONFIRM',
  'TO_MATCH',
  'TO_ALLOCATE',
  'DUPLICATE_REVIEW',
  'FLAGGED_EXCEPTION',
  'LATE_EVENT',
] as const;
const QuerySchema = z.object({
  state: z.enum(STATES).optional(),
  kind: z.enum(KINDS).optional(),
  paymentStatus: z.string().trim().min(1).max(32).optional(),
  unallocatedOnly: z.enum(['0', '1']).optional(),
  // H-2: the cap is the shared declaration, not a second literal.
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export const GET = withAuthorizedRoute(
  { action: 'reconciliation.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, ctx, query }) => {
    const filters = query as z.infer<typeof QuerySchema>;
    const surface = SURFACE_LIMITS.reconciliation;
    const limit = resolveLimit(surface, filters.limit ?? null);
    const result = await listQueue(db, ctx, {
      state: filters.state as ReconciliationState | undefined,
      kind: filters.kind as ReconciliationCaseKind | undefined,
      paymentStatus: filters.paymentStatus,
      unallocatedOnly: filters.unallocatedOnly === '1',
      limit,
      cursor: filters.cursor ?? null,
    });
    return NextResponse.json({
      queue: result.rows,
      nextCursor: result.nextCursor,
      // H-2/M-6: the queue already had a cursor; it now also declares its cap
      // and whether it is truncated. `total` is declared null on purpose: this
      // queue is a UNION over explicit cases and rows DERIVED from payment
      // state, so a second counting implementation could silently disagree with
      // what the window actually returns. `hasMore`/`nextCursor` come from the
      // same limit+1 probe that produced the rows.
      page: pageMeta({
        surface,
        limit,
        returned: result.rows.length,
        total: null,
        hasMore: Boolean(result.nextCursor),
        nextCursor: result.nextCursor,
      }),
      asOf: new Date().toISOString(),
    });
  },
);
