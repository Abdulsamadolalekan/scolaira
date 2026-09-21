import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import {
  listQueue,
  type ReconciliationCaseKind,
  type ReconciliationState,
} from '@/lib/reconciliation';

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
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export const GET = withAuthorizedRoute(
  { action: 'reconciliation.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, ctx, query }) => {
    const filters = query as z.infer<typeof QuerySchema>;
    const result = await listQueue(db, ctx, {
      state: filters.state as ReconciliationState | undefined,
      kind: filters.kind as ReconciliationCaseKind | undefined,
      paymentStatus: filters.paymentStatus,
      unallocatedOnly: filters.unallocatedOnly === '1',
      limit: filters.limit,
      cursor: filters.cursor ?? null,
    });
    return NextResponse.json({
      queue: result.rows,
      nextCursor: result.nextCursor,
      asOf: new Date().toISOString(),
    });
  },
);
