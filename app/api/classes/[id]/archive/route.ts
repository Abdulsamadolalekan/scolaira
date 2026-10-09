import { NextResponse } from 'next/server';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { classes, classEnrollments, terms } from '@/lib/db/schema';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'class.manage', method: 'POST', bodySchema: undefined },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid class id.' } }, { status: 400 });
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'class.archive', path: `/api/classes/${id}/archive`, payload: { id }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await classRepo.get(tx, ctx, id as any); assertResourceInOrg(ctx, existing, 'Class');
      if (existing!.deletedAt) {
        const response = { class: { id: existing!.id, name: existing!.name, arm: existing!.arm, sortOrder: existing!.sortOrder, deletedAt: existing!.deletedAt }, idempotent: true };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      }
      const active = await tx.select({ id: classEnrollments.id }).from(classEnrollments).innerJoin(terms, eq(terms.id, classEnrollments.termId)).where(and(eq(classEnrollments.organizationId, ctx.organizationId), eq(classEnrollments.classId, id), isNull(classEnrollments.leftOn), ne(terms.status, 'CLOSED'))).limit(1);
      if (active.length > 0) throw new AuthzError(AuthzErrorCode.CONFLICT, 'Move or leave active enrollments before archiving this class.', 409);
      const rows = await tx.update(classes).set({ deletedAt: new Date() }).where(and(eq(classes.id, id), eq(classes.organizationId, ctx.organizationId), isNull(classes.deletedAt))).returning();
      const archived = rows[0]!;
      await auditRepo.record(tx, ctx, { action: 'class.archive', entityType: 'class', entityId: archived.id, before: { deletedAt: null }, after: { deletedAt: archived.deletedAt }, metadata: { requestId } });
      const response = { class: { id: archived.id, name: archived.name, arm: archived.arm, sortOrder: archived.sortOrder, deletedAt: archived.deletedAt } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
