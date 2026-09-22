import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as collectionsRepo from '@/lib/db/repo/collections';
import { asUUID } from '@/lib/db/repo/_context';
import * as idempotency from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const STATES = ['OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const QuerySchema = z.object({
  state: z.enum(STATES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignee: z.string().uuid().optional(),
  includeClosed: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateSchema = z.object({
  studentId: z.string().uuid(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  reason: z.string().trim().min(1).max(2000),
  nextActionAt: z.string().datetime({ offset: true }).nullable().optional(),
});

function postgresCode(error: unknown): unknown {
  const typed = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return typed?.code ?? typed?.cause?.code;
}

function errorBody(error: unknown) {
  if (error instanceof AuthzError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  const code = postgresCode(error);
  if (code === '23505') {
    return {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'An open collections case already exists for this student account.',
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Internal error' } },
  };
}

export const GET = withAuthorizedRoute(
  { action: 'collections.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, ctx, query }) => {
    const filters = query as z.infer<typeof QuerySchema>;
    const queue = await collectionsRepo.listQueue(db, ctx, {
      state: filters.state,
      priority: filters.priority,
      assignee: filters.assignee ? asUUID(filters.assignee) : undefined,
      includeClosed: filters.includeClosed === '1',
      limit: filters.limit,
    });
    return NextResponse.json({ queue, asOf: new Date().toISOString() });
  },
);

export const POST = withAuthorizedRoute(
  {
    action: 'collections.create',
    method: 'POST',
    bodySchema: CreateSchema,
  },
  async (req, { db, ctx, body, requestId }) => {
    const input = body as z.infer<typeof CreateSchema>;
    const payload = {
      studentId: input.studentId,
      priority: input.priority,
      reason: input.reason,
      nextActionAt: input.nextActionAt ?? null,
    };
    const begun = await idempotency.begin(db, ctx, req, {
      scope: 'collections.case.create',
      path: '/api/collections',
      payload,
      required: true,
    });
    if (begun.replay) return begun.replay;

    try {
      const created = await collectionsRepo.createCase(db, ctx, {
        studentId: asUUID(input.studentId),
        priority: input.priority,
        reason: input.reason,
        nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : null,
        requestId,
      });
      const responseBody = { case: created };
      await idempotency.complete(db, ctx, begun.key, 201, responseBody);
      return NextResponse.json(responseBody, { status: 201 });
    } catch (error) {
      const mapped = errorBody(error);
      if (begun.key) await idempotency.complete(db, ctx, begun.key, mapped.status, mapped.body);
      if (error instanceof AuthzError) throw error;
      if (postgresCode(error) === '23505') {
        throw new AuthzError(AuthzErrorCode.CONFLICT, mapped.body.error.message, 409);
      }
      throw error;
    }
  },
);
