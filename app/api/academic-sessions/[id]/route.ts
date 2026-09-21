import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { academicSessions } from '@/lib/db/schema';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  startsOn: DateSchema.optional(),
  endsOn: DateSchema.nullable().optional(),
});

function serialize(row: typeof academicSessions.$inferSelect) {
  return { id: row.id, name: row.name, startsOn: row.startsOn, endsOn: row.endsOn, isCurrent: row.isCurrent, status: row.status, closedAt: row.closedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export const GET = withAuthorizedRoute(
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid session id.' } }, { status: 400 });
    const row = await sessionRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, row, 'Academic session');
    return NextResponse.json({ session: serialize(row!) });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'academic_session.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid session id.' } }, { status: 400 });
    const data = body as z.infer<typeof PatchSchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'academic-session.update', path: `/api/academic-sessions/${id}`, payload: { id, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await sessionRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Academic session');
      if (existing!.status !== 'PLANNED') {
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Only planned sessions can be edited.', 409);
      }
      const startsOn = data.startsOn ?? existing!.startsOn;
      const endsOn = data.endsOn === undefined ? existing!.endsOn : data.endsOn;
      if (endsOn && endsOn < startsOn) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Session end date cannot precede its start date.', 400);
      }
      try {
        const rows = await tx.update(academicSessions)
          .set({ name: data.name ?? existing!.name, startsOn, endsOn })
          .where(and(eq(academicSessions.id, id), eq(academicSessions.organizationId, ctx.organizationId)))
          .returning();
        const updated = rows[0]!;
        await auditRepo.record(tx, ctx, {
          action: 'academic_session.update', entityType: 'academic_session', entityId: updated.id,
          before: { name: existing!.name, startsOn: existing!.startsOn, endsOn: existing!.endsOn },
          after: { name: updated.name, startsOn: updated.startsOn, endsOn: updated.endsOn },
          metadata: { requestId },
        });
        const response = { session: serialize(updated) };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'An academic session with that name already exists.', 409);
        throw error;
      }
    });
  },
);
