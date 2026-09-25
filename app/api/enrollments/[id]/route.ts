import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as classRepo from '@/lib/db/repo/classes';
import * as termRepo from '@/lib/db/repo/terms';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PatchSchema = z.object({ classId: z.string().regex(UUID_RE), enrolledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const GET = withAuthorizedRoute(
  { action: 'roster.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid enrollment id.' } }, { status: 400 });
    const row = await enrollmentRepo.getDetailed(db, ctx, id as any);
    assertResourceInOrg(ctx, row, 'Enrollment');
    return NextResponse.json({ enrollment: row });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'enrollment.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid enrollment id.' } }, { status: 400 });
    const data = body as z.infer<typeof PatchSchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'enrollment.transfer', path: `/api/enrollments/${id}`, payload: { id, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;
      const existing = await enrollmentRepo.getDetailed(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Enrollment');
      if (existing!.termStatus !== 'ACTIVE') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Class transfers are allowed only before a term is billed.', 409);
      if (existing!.leftOn) throw new AuthzError(AuthzErrorCode.CONFLICT, 'A departed enrollment cannot be transferred; create a new term enrollment instead.', 409);
      const targetClass = await classRepo.get(tx, ctx, data.classId as any);
      if (!targetClass) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Class not found.', 404);
      if (targetClass.deletedAt) throw new AuthzError(AuthzErrorCode.CONFLICT, 'Archived classes cannot receive enrollments.', 409);
      if (data.enrolledOn && data.enrolledOn > new Date().toISOString().slice(0, 10)) throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Enrollment date cannot be in the future.', 400);
      const term = await termRepo.lockForBilling(tx, ctx, existing!.termId as any);
      if (!term || term.status !== 'ACTIVE') throw new AuthzError(AuthzErrorCode.CONFLICT, 'The term changed state; retry the roster action.', 409);
      const row = await enrollmentRepo.updateClass(tx, ctx, id as any, { classId: data.classId as any, enrolledOn: data.enrolledOn });
      await auditRepo.record(tx, ctx, { action: 'enrollment.transfer', entityType: 'class_enrollment', entityId: row.id, before: { classId: existing!.classId, enrolledOn: existing!.enrolledOn }, after: { classId: row.classId, enrolledOn: row.enrolledOn }, metadata: { requestId, termId: row.termId } });
      const response = { enrollment: { id: row.id, studentId: row.studentId, classId: row.classId, termId: row.termId, enrolledOn: row.enrolledOn, leftOn: row.leftOn } };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
