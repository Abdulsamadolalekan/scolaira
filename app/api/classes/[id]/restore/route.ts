import { NextResponse } from 'next/server';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { classes } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withAuthorizedRoute(
  { action: 'class.manage', method: 'POST', bodySchema: undefined },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid class id.' } }, { status: 400 });
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'class.restore', path: `/api/classes/${id}/restore`, payload: { id }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await classRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Class');
      if (!existing!.deletedAt) {
        const response = { class: { id: existing!.id, name: existing!.name, arm: existing!.arm, sortOrder: existing!.sortOrder, deletedAt: existing!.deletedAt }, idempotent: true };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      }

      const rows = await tx.update(classes)
        .set({ deletedAt: null })
        .where(and(eq(classes.id, id), eq(classes.organizationId, ctx.organizationId)))
        .returning();
      const restored = rows[0];
      if (!restored) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Class not found.', 404);
      await auditRepo.record(tx, ctx, {
        action: 'class.restore', entityType: 'class', entityId: restored.id,
        before: { deletedAt: existing!.deletedAt }, after: { deletedAt: null }, metadata: { requestId },
      });
      const response = { class: { id: restored.id, name: restored.name, arm: restored.arm, sortOrder: restored.sortOrder, deletedAt: restored.deletedAt } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
