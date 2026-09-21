/**
 * Class list and management for M9.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { classes } from '@/lib/db/schema';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  arm: z.string().trim().max(16).nullable().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
});

function serialize(row: typeof classes.$inferSelect) {
  return { id: row.id, name: row.name, arm: row.arm, sortOrder: row.sortOrder, deletedAt: row.deletedAt, label: row.arm ? `${row.name} ${row.arm}` : row.name, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export const GET = withAuthorizedRoute(
  { action: 'class.read', method: 'GET' },
  async (req, { db, ctx }) => {
    const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';
    const where = includeArchived
      ? eq(classes.organizationId, ctx.organizationId)
      : and(eq(classes.organizationId, ctx.organizationId), isNull(classes.deletedAt));
    const rows = await db.select().from(classes).where(where).orderBy(asc(classes.sortOrder), asc(classes.name));
    return NextResponse.json({ classes: rows.map(serialize) });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'class.manage', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof CreateSchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'class.create', path: '/api/classes', payload: data, required: true,
      });
      if (idem.replay) return idem.replay;
      try {
        const created = await classRepo.create(tx, ctx, { name: data.name, arm: data.arm ?? null, sortOrder: data.sortOrder, deletedAt: null });
        await auditRepo.record(tx, ctx, { action: 'class.create', entityType: 'class', entityId: created.id, after: { name: created.name, arm: created.arm, sortOrder: created.sortOrder }, metadata: { requestId } });
        const response = { class: serialize(created) };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'A class with that name already exists.', 409);
        throw error;
      }
    });
  },
);
