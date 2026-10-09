// @vitest-environment node
/**
 * Phase 1 — CSV student import, at the database layer.
 *
 * The planner is covered by pure tests (`lib/onboarding/student-import.test.ts`).
 * This suite covers what only a real database can prove:
 *
 *   1. AN IMPORT IS ALL OR NOTHING. A failure part-way leaves zero students
 *      behind — not some of them.
 *   2. AN IMPORT CREATES NO MONEY. No invoice, invoice line, payment, allocation,
 *      receipt, reversal, waiver or financial period appears as a side effect.
 *      This is the financial-safety guarantee of the phase, measured by counting
 *      every financial table before and after.
 *   3. TENANT ISOLATION HOLDS. One school's references (classes, admission
 *      numbers, existing students) never leak into another school's import.
 *   4. THE REVIEW IS BINDING. A plan hash that no longer matches is refused, and
 *      the roll is untouched.
 *   5. THE AUDIT TRAIL IS COMPLETE. An imported student leaves the same
 *      `student.create` event a hand-entered one does, plus one summary event.
 *
 * The work is driven through the SAME repository calls the commit endpoint makes,
 * so the transaction semantics under test are the ones that ship.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { enableSavepointTransactionsForTest, testDb, testSql } from '../setup-db';
import { seedTwoOrgs } from '../support/seed';
import { withSystemContext } from '@/lib/db/tenant';
import { auditEvents, students } from '@/lib/db/schema';
import * as studentRepo from '@/lib/db/repo/students';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as termRepo from '@/lib/db/repo/terms';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { parseCsv } from '@/lib/onboarding/csv';
import { planImport, type ImportReference } from '@/lib/onboarding/student-import';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

beforeEach(() => enableSavepointTransactionsForTest());

/** Tables that hold money or money's consequences — asserted untouched. */
const FINANCIAL_TABLES = [
  'invoices',
  'invoice_lines',
  'payments',
  'payment_allocations',
  'receipts',
  'reversals',
  'waivers',
  'financial_periods',
] as const;

async function financialCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const rows = (await testSql().unsafe(
      `SELECT count(*)::int AS n FROM ${table}`,
    )) as unknown as Array<{
      n: number;
    }>;
    out[table] = rows[0]!.n;
  }
  return out;
}

async function activate(organizationId: UUID, userId: UUID): Promise<TenantCtx> {
  await testSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  return { organizationId, userId };
}

async function buildReference(ctx: TenantCtx, termId: UUID): Promise<ImportReference> {
  const [classes, term] = await Promise.all([
    classRepo.listForOrg(testDb(), ctx),
    termRepo.get(testDb(), ctx, termId),
  ]);
  const roster = await testDb()
    .select({
      studentId: students.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
      status: students.status,
    })
    .from(students)
    .where(eq(students.organizationId, ctx.organizationId));
  const existingStudents = new Map(
    roster.map((r) => [
      r.studentId.toUpperCase(),
      { name: `${r.firstName} ${r.lastName}`.trim(), status: r.status },
    ]),
  );
  return {
    classes: classes
      .filter((c) => !c.deletedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        arm: c.arm,
        label: c.arm ? `${c.name} ${c.arm}` : c.name,
      })),
    existingStudents,
    existingByNameDob: new Map(),
    term: term
      ? { id: term.id, name: term.name, startsOn: String(term.startsOn), status: term.status }
      : null,
  };
}

/**
 * Perform the import exactly as the commit endpoint does: one transaction,
 * students → enrollments → guardians, then audit. Mirrors the route so the
 * semantics proved here are the ones that ship.
 */
