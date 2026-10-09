import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as termRepo from '@/lib/db/repo/terms';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BodySchema = z.object({ leftOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().trim().max(500).optional() });

export const POST = withAuthorizedRoute(
  { action: 'enrollment.manage', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid enrollment id.' } }, { status: 400 });
    const data = body as z.infer<typeof BodySchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'enrollment.leave', path: `/api/enrollments/${id}/leave`, payload: { id, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await enrollmentRepo.getDetailed(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Enrollment');
      if (existing!.leftOn) {
        const response = { enrollment: existing, idempotent: true };
        await completeIdempotency(tx, ctx, idem.key, 200, response);
        return NextResponse.json(response);
      }
      const leftOn = data.leftOn ?? new Date().toISOString().slice(0, 10);
      if (leftOn < existing!.enrolledOn) throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Leave date cannot precede enrollment date.', 400);
      const term = await termRepo.lockForBilling(tx, ctx, existing!.termId as any);
      if (!term || term.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Closed terms cannot be changed.', 409);
      const row = await enrollmentRepo.leave(tx, ctx, id as any, leftOn);
      await auditRepo.record(tx, ctx, { action: 'enrollment.leave', entityType: 'class_enrollment', entityId: row.id, before: { leftOn: null }, after: { leftOn: row.leftOn }, reason: data.reason, metadata: { requestId, termId: row.termId, termStatus: term.status } });
      const response = { enrollment: { id: row.id, studentId: row.studentId, classId: row.classId, termId: row.termId, enrolledOn: row.enrolledOn, leftOn: row.leftOn } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
