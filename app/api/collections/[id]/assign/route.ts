import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as collectionsRepo from '@/lib/db/repo/collections';
import { asUUID } from '@/lib/db/repo/_context';
import * as idempotency from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const BodySchema = z.object({
  assigneeId: z.string().uuid().nullable(),
  expectedVersion: z.number().int().min(0),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'collections.assign', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, body, requestId }, routeParams) => {
    const { id } = await (routeParams as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id))
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid collections case id.', 400);
    const input = body as z.infer<typeof BodySchema>;
    const payload = { caseId: id, ...input };
    const begun = await idempotency.begin(db, ctx, req, {
      scope: 'collections.case.assign',
      path: `/api/collections/${id}/assign`,
      payload,
      required: true,
    });
    if (begun.replay) return begun.replay;

    try {
      const updated = await collectionsRepo.assignCase(db, ctx, asUUID(id), {
        assigneeId: input.assigneeId ? asUUID(input.assigneeId) : null,
        expectedVersion: input.expectedVersion,
        requestId,
      });
      const responseBody = { case: updated };
      await idempotency.complete(db, ctx, begun.key, 200, responseBody);
      return NextResponse.json(responseBody);
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