async function runImport(
  ctx: TenantCtx,
  csv: string,
  termId: UUID,
  opts: { failOnStudentId?: string } = {},
) {
  const parsed = parseCsv(csv);
  return testDb().transaction(async (tx) => {
    const term = await termRepo.lockForBilling(tx as never, ctx, termId);
    if (!term) throw new Error('Term not found.');
    const reference = await buildReference(ctx, termId);
    const plan = planImport(parsed, reference, {});
    if (plan.summary.rowsWithErrors > 0) {
      throw new Error(`Cannot import: ${plan.summary.rowsWithErrors} rows have errors.`);
    }
    const created: Array<{ id: string; studentId: string; name: string; line: number }> = [];
    for (const row of plan.rows) {
      if (opts.failOnStudentId && row.studentId === opts.failOnStudentId) {
        throw new Error('Deliberate failure for the rollback test.');
      }
      const student = await studentRepo.create(tx as never, ctx, {
        studentId: row.studentId,
        firstName: row.firstName,
        lastName: row.lastName,
        middleName: row.middleName,
        gender: row.gender,
        dateOfBirth: row.dateOfBirth,
        admissionDate: row.admissionDate ?? row.enrolledOn,
        status: 'ACTIVE',
      });
      created.push({
        id: student.id,
        studentId: student.studentId,
        name: `${student.firstName} ${student.lastName}`.trim(),
        line: row.line,
      });
      if (row.classId && row.enrolledOn) {
        await enrollmentRepo.create(tx as never, ctx, {
          studentId: student.id,
          classId: row.classId as never,
          termId,
          enrolledOn: row.enrolledOn,
        });
      }
      if (row.guardian) {
        const guardian = await guardianRepo.create(tx as never, ctx, {
          firstName: row.guardian.firstName,
          lastName: row.guardian.lastName,
          phone: row.guardian.phone,
          email: row.guardian.email,
          address: null,
        });
        await guardianRepo.link(tx as never, ctx, {
          studentId: student.id,
          guardianId: guardian.id,
          relationship: row.guardian.relationship,
          isPrimary: true,
        });
      }
    }
    // Per-student events first, in one statement — exactly what the commit route
    // writes, so an imported admission leaves the same trail as a typed one.
    if (created.length > 0) {
      await (tx as unknown as ReturnType<typeof testDb>).insert(auditEvents).values(
        created.map((s) => ({
          organizationId: ctx.organizationId,
          actorType: 'USER' as const,
          actorUserId: ctx.userId,
          action: 'student.create',
          entityType: 'student',
          entityId: s.id as never,
          before: null,
          after: {
            studentId: s.studentId,
            name: s.name,
            source: 'csv-import',
            sourceLine: s.line,
          } as never,
          reason: null,
          metadata: { import: true } as never,
          requestId: null,
          correlationId: null,
          ipAddress: null,
          createdAt: sql`clock_timestamp()` as never,
        })),
      );
    }

    await auditRepo.record(tx as never, ctx, {
      action: 'student.import',
      entityType: 'organization',
      entityId: ctx.organizationId,
      after: { studentsCreated: created.length, planHash: plan.summary.planHash },
      metadata: { import: true },
    });
    return { created, summary: plan.summary };
  });
}

const HEAD =
  'Adm No,First Name,Last Name,Sex,DOB,Class,Parent Name,Parent Phone,Relationship,Primary';

describe('Phase 1 — a successful import', () => {
  it('creates students, enrollments and guardians in one transaction', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    // Column order is the HEAD above: ...Class, Parent Name, Parent Phone...
    const csv = [
      HEAD,
      'ADM-100,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,0803 555 0142,Mother,yes',
    ].join('\n');

    const before = await financialCounts();
    const result = await runImport(ctx, csv, ids.termId);
    expect(result.created).toHaveLength(1);

    const student = await studentRepo.getByStudentId(testDb(), ctx, 'ADM-100');
    expect(student).not.toBeNull();
    expect(student!.gender).toBe('F');
    expect(student!.dateOfBirth).toBe('2013-09-02');
    expect(student!.status).toBe('ACTIVE');

    const links = await guardianRepo.listForStudent(testDb(), ctx, student!.id as UUID);
    expect(links).toHaveLength(1);
    expect(links[0]!.phone).toBe('08035550142');
    expect(links[0]!.isPrimary).toBe(true);
    expect(links[0]!.relationship).toBe('PARENT');

    const enrollments = await testSql()`
      SELECT count(*)::int AS n FROM class_enrollments WHERE student_id = ${student!.id}::uuid
    `;
    expect((enrollments as unknown as Array<{ n: number }>)[0]!.n).toBe(1);

    // ── THE FINANCIAL-SAFETY ASSERTION ────────────────────────────────────
    const after = await financialCounts();
    expect(after).toEqual(before);
  });

  it('leaves every financial table at zero for a fresh school', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctx,
      [HEAD, 'ADM-101,Musa,Danjuma,M,2012-04-11,SS3 West,Aisha Danjuma,08035550200,Father,no'].join(
        '\n',
      ),
      ids.termId,
    );

    expect(await financialCounts()).toEqual({
      invoices: 0,
      invoice_lines: 0,
      payments: 0,
      payment_allocations: 0,
      receipts: 0,
      reversals: 0,
      waivers: 0,
      financial_periods: 0,
    });
  });

  it('writes one student.create event per student AND one summary event', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctx,
      [
        HEAD,
        'ADM-200,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
        'ADM-201,Musa,Danjuma,M,2012-04-11,SS3 West,Aisha Danjuma,08035550200,Father,no',
      ].join('\n'),
      ids.termId,
    );

    const events = await testDb()
      .select({ action: auditEvents.action, entityId: auditEvents.entityId })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, ctx.organizationId));
    const created = events.filter((e) => e.action === 'student.create');
    const summaries = events.filter((e) => e.action === 'student.import');
    expect(created).toHaveLength(2);
    expect(summaries).toHaveLength(1);
  });
});

