// @vitest-environment node
/**
 * Phase 1 — onboarding and CSV import routes, HTTP contract.
 *
 * The planner is covered by pure tests and the transaction by the database tests.
 * This suite proves the PRODUCT SURFACE a school actually touches:
 *
 *   · who may call the endpoints (authentication, permission, CSRF, tenant);
 *   · what the validate endpoint refuses before anything is written;
 *   · that validate WRITES NOTHING — the property the whole review step rests on;
 *   · that a commit with a changed file, a stale plan hash, or unacknowledged
 *     warnings is refused;
 *   · that a repeated commit with the same Idempotency-Key imports once, which is
 *     what stops a double tap on a slow connection from billing a child twice;
 *   · that the status endpoint reports progress from real rows and never claims a
 *     step is done that is not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrganizationPost } from '@/app/api/auth/select-organization/route';
import { GET as statusGet } from '@/app/api/onboarding/status/route';
import { POST as validatePost } from '@/app/api/onboarding/students/import/validate/route';
import { POST as commitPost } from '@/app/api/onboarding/students/import/commit/route';
import { POST as recordPost } from '@/app/api/opening-balances/route';
import { POST as reviewPost } from '@/app/api/opening-balances/[id]/review/route';
import { getSql } from '@/lib/db';
import {
  enableSavepointTransactionsForTest,
  disableSavepointTransactionsForTest,
} from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function key(): string {
  return randomUUID();
}

const HEAD =
  'Adm No,First Name,Last Name,Sex,DOB,Class,Parent Name,Parent Phone,Relationship,Primary';

interface School {
  jar: CookieJar;
  ctx: TenantCtx;
  termId: UUID;
  classId: UUID;
}

/** A school signed in as its owner, with an ACTIVE term and one class. */
async function newSchool(): Promise<School> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('ob').toLowerCase()}@example.test`,
      password: 'Onboarding-route-password-A1!',
      firstName: 'O',
      lastName: 'Owner',
      organizationName: unique('O School'),
      organizationSlug: unique('o-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const organizationId = me.data.activeOrganizationId as UUID;
  const userId = me.data.user.id as UUID;

  const sessionId = randomUUID();
  const termId = randomUUID();
  const classId = randomUUID();
  await withSystemContext(organizationId, userId, async () => {
    const sql = getSql();
    await sql`INSERT INTO academic_sessions (id, name, starts_on, ends_on, is_current, status)
              VALUES (${sessionId}::uuid, '2026/2027', '2026-09-01', '2027-07-31', true, 'ACTIVE')`;
    // ACTIVE, so the importer may enrol into it.
    await sql`INSERT INTO terms (id, session_id, name, label, starts_on, ends_on, due_date, is_current, status)
              VALUES (${termId}::uuid, ${sessionId}::uuid, 'First Term', '1st', '2026-09-08', '2026-12-15', '2026-12-01', true, 'ACTIVE')`;
    await sql`INSERT INTO classes (id, name, sort_order) VALUES (${classId}::uuid, 'Primary 4', 0)`;
  });

  await getSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  return { jar, ctx: { organizationId, userId }, termId: termId as UUID, classId: classId as UUID };
}

/** A STAFF member of the same school — signed in, but without student.create. */
async function staffSessionFor(ctx: TenantCtx): Promise<CookieJar> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('ob-staff').toLowerCase()}@example.test`,
      password: 'Onboarding-staff-password-A1!',
      firstName: 'O',
      lastName: 'Staff',
      organizationName: unique('O Staff School'),
      organizationSlug: unique('o-staff-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  const userId = me.data.user.id as UUID;
  await withSystemContext(null, null, async () => {
    const sql = getSql();
    await sql`INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at)
              VALUES (${randomUUID()}::uuid, ${ctx.organizationId}::uuid, ${userId}::uuid, 'STAFF', 'ACTIVE', now())`;
  });
  const selected = await call(selectOrganizationPost as never, jar, {
    method: 'POST',
    path: '/api/auth/select-organization',
    body: { organizationId: ctx.organizationId },
    csrf: true,
  });
  expect(selected.status).toBe(200);
  return jar;
}

