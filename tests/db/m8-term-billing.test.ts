// @vitest-environment node
/**
 * M8 adversarial verification: the controlled-billing boundary is exercised
 * against a real migrated PostgreSQL database under the runtime role.
 */
import { describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { testDb, testSql } from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs, type SeededIds } from '../support/seed';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';
import * as feeDefinitions from '@/lib/db/repo/fee-definitions';
import * as feeAssignments from '@/lib/db/repo/fee-assignments';
import * as billing from '@/lib/db/repo/billing';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as receiptsRepo from '@/lib/db/repo/receipts';
import * as termsRepo from '@/lib/db/repo/terms';
import { invoiceLines, invoices, terms, waivers, auditEvents } from '@/lib/db/schema';
import { kobo } from '@/lib/money';

function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function base(options: { enroll?: boolean; fee?: boolean } = {}) {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  const db = testDb();
  const ctx = ctxFor(ids.orgId, ids.aliceId);
  if (options.enroll !== false) await enroll(ids.studentAId, ids.classId, ids.termId, ids.orgId);
  let fee: feeDefinitions.FeeDefinition | null = null;
  let assignment: feeAssignments.FeeAssignment | null = null;
  if (options.fee !== false) {
    fee = await feeDefinitions.create(db, ctx, {
      code: 'TUITION',
      name: 'Tuition',
      description: 'Term tuition',
      defaultAmountKobo: 100_000,
      isActive: true,
    });
    assignment = await feeAssignments.create(db, ctx, {
      feeDefinitionId: fee.id,
      classId: null,
      termId: ids.termId,
      amountKobo: 100_000,
      adjustmentKobo: 0,
      dueDate: '2026-06-01',
      status: 'ACTIVE',
    });
  }
  return { ids, db, ctx, fee: fee!, assignment: assignment! };
}

async function enroll(studentId: UUID, classId: UUID, termId: UUID, orgId: UUID): Promise<void> {
  await testSql()`
    INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on)
    VALUES (${randomUUID()}::uuid, ${orgId}::uuid, ${studentId}::uuid, ${classId}::uuid, ${termId}::uuid, '2026-04-15'::date)
  `;
}

async function addStudentInClass(ids: SeededIds, suffix: string, classId = ids.classId): Promise<UUID> {
  const studentId = randomUUID() as UUID;
  await testSql()`
    INSERT INTO students (id, organization_id, student_id, first_name, last_name, status)
    VALUES (${studentId}::uuid, ${ids.orgId}::uuid, ${`STU-${suffix}`} , ${`Student${suffix}`}, 'Test', 'ACTIVE')
  `;
  await enroll(studentId, classId, ids.termId, ids.orgId);
  return studentId;
}

async function bill(db: ReturnType<typeof testDb>, ctx: TenantCtx, termId: UUID, overrides: billing.WaiverOverrideInput[] = []) {
  // setup-db already holds the single test connection inside a transaction;
  // the production API adds the outer db.transaction around this repository.
  return billing.billTerm(db, ctx, termId, overrides, `m8-test-${randomUUID()}`);
}

async function expectBillingError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ billingCode: code });
  }
}

