import { NextResponse } from 'next/server';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'roster.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const student = await studentRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, student, 'Student');
    const rows = await enrollmentRepo.listForStudent(db, ctx, id as any);
    return NextResponse.json({ enrollments: rows.map((row) => ({
      id: row.id, termId: row.termId, termName: row.termName, termStatus: row.termStatus,
      classId: row.classId, className: row.className, classArm: row.classArm,
      enrolledOn: row.enrolledOn, leftOn: row.leftOn, active: row.leftOn === null,
    })) });
  },
);
