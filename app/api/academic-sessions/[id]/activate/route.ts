import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { academicSessions } from '@/lib/db/schema';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'academic_session.manage', method: 'POST', bodySchema: undefined },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid session id.' } }, { status: 400 });
    const updated = await db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'academic-session.activate', path: `/api/academic-sessions/${id}/activate`, payload: { id }, required: true,
      });
      if (idem.replay) return idem.replay;
      // Lock every session in this organization before changing the current
      // pointer. The partial unique index is the final race guard.
      await tx.execute(sql`SELECT id FROM academic_sessions WHERE organization_id = ${ctx.organizationId}::uuid ORDER BY id FOR UPDATE`);
      const existing = await sessionRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Academic session');
      if (existing!.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Closed sessions cannot be reopened through this workflow.', 409);
      await tx.update(academicSessions).set({ isCurrent: false }).where(eq(academicSessions.organizationId, ctx.organizationId));
      const rows = await tx.update(academicSessions)
        .set({ isCurrent: true, status: 'ACTIVE' })
        .where(and(eq(academicSessions.id, id), eq(academicSessions.organizationId, ctx.organizationId)))
        .returning();
      const row = rows[0]!;
      await auditRepo.record(tx, ctx, {
        action: 'academic_session.activate', entityType: 'academic_session', entityId: row.id,
        before: { isCurrent: existing!.isCurrent, status: existing!.status },
        after: { isCurrent: row.isCurrent, status: row.status }, metadata: { requestId },
      });
      const response = { session: { id: row.id, name: row.name, startsOn: row.startsOn, endsOn: row.endsOn, isCurrent: row.isCurrent, status: row.status } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
    return updated;
  },
);
