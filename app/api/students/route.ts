/**
 * /api/students
 *   POST — create a student (student.create). Minimal production-grade
 *          endpoint used by E2E lifecycle tests; full student management is
 *          a later milestone.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';

const Schema = z.object({
  studentId: z.string().trim().min(1).max(32),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  middleName: z.string().trim().max(120).optional(),
  gender: z.enum(['M','F','OTHER']).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  classId: z.string().uuid().optional(),
});

export const runtime = 'nodejs';

export const POST = withAuthorizedRoute(
  { action: 'student.create', method: 'POST', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }) => {
    const data = Schema.parse(body);
    try {
      const s = await studentRepo.create(db, ctx, {
        studentId: data.studentId,
        firstName: data.firstName,
        lastName: data.lastName,
        middleName: data.middleName ?? null,
        gender: data.gender ?? null,
        dob: data.dob ?? null,
        classId: data.classId ?? null,
        status: 'ACTIVE',
      } as any);
      await auditRepo.record(db, ctx, {
        action: 'student.create', entityType: 'student', entityId: s.id,
        after: { studentId: s.studentId, name: `${s.firstName} ${s.lastName}` },
        metadata: { requestId },
      });
      return NextResponse.json({ student: s }, { status: 201 });
    } catch (e: any) {
      if (e?.code === '23505') {
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'A student with that ID already exists.', 409);
      }
      throw e;
    }
  },
);
