import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { academicSessions, terms } from '@/lib/db/schema';
import * as termRepo from '@/lib/db/repo/terms';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'term.manage', method: 'POST', bodySchema: undefined },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id.' } }, { status: 400 });
    const updated = await db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'term.activate', path: `/api/terms/${id}/activate`, payload: { id }, required: true,
      });
      if (idem.replay) return idem.replay;
      await tx.execute(sql`SELECT id FROM terms WHERE organization_id = ${ctx.organizationId}::uuid ORDER BY id FOR UPDATE`);
      const current = await termRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, current, 'Term');
      if (current!.status === 'BILLED' || current!.status === 'CLOSED') {
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Billed or closed terms cannot be activated through this workflow.', 409);
      }
      const sessionRows = await tx.select().from(academicSessions)
        .where(and(eq(academicSessions.id, current!.sessionId), eq(academicSessions.organizationId, ctx.organizationId)))
        .limit(1);
      const session = sessionRows[0];
      if (!session) throw new AuthzError(AuthzErrorCode.CONFLICT, 'The term session is not available in this organization.', 409);
      if (session.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'A term cannot be activated under a closed session.', 409);
      await tx.update(academicSessions).set({ isCurrent: false }).where(eq(academicSessions.organizationId, ctx.organizationId));
      await tx.update(academicSessions).set({ isCurrent: true, status: 'ACTIVE' }).where(and(eq(academicSessions.id, session.id), eq(academicSessions.organizationId, ctx.organizationId)));
      await tx.update(terms).set({ isCurrent: false }).where(eq(terms.organizationId, ctx.organizationId));
      const rows = await tx.update(terms).set({ isCurrent: true, status: 'ACTIVE' })
        .where(and(eq(terms.id, id), eq(terms.organizationId, ctx.organizationId))).returning();
      const row = rows[0]!;
      await auditRepo.record(tx, ctx, {
        action: 'term.activate', entityType: 'term', entityId: row.id,
        before: { isCurrent: current!.isCurrent, status: current!.status },
        after: { isCurrent: row.isCurrent, status: row.status }, metadata: { requestId, sessionId: session.id },
      });
      const response = { term: { id: row.id, name: row.name, label: row.label, sessionId: row.sessionId, isCurrent: row.isCurrent, status: row.status, startsOn: row.startsOn, endsOn: row.endsOn, dueDate: row.dueDate, billed: row.billed } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
    return updated;
  },
);
