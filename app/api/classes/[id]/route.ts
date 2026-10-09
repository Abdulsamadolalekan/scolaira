import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { classes } from '@/lib/db/schema';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PatchSchema = z.object({ name: z.string().trim().min(1).max(64).optional(), arm: z.string().trim().max(16).nullable().optional(), sortOrder: z.number().int().min(-100000).max(100000).optional() });
function serialize(row: typeof classes.$inferSelect) { return { id: row.id, name: row.name, arm: row.arm, sortOrder: row.sortOrder, deletedAt: row.deletedAt, label: row.arm ? `${row.name} ${row.arm}` : row.name, createdAt: row.createdAt, updatedAt: row.updatedAt }; }

export const GET = withAuthorizedRoute(
  { action: 'class.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid class id.' } }, { status: 400 });
    const row = await classRepo.get(db, ctx, id as any); assertResourceInOrg(ctx, row, 'Class');
    return NextResponse.json({ class: serialize(row!) });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'class.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid class id.' } }, { status: 400 });
    const data = body as z.infer<typeof PatchSchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'class.update', path: `/api/classes/${id}`, payload: { id, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await classRepo.get(tx, ctx, id as any); assertResourceInOrg(ctx, existing, 'Class');
      if (existing!.deletedAt) throw new AuthzError(AuthzErrorCode.CONFLICT, 'Archived classes cannot be edited.', 409);
      try {
        const rows = await tx.update(classes).set({ name: data.name ?? existing!.name, arm: data.arm === undefined ? existing!.arm : data.arm, sortOrder: data.sortOrder ?? existing!.sortOrder }).where(and(eq(classes.id, id), eq(classes.organizationId, ctx.organizationId))).returning();
        const updated = rows[0]!;
        await auditRepo.record(tx, ctx, { action: 'class.update', entityType: 'class', entityId: updated.id, before: { name: existing!.name, arm: existing!.arm, sortOrder: existing!.sortOrder }, after: { name: updated.name, arm: updated.arm, sortOrder: updated.sortOrder }, metadata: { requestId } });
        const response = { class: serialize(updated) };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'A class with that name already exists.', 409);
        throw error;
      }
    });
  },
);
