// @vitest-environment node
/**
 * M9 database control tests. These exercise the fresh migration under the
 * runtime role, with real RLS, trigger, constraint, and index enforcement.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { seedTwoOrgs } from '../support/seed';
import { withSystemContext } from '@/lib/db/tenant';
import { classEnrollments, classes, receipts, students, terms } from '@/lib/db/schema';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as receiptsRepo from '@/lib/db/repo/receipts';
import { kobo } from '@/lib/money';
import type { UUID } from '@/lib/db/repo/_context';

async function expectPgFailure(fn: () => Promise<unknown>, codes: string[] = []): Promise<any> {
  const savepoint = `m9_${randomUUID().replaceAll('-', '')}`;
  const sql = testSql();
  await sql.unsafe(`SAVEPOINT ${savepoint}`);
  let error: any;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  expect(error).toBeTruthy();
  if (codes.length > 0) {
    const code = error.code ?? error.cause?.code ?? error.originalError?.code;
    expect(codes).toContain(code);
  }
  return error;
}

async function insertEnrollment(ids: { orgId: UUID; studentId: UUID; classId: UUID; termId: UUID }, leftOn: string | null = null) {
  const id = randomUUID() as UUID;
  await testSql()`
    INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on, left_on)
    VALUES (${id}::uuid, ${ids.orgId}::uuid, ${ids.studentId}::uuid, ${ids.classId}::uuid,
            ${ids.termId}::uuid, '2026-04-15'::date, ${leftOn}::date)
  `;
  return id;
}

describe('M9 academic control layer — database', () => {
  it('enforces current pointers, dates, and tenant-safe academic references', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    await expectPgFailure(
      () => testSql()`
        INSERT INTO academic_sessions (id, organization_id, name, starts_on, is_current, status)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, 'another-current', '2027-01-01'::date, true, 'PLANNED')
      `,
      ['23505'],
    );
    await expectPgFailure(
      () => testSql()`
        INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, is_current, status)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.sessionId}::uuid, 'another-current-term', 'x', '2027-01-01'::date, true, 'PLANNED')
      `,
      ['23505'],
    );
    await expectPgFailure(
      () => testSql()`
        INSERT INTO academic_sessions (id, organization_id, name, starts_on, ends_on, status)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, 'bad-dates', '2027-02-01'::date, '2027-01-01'::date, 'PLANNED')
      `,
      ['23514'],
    );

    // The reference IDs exist, but the session belongs to the other school.
    await expectPgFailure(
      () => testSql()`
        INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, status)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.sessionBId}::uuid, 'foreign-session', 'x', '2027-01-01'::date, 'PLANNED')
      `,
      ['23514', '42501'],
    );

    // One authoritative enrollment per student/term and no inverted interval.
    const enrollmentId = await insertEnrollment({ orgId: ids.orgId, studentId: ids.studentAId, classId: ids.classId, termId: ids.termId });
    await expectPgFailure(
      () => testSql()`
        INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${ids.classId}::uuid, ${ids.termId}::uuid, '2026-04-16'::date)
      `,
      ['23505'],
    );
    await expectPgFailure(
      () => testSql()`
        UPDATE class_enrollments SET left_on = '2026-04-14'::date
         WHERE id = ${enrollmentId}::uuid
      `,
      ['23514'],
    );
    await expectPgFailure(
      () => testSql()`
        INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${ids.classId}::uuid, ${ids.termId}::uuid, CURRENT_DATE + 1)
      `,
      ['23514'],
    );

    // A class enrollment cannot mix organizations even when all IDs are valid.
    await expectPgFailure(
      () => testSql()`
        INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on)
        VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.studentBId}::uuid, ${ids.classBId}::uuid, ${ids.termId}::uuid, '2026-04-15'::date)
      `,
      ['23514', '23503', '42501'],
    );

  });

  it('blocks inactive students and archived classes from active enrollments, and protects history', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    const inactiveId = randomUUID() as UUID;
    await testSql()`
      INSERT INTO students (id, organization_id, student_id, first_name, last_name, status)
      VALUES (${inactiveId}::uuid, ${ids.orgId}::uuid, 'INACTIVE-M9', 'Inactive', 'Student', 'ARCHIVED')
    `;
    await expectPgFailure(
      () => insertEnrollment({ orgId: ids.orgId, studentId: inactiveId, classId: ids.classId, termId: ids.termId }),
      ['23514', '42501'],
    );

    await testDb().update(classes).set({ deletedAt: new Date() }).where(eq(classes.id, ids.classId));
    await expectPgFailure(
      () => insertEnrollment({ orgId: ids.orgId, studentId: ids.studentAId, classId: ids.classId, termId: ids.termId }),
      ['23514', '42501'],
    );
    await testDb().update(classes).set({ deletedAt: null }).where(eq(classes.id, ids.classId));

    await insertEnrollment({ orgId: ids.orgId, studentId: ids.studentAId, classId: ids.classId, termId: ids.termId });
    await expectPgFailure(
      () => testDb().update(students).set({ status: 'ARCHIVED' }).where(eq(students.id, ids.studentAId)),
      ['23514', '42501'],
    );
    await expectPgFailure(
      () => testDb().update(classes).set({ deletedAt: new Date() }).where(eq(classes.id, ids.classId)),
      ['23514', '42501'],
    );
  });

  it('makes billed/closed enrollment history non-destructive and keeps receipt issuance partial uniqueness', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const enrollmentId = await insertEnrollment({ orgId: ids.orgId, studentId: ids.studentAId, classId: ids.classId, termId: ids.termId });

    // The billing state transition is explicit and database-owned; no academic
    // write may delete the resulting historical enrollment.
    await testDb().update(terms).set({ status: 'BILLED', billed: true, billedAt: new Date(), billedBy: ids.aliceId }).where(eq(terms.id, ids.termId));
    await expectPgFailure(
      () => testDb().delete(classEnrollments).where(eq(classEnrollments.id, enrollmentId)),
      ['42501', '23514'],
    );
    await expectPgFailure(
      () => testDb().update(classEnrollments).set({ classId: ids.classBId }).where(eq(classEnrollments.id, enrollmentId)),
      ['23514', '42501'],
    );

    const indexRows = await testSql()`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'm9_receipts_payment_issued_unique_idx'
    ` as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0]!.indexdef).toContain("WHERE (status = 'ISSUED'::receipt_status)");

    // The partial index must still permit a controlled VOID → reissue path.
    const ctx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await paymentsRepo.record(testDb(), ctx, { method: 'CASH', amountKobo: kobo(1_000) });
    const firstReceipt = await receiptsRepo.issue(testDb(), ctx, { paymentId: payment.id, studentId: ids.studentAId, amountKobo: kobo(1_000) });
    await testDb().update(receipts).set({ status: 'VOID', voidedAt: new Date(), voidedReason: 'M9 test correction' }).where(eq(receipts.id, firstReceipt.id));
    const reissued = await receiptsRepo.issue(testDb(), ctx, { paymentId: payment.id, studentId: ids.studentAId, amountKobo: kobo(1_000) });
    expect(reissued.id).not.toBe(firstReceipt.id);
    expect(reissued.status).toBe('ISSUED');

    const rls = await testSql()`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relname IN ('academic_sessions','terms','classes','students','class_enrollments')
    ` as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rls).toHaveLength(5);
    expect(rls.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
