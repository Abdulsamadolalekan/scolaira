import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as collectionsRepo from '@/lib/db/repo/collections';
import { asUUID } from '@/lib/db/repo/_context';
import * as idempotency from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const BodySchema = z.object({
  eventType: z.enum(['NOTE', 'ACTION']),
  note: z.string().trim().min(1).max(4000),
  reminderId: z.string().uuid().nullable().optional(),
  nextActionAt: z.string().datetime({ offset: true }).nullable().optional(),
  expectedVersion: z.number().int().min(0),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'collections.note', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, body, requestId }, routeParams) => {
    const { id } = await (routeParams as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id))
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid collections case id.', 400);
    const input = body as z.infer<typeof BodySchema>;
    const begun = await idempotency.begin(db, ctx, req, {
      scope: 'collections.case.event',
      path: `/api/collections/${id}/events`,
      payload: { caseId: id, ...input },
      required: true,
    });
    if (begun.replay) return begun.replay;

    try {
      const result = await collectionsRepo.addCaseEvent(db, ctx, asUUID(id), {
        eventType: input.eventType,
        note: input.note,
        reminderId: input.reminderId ? asUUID(input.reminderId) : null,
        nextActionAt:
          input.nextActionAt === undefined
            ? undefined
            : input.nextActionAt === null
              ? null
              : new Date(input.nextActionAt),
        expectedVersion: input.expectedVersion,
        requestId,
      });
      const responseBody = { case: result.case, event: result.event };
      await idempotency.complete(db, ctx, begun.key, 201, responseBody);
      return NextResponse.json(responseBody, { status: 201 });
    } catch (error) {
      if (begun.key && error instanceof AuthzError) {
        await idempotency.complete(db, ctx, begun.key, error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      throw error;
    }
  },
);