describe('M8 controlled term billing', () => {
  it('previews the exact enrolled population, issues ordinary invoices, and marks the term BILLED', async () => {
    const { ids, db, ctx, assignment } = await base();
    const preview = await billing.previewTerm(db, ctx, ids.termId);
    expect(preview.ready).toBe(true);
    expect(preview.activeEnrollmentCount).toBe(1);
    expect(preview.billableKeyCount).toBe(1);
    expect(preview.toIssueKobo).toBe(100_000);
    expect(preview.students[0]!.lines[0]!.feeAssignmentId).toBe(assignment.id);

    const result = await bill(db, ctx, ids.termId);
    expect(result.createdInvoices).toBe(1);
    expect(result.createdLines).toBe(1);
    expect(result.totalKobo).toBe(100_000);

    const term = await termsRepo.get(db, ctx, ids.termId);
    expect(term?.status).toBe('BILLED');
    expect(term?.billed).toBe(true);
    expect(term?.billedAt).not.toBeNull();
    expect(term?.billedBy).toBe(ids.aliceId);

    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.feeAssignmentId, assignment.id));
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, result.invoiceIds[0]!));
    expect(line?.billingStudentId).toBe(ids.studentAId);
    expect(line?.billingTermId).toBe(ids.termId);
    expect(invoice?.status).toBe('ISSUED');
    expect(invoice?.totalKobo).toBe(100_000);

    const events = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, ids.termId), eq(auditEvents.action, 'term.bill')));
    expect(events).toHaveLength(1);
  });

  it('applies an authorized per-line waiver through the immutable waiver boundary', async () => {
    const { ids, db, ctx, assignment } = await base();
    const result = await bill(db, ctx, ids.termId, [{
      studentId: ids.studentAId,
      feeAssignmentId: assignment.id,
      amountKobo: 25_000,
      reason: 'SCHOLARSHIP',
      note: 'Approved bursary concession',
    }]);
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.feeAssignmentId, assignment.id));
    const [waiver] = await db.select().from(waivers).where(eq(waivers.invoiceLineId, line!.id));
    expect(result.waiversKobo).toBe(25_000);
    expect(line?.adjustmentKobo).toBe(-25_000);
    expect(line?.amountKobo).toBe(75_000);
    expect(waiver?.amountKobo).toBe(25_000);
    expect(waiver?.reason).toBe('SCHOLARSHIP');
    expect(waiver?.approvedBy).toBe(ids.aliceId);
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, result.invoiceIds[0]!));
    expect(invoice?.totalKobo).toBe(75_000);
  });

  it('caps concessions, prevents zero-total invoices, and keeps waiver records immutable', async () => {
    const { ids, db, ctx, assignment } = await base();
    await expectBillingError(bill(db, ctx, ids.termId, [{
      studentId: ids.studentAId,
      feeAssignmentId: assignment.id,
      amountKobo: 100_001,
      reason: 'OTHER',
    }]), 'INVALID_WAIVER');
    const stillActive = await termsRepo.get(db, ctx, ids.termId);
    expect(stillActive?.billed).toBe(false);

    await expectBillingError(bill(db, ctx, ids.termId, [{
      studentId: ids.studentAId,
      feeAssignmentId: assignment.id,
      amountKobo: 100_000,
      reason: 'SCHOLARSHIP',
    }]), 'ZERO_INVOICE_TOTAL');
    // M8 refuses a zero-total ordinary invoice before it is issued.
    const stillUnbilled = await termsRepo.get(db, ctx, ids.termId);
    expect(stillUnbilled?.status).toBe('ACTIVE');
  });

  it('prevents changing waiver rows and rejects an unapproved negative fee-line adjustment at issuance', async () => {
    const { ids, db, ctx, assignment } = await base();
    const result = await bill(db, ctx, ids.termId, [{ studentId: ids.studentAId, feeAssignmentId: assignment.id, amountKobo: 10_000, reason: 'OTHER' }]);
    const [waiver] = await db.select().from(waivers).where(eq(waivers.invoiceLineId, (await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.feeAssignmentId, assignment.id)).limit(1))[0]!.id));
    const savepoint = `m8waiver_${randomUUID().replaceAll('-', '')}`;
    await testSql().unsafe(`SAVEPOINT ${savepoint}`);
    let mutationError: any;
    try { await db.update(waivers).set({ note: 'tamper' }).where(eq(waivers.id, waiver!.id)); } catch (error) { mutationError = error; }
    expect(mutationError).toBeTruthy();
    await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);

    // Separate unbilled term: a negative fee-backed line without a waiver may
    // exist while DRAFT but cannot cross the issuance boundary.
    const term2 = randomUUID() as UUID;
    await testSql()`INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, status, billed) VALUES (${term2}::uuid, ${ids.orgId}::uuid, ${ids.sessionId}::uuid, 'Second', '2nd', '2026-08-01', 'ACTIVE', false)`;
    await testSql()`INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on) VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${ids.classId}::uuid, ${term2}::uuid, '2026-08-01')`;
    const assignment2 = await feeAssignments.create(db, ctx, { feeDefinitionId: assignment.feeDefinitionId, classId: null, termId: term2, amountKobo: 100_000, adjustmentKobo: 0, dueDate: null, status: 'ACTIVE' });
    const draft = await invoicesRepo.createDraft(db, ctx, { studentId: ids.studentAId, termId: term2, sessionId: ids.sessionId });
    await invoiceLinesRepo.addLines(db, ctx, draft.id, [{ feeAssignmentId: assignment2.id, billingStudentId: ids.studentAId, billingTermId: term2, description: 'Bad concession', quantity: 1, unitRateKobo: 100_000 as any, adjustmentKobo: -1, amountKobo: 99_999 as any }]);
    const issueSavepoint = `m8issue_${randomUUID().replaceAll('-', '')}`;
    await testSql().unsafe(`SAVEPOINT ${issueSavepoint}`);
    let issueError: any;
    try { await invoicesRepo.issue(db, ctx, draft.id); } catch (error) { issueError = error; }
    expect(issueError).toBeTruthy();
    await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${issueSavepoint}`);
    const unchanged = await invoicesRepo.get(db, ctx, draft.id);
    expect(unchanged?.status).toBe('DRAFT');
    expect(result.createdInvoices).toBe(1);
  });

  it('is safe to retry and tops up a post-billing enrolment without duplicating the first student', async () => {
    const { ids, db, ctx, assignment } = await base();
    const first = await bill(db, ctx, ids.termId);
    const retry = await bill(db, ctx, ids.termId);
    expect(retry.createdInvoices).toBe(0);
    expect(retry.unchanged).toBe(1);

    const secondStudent = await addStudentInClass(ids, 'A02');
    const topUp = await bill(db, ctx, ids.termId);
    expect(topUp.createdInvoices).toBe(1);
    expect(topUp.term.status).toBe('BILLED');

    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.feeAssignmentId, assignment.id));
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.billingStudentId))).toEqual(new Set([ids.studentAId, secondStudent]));
    expect(new Set(topUp.invoiceIds)).not.toContain(first.invoiceIds[0]);
  });

  it('rejects PLANNED, CLOSED, empty, and incomplete cohorts without marking them billed', async () => {
    const { ids, db, ctx } = await base({ enroll: false, fee: false });
    const plannedTermId = randomUUID() as UUID;
    await testSql()`
      INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, status, billed)
      VALUES (${plannedTermId}::uuid, ${ids.orgId}::uuid, ${ids.sessionId}::uuid, 'Planned', 'P', '2026-08-01', 'PLANNED', false)
    `;
    await expectBillingError(bill(db, ctx, plannedTermId), 'TERM_NOT_ACTIVE');

    // The seeded ACTIVE term is empty and has no fee structure.
    await expectBillingError(bill(db, ctx, ids.termId), 'EMPTY_ENROLLMENT');
    const emptyTerm = await termsRepo.get(db, ctx, ids.termId);
    expect(emptyTerm?.status).toBe('ACTIVE');
    expect(emptyTerm?.billed).toBe(false);

    // Add a student but still no active assignment.
    await enroll(ids.studentAId, ids.classId, ids.termId, ids.orgId);
    await expectBillingError(bill(db, ctx, ids.termId), 'NO_ACTIVE_FEES');

    // A class-specific fee leaves a second class without an applicable fee.
    const fee = await feeDefinitions.create(db, ctx, { code: 'LAB', name: 'Laboratory', description: null, defaultAmountKobo: 50_000, isActive: true });
    const classB = randomUUID() as UUID;
    await testSql()`INSERT INTO classes (id, organization_id, name) VALUES (${classB}::uuid, ${ids.orgId}::uuid, 'SS3 East')`;
    await addStudentInClass(ids, 'B01', classB);
    await feeAssignments.create(db, ctx, { feeDefinitionId: fee.id, classId: ids.classId, termId: ids.termId, amountKobo: 50_000, adjustmentKobo: 0, dueDate: null, status: 'ACTIVE' });
    await expectBillingError(bill(db, ctx, ids.termId), 'INCOMPLETE_COHORT');

    // Bill a separate valid term then close it and prove CLOSED is rejected.
    const closedTermId = randomUUID() as UUID;
    await testSql()`INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, status, billed) VALUES (${closedTermId}::uuid, ${ids.orgId}::uuid, ${ids.sessionId}::uuid, 'Closed', 'C', '2026-08-01', 'ACTIVE', false)`;
    await testSql()`INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on) VALUES (${randomUUID()}::uuid, ${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${ids.classId}::uuid, ${closedTermId}::uuid, '2026-08-01')`;
    const closedFee = await feeDefinitions.create(db, ctx, { code: 'CLOSED_FEE', name: 'Closed Fee', description: null, defaultAmountKobo: 10_000, isActive: true });
    await feeAssignments.create(db, ctx, { feeDefinitionId: closedFee.id, classId: null, termId: closedTermId, amountKobo: 10_000, adjustmentKobo: 0, dueDate: null, status: 'ACTIVE' });
    await bill(db, ctx, closedTermId);
    await db.update(terms).set({ status: 'CLOSED' }).where(eq(terms.id, closedTermId));
    await expectBillingError(bill(db, ctx, closedTermId), 'TERM_CLOSED');
  });

  it('the database unique billing key rejects a second line for the same student, term, and assignment', async () => {
    const { ids, db, ctx, assignment } = await base();
    await bill(db, ctx, ids.termId);
    const draft = await invoicesRepo.createDraft(db, ctx, { studentId: ids.studentAId, termId: ids.termId, sessionId: ids.sessionId });
    const savepoint = `m8dup_${randomUUID().replaceAll('-', '')}`;
    await testSql().unsafe(`SAVEPOINT ${savepoint}`);
    let error: any;
    try {
      await db.insert(invoiceLines).values({
        organizationId: ids.orgId,
        invoiceId: draft.id,
        feeAssignmentId: assignment.id,
        billingStudentId: ids.studentAId,
        billingTermId: ids.termId,
        description: 'Duplicate',
        quantity: 1,
        unitRateKobo: 100_000,
        adjustmentKobo: 0,
        amountKobo: 100_000,
      } as any);
    } catch (e) { error = e; }
    expect(error).toBeTruthy();
    expect((error as any)?.code ?? (error as any)?.cause?.code).toBe('23505');
    await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  });

  it('ordinary invoices remain allocatable and receiptable after term billing', async () => {
    const { ids, db, ctx } = await base();
    const result = await bill(db, ctx, ids.termId);
    const payment = await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(40_000), reference: 'M8-FLOW-001' });
    const allocation = await allocationsRepo.allocate(db, ctx, { paymentId: payment.id, invoiceId: result.invoiceIds[0]!, amountKobo: kobo(40_000) });
    expect(allocation.invoice.paidKobo).toBe(40_000);
    expect(allocation.invoice.status).toBe('PARTIALLY_PAID');
    const receipt = await receiptsRepo.issue(db, ctx, { paymentId: payment.id, allocationId: allocation.allocation.id, studentId: ids.studentAId, amountKobo: kobo(40_000) });
    expect(receipt.amountKobo).toBe(40_000);
  });

  it('tenant RLS hides a billed line and waiver from the other school', async () => {
    const { ids, db, ctx, assignment } = await base();
    const result = await bill(db, ctx, ids.termId, [{ studentId: ids.studentAId, feeAssignmentId: assignment.id, amountKobo: 10_000, reason: 'OTHER' }]);
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const foreignLines = await db.select().from(invoiceLines).where(eq(invoiceLines.id, (await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, result.invoiceIds[0]!)).limit(1))[0]?.id ?? randomUUID()));
    const foreignWaivers = await db.select().from(waivers);
    expect(foreignLines).toHaveLength(0);
    expect(foreignWaivers).toHaveLength(0);
  });
});
