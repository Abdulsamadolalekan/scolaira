/**
 * Academic session management for M9.
 * GET is the read surface used by setup/term workflows; POST creates a
 * planned session only. Activation is an explicit action route.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { academicSessions } from '@/lib/db/schema';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(32),
  startsOn: DateSchema,
  endsOn: DateSchema.nullable().optional(),
});

function serialize(row: typeof academicSessions.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    isCurrent: row.isCurrent,
    status: row.status,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const GET = withAuthorizedRoute(
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await db
      .select()
      .from(academicSessions)
      .where(eq(academicSessions.organizationId, ctx.organizationId))
      .orderBy(asc(academicSessions.startsOn), asc(academicSessions.name));
    return NextResponse.json({ sessions: rows.map(serialize) });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'academic_session.manage', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof CreateSchema>;
    if (data.endsOn && data.endsOn < data.startsOn) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Session end date cannot precede its start date.', 400);
    }
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'academic-session.create', path: '/api/academic-sessions', payload: data, required: true,
      });
      if (idem.replay) return idem.replay;

      try {
        const created = await sessionRepo.create(tx, ctx, {
          name: data.name,
          startsOn: data.startsOn,
          endsOn: data.endsOn ?? null,
          isCurrent: false,
          status: 'PLANNED',
        });
        await auditRepo.record(tx, ctx, {
          action: 'academic_session.create',
          entityType: 'academic_session',
          entityId: created.id,
          after: { name: created.name, startsOn: created.startsOn, endsOn: created.endsOn, status: created.status },
          metadata: { requestId },
        });
        const response = { session: serialize(created) };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      } catch (error: any) {
        if (error?.code === '23505') {
          throw new AuthzError(AuthzErrorCode.CONFLICT, 'An academic session with that name already exists.', 409);
        }
        throw error;
      }
    });
  },
);
