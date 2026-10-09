import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { terms } from '@/lib/db/schema';
import * as termRepo from '@/lib/db/repo/terms';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  label: z.string().trim().min(1).max(8).optional(),
  startsOn: DateSchema.optional(),
  endsOn: DateSchema.nullable().optional(),
  dueDate: DateSchema.nullable().optional(),
});

function serialize(t: typeof terms.$inferSelect) {
  return { id: t.id, name: t.name, label: t.label, sessionId: t.sessionId, isCurrent: t.isCurrent, startsOn: t.startsOn, endsOn: t.endsOn, dueDate: t.dueDate, billed: t.billed, billedAt: t.billedAt, billedBy: t.billedBy, status: t.status };
}

export const GET = withAuthorizedRoute(
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id.' } }, { status: 400 });
    const term = await termRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, term, 'Term');
    return NextResponse.json({ term: serialize(term!) });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'term.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id.' } }, { status: 400 });
    const data = body as z.infer<typeof PatchSchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'term.update', path: `/api/terms/${id}`, payload: { id, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await termRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Term');
      if (existing!.status !== 'PLANNED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Only planned terms can be edited.', 409);
      const startsOn = data.startsOn ?? existing!.startsOn;
      const endsOn = data.endsOn === undefined ? existing!.endsOn : data.endsOn;
      if (endsOn && endsOn < startsOn) throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Term end date cannot precede its start date.', 400);
      try {
        const rows = await tx.update(terms).set({
          name: data.name ?? existing!.name,
          label: data.label ?? existing!.label,
          startsOn,
          endsOn,
          dueDate: data.dueDate === undefined ? existing!.dueDate : data.dueDate,
        }).where(and(eq(terms.id, id), eq(terms.organizationId, ctx.organizationId))).returning();
        const updated = rows[0]!;
        await auditRepo.record(tx, ctx, {
          action: 'term.update', entityType: 'term', entityId: updated.id,
          before: { name: existing!.name, label: existing!.label, startsOn: existing!.startsOn, endsOn: existing!.endsOn, dueDate: existing!.dueDate },
          after: { name: updated.name, label: updated.label, startsOn: updated.startsOn, endsOn: updated.endsOn, dueDate: updated.dueDate },
          metadata: { requestId },
        });
        const response = { term: serialize(updated) };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'A term with that name already exists in this session.', 409);
        throw error;
      }
    });
  },
);