function csv(rows: string[]): string {
  return [HEAD, ...rows].join('\n');
}

/** One child on the roll, written the way the roster writes one. */
async function admitStudent(school: School): Promise<string> {
  const tag = unique('ob-carry');
  await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
    await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                  VALUES (${tag}, 'Carry', 'Child', 'ACTIVE')`;
  });
  await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
  const rows =
    (await getSql()`SELECT id FROM students WHERE student_id = ${tag}`) as unknown as Array<{
      id: string;
    }>;
  return rows[0]!.id;
}

/**
 * Read the school's own rows through RLS.
 *
 * A route resets the tenant GUCs when it finishes, so a raw read straight after a
 * request sees nothing at all — which is correct behaviour, and a trap worth
 * naming here rather than debugging later.
 */
async function counts(ctx: TenantCtx): Promise<{
  students: number;
  links: number;
  enrollments: number;
  guardians: number;
}> {
  await getSql()`SELECT set_tenant_context(${ctx.organizationId}::uuid, ${ctx.userId}::uuid)`;
  const rows = (await getSql()`
    SELECT (SELECT count(*)::int FROM students WHERE organization_id = ${ctx.organizationId}::uuid) AS students,
           (SELECT count(*)::int FROM student_guardians WHERE organization_id = ${ctx.organizationId}::uuid) AS links,
           (SELECT count(*)::int FROM class_enrollments WHERE organization_id = ${ctx.organizationId}::uuid) AS enrollments,
           (SELECT count(*)::int FROM guardians WHERE organization_id = ${ctx.organizationId}::uuid) AS guardians
  `) as unknown as Array<{
    students: number;
    links: number;
    enrollments: number;
    guardians: number;
  }>;
  return rows[0]!;
}

describe('Phase 1 — onboarding routes', () => {
  beforeEach(() => enableSavepointTransactionsForTest());
  afterEach(() => disableSavepointTransactionsForTest());

  // ── Authentication and authorization ────────────────────────────────────

  it('reports the carry-in step from the register, never from a flag', async () => {
    const school = await newSchool();
    const before = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    expect(before.status).toBe(200);
    const step = (before.data.steps as Array<{ key: string; done: boolean; detail: string }>).find(
      (s2) => s2.key === 'balances',
    );
    // An empty register is NOT reported as done: that is what a missed carry-in
    // looks like, and a tick would hide it.
    expect(step).toBeTruthy();
    expect(step!.done).toBe(false);
    expect(step!.detail).toMatch(/Nothing carried in yet/i);
    expect(before.data.openingBalances).toEqual({
      count: 0,
      pendingReviewCount: 0,
      pendingPostCount: 0,
      approvedNotPostedCount: 0,
      outstandingKobo: 0,
      hasPriorTerm: false,
    });

    // A recorded figure makes the step say what is waiting, without any writes to
    // the ledger.
    const recorded = await call(recordPost as never, school.jar, {
      method: 'POST',
      path: '/api/opening-balances',
      csrf: true,
      body: {
        studentId: await admitStudent(school),
        category: 'HISTORICAL_BALANCE',
        amountKobo: 45_000_000,
        asAt: '2026-06-30',
        sourceNote: 'Old receipt book, page 14',
      },
    });
    expect(recorded.status, JSON.stringify(recorded.data)).toBe(201);

    const after = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    const afterStep = (
      after.data.steps as Array<{ key: string; done: boolean; detail: string }>
    ).find((s2) => s2.key === 'balances');
    expect(afterStep!.done).toBe(false);
    expect(afterStep!.detail).toMatch(/waiting to be approved/i);
    expect(after.data.openingBalances.count).toBe(1);
    expect(after.data.openingBalances.pendingReviewCount).toBe(1);

    // Approving it does NOT finish the step. This school has no past term to post
    // into, so `pendingPostCount` — which counts only what the ledger could take
    // today — is zero, and a guide built on that number alone would say the register
    // was "reviewed and posted". It was not: an approved figure is standing outside
    // the ledger, and the guide has to keep saying so until it is either posted or
    // rejected. This pins the false claim `approvedNotPostedCount` exists to prevent.
    const obId = (recorded.data as { openingBalance: { id: string } }).openingBalance.id;
    const approved = await call(reviewPost as never, school.jar, {
      method: 'POST',
      path: `/api/opening-balances/${obId}/review`,
      args: [{ params: Promise.resolve({ id: obId }) }],
      body: { decision: 'APPROVE', note: 'Checked against the receipt book' },
      csrf: true,
    });
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);

    const blocked = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    const blockedStep = (
      blocked.data.steps as Array<{ key: string; done: boolean; detail: string }>
    ).find((s2) => s2.key === 'balances');
    expect(blockedStep!.done).toBe(false);
    expect(blockedStep!.detail).toMatch(/approved figure.*not yet posted/i);
    expect(blocked.data.openingBalances.pendingPostCount).toBe(0);
    expect(blocked.data.openingBalances.approvedNotPostedCount).toBe(1);
  });

  it('refuses an unauthenticated status read', async () => {
    const jar = new CookieJar();
    const res = await call(statusGet as never, jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    expect(res.status).toBe(401);
  });

  it('refuses an unauthenticated validate', async () => {
    const jar = new CookieJar();
    const res = await call(validatePost as never, jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: randomUUID(),
      },
      csrf: true,
    });
    expect(res.status).toBe(401);
  });

  it('refuses a validate without the CSRF token', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
      },
      csrf: false,
    });
    expect([403, 400]).toContain(res.status);
  });

  it('refuses a STAFF role — the import needs student.create', async () => {
    const school = await newSchool();
    const staff = await staffSessionFor(school.ctx);
    const res = await call(validatePost as never, staff, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
      },
      csrf: true,
    });
    expect(res.status).toBe(403);
  });

  it('refuses a STAFF role on commit too', async () => {
    const school = await newSchool();
    const staff = await staffSessionFor(school.ctx);
    const res = await call(commitPost as never, staff, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
        planHash: 'x',
        acknowledgedWarnings: true,
      },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    expect(res.status).toBe(403);
  });

  // ── The status endpoint tells the truth ─────────────────────────────────

  it('reports a fresh school as incomplete, with school done and the rest not', async () => {
    const school = await newSchool();
    const res = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    expect(res.status).toBe(200);
    const steps = res.data.steps as Array<{ key: string; done: boolean }>;
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.done]));
    expect(byKey.school).toBe(true);
    expect(byKey.session).toBe(true); // the fixture created a session
    expect(byKey.term).toBe(true); // ...and a term, which is ACTIVE
    expect(byKey.classes).toBe(true); // ...and a class
    expect(byKey.students).toBe(false); // ...but no students
    expect(res.data.readyToBill).toBe(false);
    expect(res.data.nextStep).toBe('students');
  });

  it('reports students complete once real students exist', async () => {
    const school = await newSchool();
    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                    VALUES ('OB-STATUS-1', 'Status', 'Child', 'ACTIVE')`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;

    const res = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    const steps = res.data.steps as Array<{ key: string; done: boolean }>;
    expect(steps.find((s) => s.key === 'students')!.done).toBe(true);
    expect(res.data.readyToBill).toBe(true);
  });

  it('does not hold the guide finish line behind the carry-in register', async () => {
    // The gap this pins: a school that can already bill, but has carried nothing in,
    // must still reach the end of the guide. Making a bursar hunt for a debt they may
    // not have before the finish line appears would push them to invent a figure to
    // escape the setup flow — the one outcome an opening-balance feature must never
    // cause. The step still reports the truth (not done, and worded as a prompt), so
    // a missed balance is never hidden; it simply does not gate billing.
    const school = await newSchool();
    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                    VALUES ('OB-NO-CARRY', 'Debtless', 'Child', 'ACTIVE')`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;

    const res = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    expect(res.status).toBe(200);
    const steps = res.data.steps as Array<{ key: string; done: boolean; detail: string }>;
    const balances = steps.find((s) => s.key === 'balances')!;
    expect(balances.done).toBe(false);
    expect(balances.detail).toMatch(/Nothing carried in yet/i);
    expect(res.data.readyToBill).toBe(true);
    expect(res.data.nextStep).toBe('ready');
  });

  it('reopens the students step when the roll is emptied — progress is derived, not stored', async () => {
    const school = await newSchool();
    // A school that tidies its roll back to zero must not be told it is set up.
    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                    VALUES ('OB-BLIP', 'Brief', 'Child', 'ACTIVE')`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    expect(
      (
        (
          await call(statusGet as never, school.jar, {
            method: 'GET',
            path: '/api/onboarding/status',
          })
        ).data.steps as Array<{ key: string; done: boolean }>
      ).find((s) => s.key === 'students')!.done,
    ).toBe(true);

    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`UPDATE students SET deleted_at = now() WHERE student_id = 'OB-BLIP'`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const after = await call(statusGet as never, school.jar, {
      method: 'GET',
      path: '/api/onboarding/status',
    });
    expect(
      (after.data.steps as Array<{ key: string; done: boolean }>).find((s) => s.key === 'students')!
        .done,
    ).toBe(false);
    expect(after.data.readyToBill).toBe(false);
  });

  // ── Validate: it must write NOTHING ─────────────────────────────────────

  it('validates a good file and reports what it would do', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv([
          'A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes',
          'A2,Musa,Danjuma,M,2012-04-11,Primary 4,Aisha Danjuma,+234 803 555 0200,Father,no',
        ]),
        termId: school.termId,
      },
      csrf: true,
    });
    expect(res.status).toBe(200);
    const summary = res.data.plan.summary as { importable: number; planHash: string };
    expect(summary.importable).toBe(2);
    expect(summary.planHash).toBeTruthy();
    expect(res.data.canCommit).toBe(true);
    expect(res.data.plan.rows).toHaveLength(2);
    expect(res.data.term.id).toBe(school.termId);
  });

  it('writes NOTHING when validating — no student, no guardian, no audit event', async () => {
    const school = await newSchool();
    await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
      },
      csrf: true,
    });

    expect(await counts(school.ctx)).toEqual({
      students: 0,
      links: 0,
      enrollments: 0,
      guardians: 0,
    });
  });

  it('reports row-level errors with line numbers, and refuses to commit', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv([
          ',Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes',
          'A2,,Danjuma,M,2012-04-11,Primary 4,Aisha Danjuma,08035550200,Father,no',
        ]),
        termId: school.termId,
      },
      csrf: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.canCommit).toBe(false);
    const issues = res.data.plan.issues as Array<{ severity: string; line: number; code: string }>;
    expect(issues.find((i) => i.code === 'MISSING_ADMISSION_NUMBER')?.line).toBe(2);
    expect(issues.find((i) => i.code === 'MISSING_FIRST_NAME')?.line).toBe(3);
    expect(res.data.errorReportCsv).toContain('MISSING_ADMISSION_NUMBER');
  });

  it('returns a downloadable problem list naming the line numbers', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,call mama,Mother,yes']),
        termId: school.termId,
      },
      csrf: true,
    });
    // A bad phone is a WARNING: importable, and the problem list still names it.
    // The defect this catches: filtering the report to errors alone handed the
    // school a header-only file for a file that had a real problem in it.
    expect(res.data.canCommit).toBe(true);
    const report = res.data.errorReportCsv as string;
    expect(report).toContain('PHONE_NOT_IMPORTED');
    // Both warnings are right: the number could not be imported, and with the
    // number dropped this guardian now has no way of being contacted at all.
    expect(report).toContain('GUARDIAN_WITHOUT_CONTACT');
    expect(report).toContain('2,WARNING');
    expect(report.split('\r\n').filter(Boolean)).toHaveLength(3);
    // The message names the value the school actually wrote.
    expect(report).toContain('call mama');
  });

  it('refuses an oversized file before parsing it', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: { csv: 'x'.repeat(2_000_001), termId: school.termId },
      csrf: true,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/too large/i);
    expect(JSON.stringify(res.data)).toMatch(/split the file/i);
  });

  it('refuses an unknown term', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: randomUUID(),
      },
      csrf: true,
    });
    expect(res.status).toBe(404);
  });

  it('refuses a body with an unexpected field', async () => {
    const school = await newSchool();
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
        organizationId: randomUUID(),
      },
      csrf: true,
    });
    expect(res.status).toBe(400);
  });

  it('cannot validate against another school\u2019s term', async () => {
    const mine = await newSchool();
    const theirs = await newSchool();
    const res = await call(validatePost as never, mine.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: theirs.termId,
      },
      csrf: true,
    });
    expect(res.status).toBe(404);
  });

  // ── Commit ──────────────────────────────────────────────────────────────

  it('imports the reviewed plan and returns what it created', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });
    const res = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: preview.data.plan.summary.planHash, acknowledgedWarnings: true },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    expect(res.status).toBe(201);
    expect(res.data.imported).toMatchObject({ students: 1, guardians: 1, enrollments: 1 });

    expect(await counts(school.ctx)).toEqual({
      students: 1,
      links: 1,
      enrollments: 1,
      guardians: 1,
    });
  });

  it('creates NO invoice or financial record as a side effect of importing', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });
    await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: preview.data.plan.summary.planHash, acknowledgedWarnings: true },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });

    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const invoiceRows = (await getSql()`
      SELECT id FROM invoices WHERE organization_id = ${school.ctx.organizationId}::uuid
    `) as unknown as Array<{ id: string }>;
    expect(invoiceRows).toHaveLength(0);

    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const financial = (await getSql()`
      SELECT (SELECT count(*)::int FROM payments WHERE organization_id = ${school.ctx.organizationId}::uuid) AS payments,
             (SELECT count(*)::int FROM payment_allocations WHERE organization_id = ${school.ctx.organizationId}::uuid) AS allocations,
             (SELECT count(*)::int FROM receipts WHERE organization_id = ${school.ctx.organizationId}::uuid) AS receipts
    `) as unknown as Array<{ payments: number; allocations: number; receipts: number }>;
    expect(financial[0]).toEqual({ payments: 0, allocations: 0, receipts: 0 });
  });

  it('records the same audit trail a hand-entered admission leaves', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });
    await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: preview.data.plan.summary.planHash, acknowledgedWarnings: true },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });

    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const events = (await getSql()`
      SELECT action, actor_user_id AS "actorUserId" FROM audit_events
       WHERE organization_id = ${school.ctx.organizationId}::uuid
    `) as unknown as Array<{ action: string; actorUserId: string | null }>;
    // One per student (identical action to POST /api/students) + one summary.
    expect(events.filter((e) => e.action === 'student.create')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'student.import')).toHaveLength(1);
    expect(events.every((e) => e.actorUserId === school.ctx.userId)).toBe(true);
  });

  it('refuses a commit whose plan hash does not match — the review is binding', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const res = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: 'deadbeef-0', acknowledgedWarnings: true },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    expect(res.status).toBe(409);
    expect((await counts(school.ctx)).students).toBe(0);
  });

  it('refuses a commit when the roll changed after the preview', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });

    // Someone else admits A1 while the bursar is reading the preview.
    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                    VALUES ('A1', 'Already', 'Here', 'ACTIVE')`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;

    const res = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: preview.data.plan.summary.planHash, acknowledgedWarnings: true },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    expect(res.status).toBe(409);
    // And the roll still holds exactly the one student that was already there.
    expect((await counts(school.ctx)).students).toBe(1);
  });

  it('refuses a commit with errors still in the file', async () => {
    const school = await newSchool();
    const res = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: {
        csv: csv([',Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
        planHash: 'anything',
        acknowledgedWarnings: true,
      },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    // The hash is checked first, so a broken file is refused either way and
    // nothing is written.
    expect([400, 409]).toContain(res.status);
    expect((await counts(school.ctx)).students).toBe(0);
  });

  it('requires an Idempotency-Key on commit', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });
    const res = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: { ...body, planHash: preview.data.plan.summary.planHash, acknowledgedWarnings: true },
      csrf: true,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/idempotency/i);
  });

  it('imports ONCE when the same commit is replayed with the same key', async () => {
    const school = await newSchool();
    const body = {
      csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
      termId: school.termId,
    };
    const preview = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body,
      csrf: true,
    });
    const payload = {
      ...body,
      planHash: preview.data.plan.summary.planHash,
      acknowledgedWarnings: true,
    };
    const idempotencyKey = key();

    const first = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
      csrf: true,
    });
    const second = await call(commitPost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
      csrf: true,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.data.imported).toEqual(first.data.imported);

    // One child, one guardian link, one enrollment — the replay added nothing.
    expect(await counts(school.ctx)).toEqual({
      students: 1,
      links: 1,
      enrollments: 1,
      guardians: 1,
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const importEvents = (await getSql()`
      SELECT count(*)::int AS n FROM audit_events
       WHERE organization_id = ${school.ctx.organizationId}::uuid AND action = 'student.import'
    `) as unknown as Array<{ n: number }>;
    expect(importEvents[0]!.n).toBe(1);
  });

  it('refuses a commit against another school\u2019s term', async () => {
    const mine = await newSchool();
    const theirs = await newSchool();
    const res = await call(commitPost as never, mine.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/commit',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: theirs.termId,
        planHash: 'x',
        acknowledgedWarnings: true,
      },
      headers: { 'Idempotency-Key': key() },
      csrf: true,
    });
    expect(res.status).toBe(404);
  });

  it('reports a duplicate that already exists rather than importing it', async () => {
    const school = await newSchool();
    await withSystemContext(school.ctx.organizationId, school.ctx.userId, async () => {
      await getSql()`INSERT INTO students (student_id, first_name, last_name, status)
                    VALUES ('A1', 'Already', 'Here', 'ACTIVE')`;
    });
    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;

    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: {
        csv: csv(['A1,Ada,Eze,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes']),
        termId: school.termId,
      },
      csrf: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.canCommit).toBe(false);
    const issue = (res.data.plan.issues as Array<{ code: string; message: string }>).find(
      (i) => i.code === 'DUPLICATE_ADMISSION_NUMBER',
    )!;
    expect(issue.message).toContain('Already Here');
  });

  it('accepts a file in the shapes schools actually send', async () => {
    const school = await newSchool();
    // Semicolon delimiter, quoted names with commas, CRLF, a BOM, and one
    // unrecognised column that must be reported rather than dropped quietly.
    const file =
      '\uFEFFAdm No;Surname;First Name;Sex;DOB;Class;Parent Name;Parent Phone;House\r\n' +
      'A10;Eze;Ada;F;15/01/2013;Primary 4;"Chidi Eze, Snr";0803 555 0142;Blue\r\n';
    const res = await call(validatePost as never, school.jar, {
      method: 'POST',
      path: '/api/onboarding/students/import/validate',
      body: { csv: file, termId: school.termId },
      csrf: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.canCommit).toBe(true);
    expect(res.data.plan.summary.unrecognisedColumns).toEqual(['House']);
    expect(res.data.plan.rows[0]).toMatchObject({
      firstName: 'Ada',
      lastName: 'Eze',
      className: 'Primary 4',
    });
    expect(res.data.plan.rows[0].guardian).toMatchObject({
      lastName: 'Eze, Snr',
      phone: '08035550142',
    });
  });
});