describe('Phase 1 — an import that fails leaves nothing behind', () => {
  it('rolls the WHOLE import back when a row fails part-way through', async () => {
    // The realistic failure: a database-level refusal on row 2 of 2. The school
    // must be left with nothing, not with the first student silently created.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    const before = await financialCounts();
    await expect(
      runImport(
        ctx,
        [
          HEAD,
          'ADM-300,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
          'ADM-301,Musa,Danjuma,M,2012-04-11,SS3 West,Aisha Danjuma,08035550200,Father,no',
        ].join('\n'),
        ids.termId,
        { failOnStudentId: 'ADM-301' },
      ),
    ).rejects.toThrow(/Deliberate failure/);

    // Nothing at all: no student, no guardian, no enrollment, no audit summary.
    const countRows =
      await testSql()`SELECT count(*)::int AS n FROM students WHERE organization_id = ${ids.orgId}::uuid`;
    const n = (countRows as unknown as Array<{ n: number }>)[0]!.n;
    // The seed itself creates one student for org A; the import must add none.
    expect(n).toBe(1);
    expect(await studentRepo.getByStudentId(testDb(), ctx, 'ADM-300')).toBeNull();
    expect(
      (await guardianRepo.listForOrg(testDb(), ctx)).filter((g) => g.lastName === 'Eze'),
    ).toHaveLength(0);

    const summaries = await testDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'student.import'));
    expect(summaries).toHaveLength(0);
    expect(await financialCounts()).toEqual(before);
  });

  it('refuses to import a file that still has errors', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await expect(
      runImport(
        ctx,
        [HEAD, 'ADM-400,,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
        ids.termId,
      ),
    ).rejects.toThrow(/errors/);
    expect(await studentRepo.getByStudentId(testDb(), ctx, 'ADM-400')).toBeNull();
  });

  it('recovers cleanly: a corrected re-upload succeeds after a failed one', async () => {
    // Requirement 9 and 15 in one: correct the file, upload again, and the data
    // is exactly what the corrected file said.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    await expect(
      runImport(
        ctx,
        [HEAD, 'ADM-500,,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
        ids.termId,
      ),
    ).rejects.toThrow();

    const result = await runImport(
      ctx,
      [HEAD, 'ADM-500,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );
    expect(result.created).toHaveLength(1);
    const student = await studentRepo.getByStudentId(testDb(), ctx, 'ADM-500');
    expect(student!.firstName).toBe('Ada');
    expect(
      (await studentRepo.listForOrg(testDb(), ctx)).filter((s) => s.studentId === 'ADM-500'),
    ).toHaveLength(1);
  });
});

