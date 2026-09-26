import { NextResponse } from 'next/server';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as billingRepo from '@/lib/db/repo/billing';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuthorizedRoute(
  { action: 'roster.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id.' } }, { status: 400 });
    const term = await termRepo.get(db, ctx, id as any);
    if (!term) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Term not found.', 404);
    const [rows, summary] = await Promise.all([
      enrollmentRepo.listForTerm(db, ctx, id as any),
      enrollmentRepo.readinessSummary(db, ctx, id as any),
    ]);
    let preview: Awaited<ReturnType<typeof billingRepo.previewTerm>> | null = null;
    let previewError: { code: string; message: string } | null = null;
    try {
      preview = await billingRepo.previewTerm(db, ctx, id as any);
    } catch (error: any) {
      if (error instanceof billingRepo.BillingError) previewError = { code: error.billingCode, message: error.message };
      else throw error;
    }
    return NextResponse.json({
      term: { id: term.id, name: term.name, label: term.label, sessionId: term.sessionId, startsOn: term.startsOn, endsOn: term.endsOn, dueDate: term.dueDate, status: term.status, billed: term.billed, isCurrent: term.isCurrent },
      roster: rows.map((row) => ({
        id: row.id, studentId: row.studentId, studentCode: row.studentCode, studentName: row.studentName, studentStatus: row.studentStatus,
        classId: row.classId, className: row.className, classArm: row.classArm, classDeletedAt: row.classDeletedAt,
        enrolledOn: row.enrolledOn, leftOn: row.leftOn, active: row.leftOn === null,
      })),
      summary,
      billingReadiness: preview ? {
        ready: preview.ready,
        activeEnrollmentCount: preview.activeEnrollmentCount,
        activeAssignmentCount: preview.activeAssignmentCount,
        incompleteStudentIds: preview.incompleteStudentIds,
        blockedStudentIds: preview.blockedStudentIds,
        missingKeyCount: preview.missingKeyCount,
        toIssueKobo: preview.toIssueKobo,
      } : { ready: false, error: previewError },
    });
  },
);
