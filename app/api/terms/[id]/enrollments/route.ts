import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import * as studentRepo from '@/lib/db/repo/students';
import * as classRepo from '@/lib/db/repo/classes';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BodySchema = z.object({
  studentId: z.string().regex(UUID_RE),
  classId: z.string().regex(UUID_RE),
  enrolledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const POST = withAuthorizedRoute(
  { action: 'enrollment.manage', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id: termId } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(termId)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id.' } }, { status: 400 });
    const data = body as z.infer<typeof BodySchema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'enrollment.create', path: `/api/terms/${termId}/enrollments`, payload: { termId, ...data }, required: true,
      });
      if (idem.replay) return idem.replay;

      const term = await termRepo.lockForBilling(tx, ctx, termId as any);
      if (!term) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Term not found.', 404);
      if (term.status === 'PLANNED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Activate the term before enrolling students.', 409);
      if (term.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Closed terms cannot receive enrollments.', 409);
      if (data.enrolledOn > new Date().toISOString().slice(0, 10)) throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Enrollment date cannot be in the future.', 400);
      const student = await studentRepo.get(tx, ctx, data.studentId as any);
      if (!student) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);
      if (student.status !== 'ACTIVE') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Only active students can be enrolled.', 409);
      const schoolClass = await classRepo.get(tx, ctx, data.classId as any);
      if (!schoolClass) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Class not found.', 404);
      if (schoolClass.deletedAt) throw new AuthzError(AuthzErrorCode.CONFLICT, 'Archived classes cannot receive enrollments.', 409);
      const existingEnrollment = await enrollmentRepo.getForStudentTerm(tx, ctx, data.studentId as any, termId as any);
      if (existingEnrollment) throw new AuthzError(AuthzErrorCode.CONFLICT, 'This student already has an enrollment for the selected term; use transfer or leave.', 409);

      try {
        const enrollment = await enrollmentRepo.create(tx, ctx, { studentId: data.studentId as any, classId: data.classId as any, termId: termId as any, enrolledOn: data.enrolledOn });
        await auditRepo.record(tx, ctx, { action: 'enrollment.create', entityType: 'class_enrollment', entityId: enrollment.id, after: { studentId: enrollment.studentId, classId: enrollment.classId, termId: enrollment.termId, enrolledOn: enrollment.enrolledOn }, metadata: { requestId, termStatus: term.status } });
        const response = { enrollment: { id: enrollment.id, studentId: enrollment.studentId, classId: enrollment.classId, termId: enrollment.termId, enrolledOn: enrollment.enrolledOn, leftOn: enrollment.leftOn }, billingCandidate: term.status === 'BILLED' };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      } catch (error: any) {
        if (error?.code === '23505') throw new AuthzError(AuthzErrorCode.CONFLICT, 'This student already has an enrollment for the selected term.', 409);
        throw error;
      }
    });
  },
);