describe('Phase 1 — the database refuses duplicates even if the planner did not', () => {
  it('refuses a second student with the same admission number', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctx,
      [HEAD, 'ADM-600,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );

    await expect(
      studentRepo.create(testDb(), ctx, {
        studentId: 'ADM-600',
        firstName: 'Different',
        lastName: 'Person',
        status: 'ACTIVE',
      }),
    ).rejects.toThrow();
  });

  it('refuses two enrollments of one student in the same term', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctx,
      [HEAD, 'ADM-700,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );

    const student = await studentRepo.getByStudentId(testDb(), ctx, 'ADM-700');
    await expect(
      enrollmentRepo.create(testDb(), ctx, {
        studentId: student!.id as UUID,
        classId: ids.classId,
        termId: ids.termId,
        enrolledOn: '2026-09-08',
      }),
    ).rejects.toThrow();
  });

  it('refuses a re-import of the same admission number, so a double-submit is harmless', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const csv = [
      HEAD,
      'ADM-800,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
    ].join('\n');

    await runImport(ctx, csv, ids.termId);
    // The second attempt sees ADM-800 in the roll — the planner blocks it before
    // any write, which is the plan-hash path the endpoint uses.
    await expect(runImport(ctx, csv, ids.termId)).rejects.toThrow(/errors/);

    const rows = await studentRepo.listForOrg(testDb(), ctx);
    expect(rows.filter((s) => s.studentId === 'ADM-800')).toHaveLength(1);
  });
});

describe('Phase 1 — tenant isolation', () => {
  it('does not see another organization\u2019s admission numbers', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctxA,
      [HEAD, 'SHARED-1,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );

    // Org B holds the same admission number with no conflict.
    const ctxB = await activate(ids.orgBId, ids.bobId);
    const referenceB = await buildReference(ctxB, ids.termBId);
    expect(referenceB.existingStudents.has('SHARED-1')).toBe(false);
    const planB = planImport(
      parseCsv(
        [
          HEAD,
          'SHARED-1,Musa,Danjuma,M,2012-04-11,SS3 East,Aisha Danjuma,08035550200,Father,no',
        ].join('\n'),
      ),
      referenceB,
      {},
    );
    expect(planB.summary.rowsWithErrors).toBe(0);
    expect(planB.summary.importable).toBe(1);
  });

  it('does not match org B\u2019s classes against org A\u2019s file', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const referenceA = await buildReference(ctxA, ids.termId);
    // 'SS3 East' belongs to org B; org A must not accept it.
    const plan = planImport(
      parseCsv(
        [HEAD, 'X1,Ada,Eze,F,2013-09-02,SS3 East,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ),
      referenceA,
      {},
    );
    expect(plan.issues.find((i) => i.code === 'UNKNOWN_CLASS')).toBeTruthy();
  });

  it('refuses an enrollment that points at another organization\u2019s class', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    await expect(
      enrollmentRepo.create(testDb(), ctxA, {
        studentId: ids.studentAId,
        classId: ids.classBId,
        termId: ids.termId,
        enrolledOn: '2026-09-08',
      }),
    ).rejects.toThrow();
  });
});

describe('Phase 1 — the reviewed plan is binding', () => {
  it('detects that the roll changed while the school was reviewing', async () => {
    // A real risk: two bursars, one file. Between the preview and the confirm,
    // an admission number enters the roll. The hash must change and the import
    // must be refused rather than creating a duplicate.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const csv = [
      HEAD,
      'ADM-900,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
    ].join('\n');

    const referenceBefore = await buildReference(ctx, ids.termId);
    const approved = planImport(parseCsv(csv), referenceBefore, {});

    // A second user admits the same admission number by hand.
    await studentRepo.create(testDb(), ctx, {
      studentId: 'ADM-900',
      firstName: 'Already',
      lastName: 'Here',
      status: 'ACTIVE',
    });

    const referenceAfter = await buildReference(ctx, ids.termId);
    const replayed = planImport(parseCsv(csv), referenceAfter, {});
    expect(replayed.summary.planHash).not.toBe(approved.summary.planHash);
    expect(replayed.summary.rowsWithErrors).toBe(1);
  });

  it('produces the same hash for the same file and the same roll', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const csv = [
      HEAD,
      'ADM-910,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
    ].join('\n');
    const reference = await buildReference(ctx, ids.termId);
    const first = planImport(parseCsv(csv), reference, {});
    const second = planImport(parseCsv(csv), reference, {});
    expect(first.summary.planHash).toBe(second.summary.planHash);
  });
});

