// @vitest-environment node
/**
 * M9 route-boundary and workflow tests: real authenticated sessions, CSRF,
 * tenant scoping, durable idempotency, and the session → term → class →
 * student → enrollment → roster handoff into M8.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CookieJar, call } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrgPost } from '@/app/api/auth/select-organization/route';
import { GET as sessionListGet, POST as sessionCreatePost } from '@/app/api/academic-sessions/route';
import { POST as sessionActivatePost } from '@/app/api/academic-sessions/[id]/activate/route';
import { GET as termListGet, POST as termCreatePost } from '@/app/api/terms/route';
import { POST as termActivatePost } from '@/app/api/terms/[id]/activate/route';
import { POST as classCreatePost } from '@/app/api/classes/route';
import { POST as classArchivePost } from '@/app/api/classes/[id]/archive/route';
import { POST as classRestorePost } from '@/app/api/classes/[id]/restore/route';
import { GET as rosterGet } from '@/app/api/terms/[id]/roster/route';
import { POST as termEnrollmentCreatePost } from '@/app/api/terms/[id]/enrollments/route';
import { POST as studentCreatePost, GET as studentListGet } from '@/app/api/students/route';
import { POST as studentArchivePost } from '@/app/api/students/[id]/archive/route';
import { POST as studentRestorePost } from '@/app/api/students/[id]/restore/route';
import { GET as studentEnrollmentsGet } from '@/app/api/students/[id]/enrollments/route';
import { PATCH as enrollmentTransferPatch } from '@/app/api/enrollments/[id]/route';
import { POST as enrollmentLeavePost } from '@/app/api/enrollments/[id]/leave/route';
import { auditEvents, organizationMembers, invoices, payments, receipts } from '@/lib/db/schema';
import { withSystemContext, withTenant } from '@/lib/db/tenant';
import { getSql } from '@/lib/db';
import { disableSavepointTransactionsForTest, enableSavepointTransactionsForTest } from '../setup-db';

interface Actor { jar: CookieJar; orgId: string; userId: string; role: string; }

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function password(): string { return `Pass-${Math.random().toString(36).slice(2, 10)}-A1!`; }

async function registerActor(firstName: string, targetOrg?: string, role?: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF'): Promise<Actor> {
  const jar = new CookieJar();
  const registration = await call(registerPost as any, jar, {
    method: 'POST', path: '/api/auth/register',
    body: {
      email: `${unique(firstName).toLowerCase()}@m9.example`, password: password(),
      firstName, lastName: 'M9', organizationName: `M9 ${firstName}`, organizationSlug: unique(firstName).toLowerCase(),
    },
  });
  expect(registration.status).toBe(201);
  const me = await call(meGet as any, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const ownOrg = me.data.activeOrganizationId as string;
  const userId = me.data.user.id as string;
  if (targetOrg && role) {
    await withSystemContext(null, null, async (db) => {
      await db.insert(organizationMembers).values({
        organizationId: targetOrg, userId, role, status: 'ACTIVE',
        joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      } as any);
    });
    const selected = await call(selectOrgPost as any, jar, {
      method: 'POST', path: '/api/auth/select-organization', body: { organizationId: targetOrg }, csrf: true,
    });
    expect(selected.status).toBe(200);
  }
  const after = await call(meGet as any, jar, { method: 'GET', path: '/api/auth/me' });
  return { jar, orgId: after.data.activeOrganizationId ?? ownOrg, userId, role: after.data.activeRole ?? role ?? 'OWNER' };
}

function dynamic(handler: Function, actor: Actor, method: string, path: string, id: string, body?: unknown, headers?: HeadersInit, csrf = true) {
  return call(handler as any, actor.jar, { method, path, body, headers, csrf, args: [{ params: Promise.resolve({ id }) }] });
}

describe('M9 academic route boundary', () => {
  let owner: Actor;
  let finance: Actor;
  let foreign: Actor;

  beforeEach(() => enableSavepointTransactionsForTest());
  afterEach(() => disableSavepointTransactionsForTest());

  beforeAll(async () => {
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerActor('M9Owner');
    finance = await registerActor('M9Finance', owner.orgId, 'FINANCE_OFFICER');
    foreign = await registerActor('M9Foreign');
  }, 60000);

  it('executes the controlled academic workflow without financial side effects', async () => {
    const sessionBody = { name: unique('2026-2027'), startsOn: '2026-09-01', endsOn: '2027-07-31' };
    const sessionKey = unique('session-key');
    const createdSession = await call(sessionCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/academic-sessions', body: sessionBody,
      headers: { 'idempotency-key': sessionKey }, csrf: true,
    });
    expect(createdSession.status).toBe(201);
    const sessionId = createdSession.data.session.id as string;
    const sessionReplay = await call(sessionCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/academic-sessions', body: sessionBody,
      headers: { 'idempotency-key': sessionKey }, csrf: true,
    });
    expect(sessionReplay.status).toBe(201);
    expect(sessionReplay.response.headers.get('idempotent-replayed')).toBe('true');
    expect(sessionReplay.data.session.id).toBe(sessionId);

    const activatedSession = await dynamic(sessionActivatePost, owner, 'POST', `/api/academic-sessions/${sessionId}/activate`, sessionId, {}, { 'idempotency-key': unique('session-activate') });
    expect(activatedSession.status).toBe(200);

    const termBody = { sessionId, name: 'First Term', label: '1st', startsOn: '2026-09-01', endsOn: '2026-12-18', dueDate: '2026-10-01' };
    const createdTerm = await call(termCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/terms', body: termBody, headers: { 'idempotency-key': unique('term-key') }, csrf: true,
    });
    expect(createdTerm.status).toBe(201);
    const termId = createdTerm.data.term.id as string;
    const activatedTerm = await dynamic(termActivatePost, owner, 'POST', `/api/terms/${termId}/activate`, termId, {}, { 'idempotency-key': unique('term-activate') });
    expect(activatedTerm.status).toBe(200);

    const classOne = await call(classCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/classes', body: { name: unique('JSS1'), arm: 'A', sortOrder: 1 }, headers: { 'idempotency-key': unique('class-key') }, csrf: true,
    });
    const classTwo = await call(classCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/classes', body: { name: unique('JSS1'), arm: 'B', sortOrder: 2 }, headers: { 'idempotency-key': unique('class-key') }, csrf: true,
    });
    expect(classOne.status).toBe(201);
    expect(classTwo.status).toBe(201);
    const classOneId = classOne.data.class.id as string;
    const classTwoId = classTwo.data.class.id as string;

    const admissionBody = {
      studentId: unique('STU'), firstName: 'Ada', lastName: 'M9',
      initialEnrollment: { termId, classId: classOneId, enrolledOn: '2026-09-01' },
    };
    const admissionKey = unique('admission-key');
    const admitted = await call(studentCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/students', body: admissionBody,
      headers: { 'idempotency-key': admissionKey }, csrf: true,
    });
    expect(admitted.status).toBe(201);
    const studentId = admitted.data.student.id as string;
    const enrollmentId = admitted.data.enrollment.id as string;
    const admissionReplay = await call(studentCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/students', body: admissionBody,
      headers: { 'idempotency-key': admissionKey }, csrf: true,
    });
    expect(admissionReplay.status).toBe(201);
    expect(admissionReplay.response.headers.get('idempotent-replayed')).toBe('true');
    expect(admissionReplay.data.student.id).toBe(studentId);

    const financialCounts = await withTenant({ organizationId: owner.orgId, userId: owner.userId }, async (db) => {
      const [invoiceRows, paymentRows, receiptRows] = await Promise.all([
        db.select({ id: invoices.id }).from(invoices),
        db.select({ id: payments.id }).from(payments),
        db.select({ id: receipts.id }).from(receipts),
      ]);
      return { invoices: invoiceRows.length, payments: paymentRows.length, receipts: receiptRows.length };
    });
    expect(financialCounts).toEqual({ invoices: 0, payments: 0, receipts: 0 });

    const roster = await dynamic(rosterGet, owner, 'GET', `/api/terms/${termId}/roster`, termId, undefined, undefined, false);
    expect(roster.status).toBe(200);
    expect(roster.data.roster).toHaveLength(1);
    expect(roster.data.summary.activeEnrollmentCount).toBe(1);
    expect(roster.data.billingReadiness.ready).toBe(false);

    const directoryStudent = await call(studentCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/students', body: { studentId: unique('STU-DIR'), firstName: 'Grace', lastName: 'M9' },
      headers: { 'idempotency-key': unique('directory-student') }, csrf: true,
    });
    expect(directoryStudent.status).toBe(201);
    const existingEnrollmentKey = unique('existing-enrollment');
    const existingEnrollment = await dynamic(termEnrollmentCreatePost, owner, 'POST', `/api/terms/${termId}/enrollments`, termId, {
      studentId: directoryStudent.data.student.id, classId: classOneId, enrolledOn: '2026-09-10',
    }, { 'idempotency-key': existingEnrollmentKey });
    expect(existingEnrollment.status).toBe(201);
    const existingEnrollmentReplay = await dynamic(termEnrollmentCreatePost, owner, 'POST', `/api/terms/${termId}/enrollments`, termId, {
      studentId: directoryStudent.data.student.id, classId: classOneId, enrolledOn: '2026-09-10',
    }, { 'idempotency-key': existingEnrollmentKey });
    expect(existingEnrollmentReplay.status).toBe(201);
    expect(existingEnrollmentReplay.response.headers.get('idempotent-replayed')).toBe('true');
    const financeRoster = await dynamic(rosterGet, finance, 'GET', `/api/terms/${termId}/roster`, termId, undefined, undefined, false);
    expect(financeRoster.status).toBe(200);
    const financeMutation = await call(sessionCreatePost as any, finance.jar, {
      method: 'POST', path: '/api/academic-sessions', body: { name: unique('denied'), startsOn: '2027-09-01' }, csrf: true,
    });
    expect(financeMutation.status).toBe(403);
    const csrfFailure = await call(classCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/classes', body: { name: unique('csrf') }, csrf: false,
    });
    expect(csrfFailure.status).toBe(403);
    const missingKey = await call(classCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/classes', body: { name: unique('missing-key') }, csrf: true,
    });
    expect(missingKey.status).toBe(400);
    expect(missingKey.data.error.code).toBe('BAD_REQUEST');
    expect(missingKey.data.error.message).toMatch(/Idempotency-Key/);

    const transferKey = unique('transfer-key');
    const transferred = await dynamic(enrollmentTransferPatch, owner, 'PATCH', `/api/enrollments/${enrollmentId}`, enrollmentId, { classId: classTwoId }, { 'idempotency-key': transferKey });
    expect(transferred.status).toBe(200);
    expect(transferred.data.enrollment.classId).toBe(classTwoId);
    const transferReplay = await dynamic(enrollmentTransferPatch, owner, 'PATCH', `/api/enrollments/${enrollmentId}`, enrollmentId, { classId: classTwoId }, { 'idempotency-key': transferKey });
    expect(transferReplay.status).toBe(200);
    expect(transferReplay.response.headers.get('idempotent-replayed')).toBe('true');

    // The class still has an active enrollment, so archive is refused by the
    // academic guard rather than silently changing the roster.
    const archiveBlocked = await dynamic(classArchivePost, owner, 'POST', `/api/classes/${classTwoId}/archive`, classTwoId, {}, { 'idempotency-key': unique('archive') });
    expect(archiveBlocked.status).toBe(409);

    const leaveKey = unique('leave-key');
    const left = await dynamic(enrollmentLeavePost, owner, 'POST', `/api/enrollments/${enrollmentId}/leave`, enrollmentId, { leftOn: '2026-09-20', reason: 'Transfer out' }, { 'idempotency-key': leaveKey });
    expect(left.status).toBe(200);
    const leaveReplay = await dynamic(enrollmentLeavePost, owner, 'POST', `/api/enrollments/${enrollmentId}/leave`, enrollmentId, { leftOn: '2026-09-20', reason: 'Transfer out' }, { 'idempotency-key': leaveKey });
    expect(leaveReplay.status).toBe(200);
    expect(leaveReplay.response.headers.get('idempotent-replayed')).toBe('true');

    const archived = await dynamic(classArchivePost, owner, 'POST', `/api/classes/${classTwoId}/archive`, classTwoId, {}, { 'idempotency-key': unique('archive') });
    expect(archived.status).toBe(200);
    const restoredClass = await dynamic(classRestorePost, owner, 'POST', `/api/classes/${classTwoId}/restore`, classTwoId, {}, { 'idempotency-key': unique('restore') });
    expect(restoredClass.status).toBe(200);

    const history = await dynamic(studentEnrollmentsGet, owner, 'GET', `/api/students/${studentId}/enrollments`, studentId, undefined, undefined, false);
    expect(history.status).toBe(200);
    expect(history.data.enrollments).toHaveLength(1);
    expect(history.data.enrollments[0].leftOn).toBe('2026-09-20');

    const archivedStudent = await dynamic(studentArchivePost, owner, 'POST', `/api/students/${studentId}/archive`, studentId, { reason: 'Withdrawn' }, { 'idempotency-key': unique('student-archive') });
    expect(archivedStudent.status).toBe(200);
    const restoredStudent = await dynamic(studentRestorePost, owner, 'POST', `/api/students/${studentId}/restore`, studentId, {}, { 'idempotency-key': unique('student-restore') });
    expect(restoredStudent.status).toBe(200);

    // Archiving an admitted student closes its open academic enrollment in the
    // same transaction, without restoring that enrollment on student restore.
    const autoClosedStudent = await dynamic(studentArchivePost, owner, 'POST', `/api/students/${directoryStudent.data.student.id}/archive`, directoryStudent.data.student.id, { reason: 'Withdrawn by guardian' }, { 'idempotency-key': unique('auto-close-student') });
    expect(autoClosedStudent.status).toBe(200);
    const autoClosedHistory = await dynamic(studentEnrollmentsGet, owner, 'GET', `/api/students/${directoryStudent.data.student.id}/enrollments`, directoryStudent.data.student.id, undefined, undefined, false);
    expect(autoClosedHistory.status).toBe(200);
    expect(autoClosedHistory.data.enrollments[0].leftOn).toBeTruthy();

    const plannedTerm = await call(termCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/terms', body: { ...termBody, name: 'Second Term', label: '2nd', startsOn: '2027-01-05', endsOn: '2027-04-01' }, headers: { 'idempotency-key': unique('planned-term') }, csrf: true,
    });
    expect(plannedTerm.status).toBe(201);
    const beforeFailedAdmission = await call(studentListGet as any, owner.jar, { method: 'GET', path: '/api/students' });
    const failedAdmission = await call(studentCreatePost as any, owner.jar, {
      method: 'POST', path: '/api/students',
      body: { studentId: unique('ROLLBACK'), firstName: 'Should', lastName: 'Rollback', initialEnrollment: { termId: plannedTerm.data.term.id, classId: classOneId, enrolledOn: '2026-09-21' } },
      headers: { 'idempotency-key': unique('failed-admission') }, csrf: true,
    });
    expect(failedAdmission.status).toBe(409);
    const afterFailedAdmission = await call(studentListGet as any, owner.jar, { method: 'GET', path: '/api/students' });
    expect(afterFailedAdmission.data.students).toHaveLength(beforeFailedAdmission.data.students.length);

    const foreignRoster = await dynamic(rosterGet, foreign, 'GET', `/api/terms/${termId}/roster`, termId, undefined, undefined, false);
    expect(foreignRoster.status).toBe(404);

    const auditActions = await withTenant({ organizationId: owner.orgId, userId: owner.userId }, async (db) => {
      const rows = await db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.organizationId, owner.orgId));
      return new Set(rows.map((row) => row.action));
    });
    for (const action of [
      'academic_session.create', 'academic_session.activate', 'term.create', 'term.activate',
      'class.create', 'class.archive', 'class.restore', 'student.create', 'student.archive',
      'student.restore', 'enrollment.create', 'enrollment.transfer', 'enrollment.leave',
    ]) expect(auditActions.has(action as any)).toBe(true);

    const sessions = await call(sessionListGet as any, owner.jar, { method: 'GET', path: '/api/academic-sessions' });
    const terms = await call(termListGet as any, owner.jar, { method: 'GET', path: '/api/terms' });
    expect(sessions.status).toBe(200);
    expect(terms.status).toBe(200);
    expect(sessions.data.sessions.filter((row: any) => row.isCurrent)).toHaveLength(1);
    expect(terms.data.terms.filter((row: any) => row.isCurrent)).toHaveLength(1);

    const financialAfter = await withTenant({ organizationId: owner.orgId, userId: owner.userId }, async (db) => {
      const [invoiceRows, paymentRows, receiptRows] = await Promise.all([
        db.select({ id: invoices.id }).from(invoices),
        db.select({ id: payments.id }).from(payments),
        db.select({ id: receipts.id }).from(receipts),
      ]);
      return { invoices: invoiceRows.length, payments: paymentRows.length, receipts: receiptRows.length };
    });
    expect(financialAfter).toEqual({ invoices: 0, payments: 0, receipts: 0 });
  }, 60000);
});
