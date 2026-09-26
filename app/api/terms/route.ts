/**
 * Term list and planned-term creation for M9.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { terms } from '@/lib/db/schema';

export const runtime = 'nodejs';
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const CreateSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(8),
  startsOn: DateSchema,
  endsOn: DateSchema.nullable().optional(),
  dueDate: DateSchema.nullable().optional(),
});

function serialize(t: typeof terms.$inferSelect) {
  return {
    id: t.id, name: t.name, label: t.label, sessionId: t.sessionId,
    isCurrent: t.isCurrent, startsOn: t.startsOn, endsOn: t.endsOn, dueDate: t.dueDate,
    billed: t.billed, billedAt: t.billedAt, billedBy: t.billedBy, status: t.status,
  };
}

export const GET = withAuthorizedRoute(
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await termRepo.listForOrg(db, ctx);
    rows.sort((a, b) => `${a.startsOn}:${a.name}`.localeCompare(`${b.startsOn}:${b.name}`));
    return NextResponse.json({ terms: rows.map(serialize) });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'term.manage', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof CreateSchema>;
    if (data.endsOn && data.endsOn < data.startsOn) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Term end date cannot precede its start date.', 400);
    }
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'term.create', path: '/api/terms', payload: data, required: true,
      });
      if (idem.replay) return idem.replay;

      const session = await sessionRepo.get(tx, ctx, data.sessionId as any);
      if (!session) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Academic session not found.', 404);
      if (session.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Terms cannot be added to a closed session.', 409);
      try {
        const created = await termRepo.create(tx, ctx, {
          sessionId: data.sessionId as any, name: data.name, label: data.label,
          startsOn: data.startsOn, endsOn: data.endsOn ?? null, dueDate: data.dueDate ?? null,
          isCurrent: false, billed: false, status: 'PLANNED',
        });
        await auditRepo.record(tx, ctx, {
          action: 'term.create', entityType: 'term', entityId: created.id,
          after: { name: created.name, label: created.label, sessionId: created.sessionId, startsOn: created.startsOn, endsOn: created.endsOn, status: created.status },
          metadata: { requestId },
        });
        const response = { term: serialize(created) };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'A term with that name already exists in this session.', 409);
        throw error;
      }
    });
  },
);