describe('Phase 1 — a large import', () => {
  it('imports 200 students, with guardians and enrollments, in one transaction', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    const lines = [HEAD];
    for (let i = 0; i < 200; i += 1) {
      const n = String(i).padStart(3, '0');
      lines.push(
        `BULK-${n},First${n},Last${n},${i % 2 === 0 ? 'F' : 'M'},2013-09-02,SS3 West,Guardian ${n},0803555${n}00,Mother,yes`,
      );
    }
    const before = await financialCounts();
    const result = await runImport(ctx, lines.join('\n'), ids.termId);

    expect(result.created).toHaveLength(200);
    expect(result.summary.guardiansToCreate).toBe(200);
    expect(result.summary.enrollmentsToCreate).toBe(200);

    const counts = (await testSql()`
      SELECT (SELECT count(*)::int FROM students WHERE organization_id = ${ids.orgId}::uuid) AS students,
             (SELECT count(*)::int FROM class_enrollments WHERE organization_id = ${ids.orgId}::uuid) AS enrollments,
             (SELECT count(*)::int FROM student_guardians WHERE organization_id = ${ids.orgId}::uuid) AS links
    `) as unknown as Array<{ students: number; enrollments: number; links: number }>;
    // 200 imported + the 1 the seed created for org A.
    expect(counts[0]!.students).toBe(201);
    expect(counts[0]!.enrollments).toBe(200);
    expect(counts[0]!.links).toBe(200);

    // And still no money.
    expect(await financialCounts()).toEqual(before);
  }, 60_000);
});

describe('Phase 1 — RLS and permissions are unchanged by importing', () => {
  it('keeps RLS forced on students, guardians and enrollments', async () => {
    const rows = (await testSql()`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relname IN ('students','guardians','student_guardians','class_enrollments')
         AND relkind = 'r'
    `) as unknown as Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
    }
  });

  it('leaves students invisible to another organization after an import', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctxA,
      [HEAD, 'SECRET-1,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );

    const ctxB = await activate(ids.orgBId, ids.bobId);
    expect(await studentRepo.getByStudentId(testDb(), ctxB, 'SECRET-1')).toBeNull();
    const visible = await studentRepo.listForOrg(testDb(), ctxB);
    expect(visible.map((s) => s.studentId)).not.toContain('SECRET-1');
  });

  it('writes no audit event with a null organization — every event is scoped', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    await runImport(
      ctx,
      [HEAD, 'AUD-1,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes'].join('\n'),
      ids.termId,
    );

    const scoped = await testDb()
      .select({ organizationId: auditEvents.organizationId })
      .from(auditEvents);
    for (const event of scoped) expect(event.organizationId).toBe(ctx.organizationId);
  });
});

describe('Phase 1 — the term lock, and repeat submissions', () => {
  it('takes the term lock scoped to the school, so it cannot lock another school\u2019s term', async () => {
    // The commit path holds FOR UPDATE on the term for the whole import, which is
    // what serialises two bursars importing into the same term. This proves the
    // lock resolves the right term and refuses to resolve anyone else's.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const locked = await termRepo.lockForBilling(testDb(), ctxA, ids.termId);
    expect(locked?.id).toBe(ids.termId);

    const theirs = await termRepo.lockForBilling(testDb(), ctxA, ids.termBId);
    expect(theirs).toBeNull();

    const ctxB = await activate(ids.orgBId, ids.bobId);
    expect((await termRepo.lockForBilling(testDb(), ctxB, ids.termBId))?.id).toBe(ids.termBId);
    expect(await termRepo.lockForBilling(testDb(), ctxB, ids.termId)).toBeNull();
  });

  it('creates nothing extra when the same file is submitted twice', async () => {
    // A double-tap on a slow Nigerian connection. The second submission must not
    // add a second Ada Eze. The route ALSO carries an Idempotency-Key, covered in
    // the route suite; this proves the data layer cannot be talked into a
    // duplicate even if that first line of defence is bypassed.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const csv = [
      HEAD,
      'RACE-1,Ada,Eze,F,2013-09-02,SS3 West,Chidi Eze,08035550142,Mother,yes',
    ].join('\n');

    await runImport(ctx, csv, ids.termId);
    await expect(runImport(ctx, csv, ids.termId)).rejects.toThrow(/errors/);

    const rows = (await testSql()`
      SELECT (SELECT count(*)::int FROM students
               WHERE organization_id = ${ids.orgId}::uuid AND student_id = 'RACE-1') AS students,
             (SELECT count(*)::int FROM student_guardians
               WHERE organization_id = ${ids.orgId}::uuid) AS links
    `) as unknown as Array<{ students: number; links: number }>;
    expect(rows[0]!.students).toBe(1);
    expect(rows[0]!.links).toBe(1);
  });
});
