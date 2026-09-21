// @vitest-environment node
/** M10 reconciliation control-plane database tests. */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { seedTwoOrgs } from '../support/seed';
import { setupConcurrencyFixtures, type ConcurrencyFixtures } from '../support/concurrent-seed';
import { withSystemContext } from '@/lib/db/tenant';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import {
  reconciliationCandidates,
  reconciliationCases,
  reconciliationEvidence,
} from '@/lib/db/schema';
import {
  addEvidence,
  countEvidence,
  createAcceptedCandidate,
  getOrCreateCase,
  listQueue,
  updateCaseState,
} from '@/lib/reconciliation';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';
import type { Database } from '@/lib/db';

const URL =
  process.env.DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';

async function expectPgFailure(fn: () => Promise<unknown>, codes: string[] = []): Promise<any> {
  const savepoint = `m10_${randomUUID().replaceAll('-', '')}`;
  await testSql().unsafe(`SAVEPOINT ${savepoint}`);
  let error: any;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await testSql().unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  expect(error).toBeTruthy();
  if (codes.length) expect(codes).toContain(error.code ?? error.cause?.code);
  return error;
}

async function seedPayment(
  db: Database,
  ctx: TenantCtx,
  status: 'PENDING' | 'CONFIRMED' = 'PENDING',
  amountKobo = 100_000,
) {
  return paymentsRepo.record(db, ctx, {
    method: 'BANK_TRANSFER',
    amountKobo: amountKobo as any,
    initialStatus: status,
    reference: `M10-${randomUUID()}`,
  });
}

describe('M10 reconciliation control plane — tenant, evidence, and state invariants', () => {
  it('derives a queue row without creating a financial shadow record, then requires durable evidence for decisions', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctx, 'PENDING', 125_000);
    await expect(
      getOrCreateCase(testDb(), { organizationId: ctx.organizationId, userId: null } as any, {
        id: payment.id as UUID,
        status: payment.status,
        amountKobo: Number(payment.amountKobo),
        unallocatedKobo: Number(payment.unallocatedKobo),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const beforeCases = await testDb().select().from(reconciliationCases);
    expect(beforeCases).toHaveLength(0);
    const queue = await listQueue(testDb(), ctx, { limit: 50 });
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      paymentId: payment.id,
      paymentStatus: 'PENDING',
      state: 'UNMATCHED',
      caseId: null,
      amountKobo: 125_000,
    });
    const legacyIsoCursor = Buffer.from(
      JSON.stringify({
        createdAt: queue.rows[0]!.createdAt,
        paymentId: queue.rows[0]!.paymentId,
      }),
      'utf8',
    ).toString('base64url');
    await expect(listQueue(testDb(), ctx, { cursor: legacyIsoCursor })).resolves.toMatchObject({
      rows: [],
      nextCursor: null,
    });

    const caseRow = await getOrCreateCase(testDb(), ctx, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: Number(payment.amountKobo),
      unallocatedKobo: Number(payment.unallocatedKobo),
    });
    await expectPgFailure(
      () =>
        updateCaseState(testDb(), ctx, {
          caseId: caseRow.id,
          state: 'RECONCILED',
          auditAction: 'test.decision',
        }),
      ['CONFLICT'],
    );

    const evidence = await addEvidence(testDb(), ctx, {
      caseId: caseRow.id,
      kind: 'BANK_REFERENCE',
      reference: payment.reference,
      note: 'Statement reference manually checked.',
    });
    expect(await countEvidence(testDb(), ctx, caseRow.id)).toBe(1);
    expect(evidence.createdBy).toBe(ids.aliceId);
    expect(evidence.createdAt).toBeInstanceOf(Date);
    await expectPgFailure(
      () =>
        testDb().delete(reconciliationEvidence).where(eq(reconciliationEvidence.id, evidence.id)),
      ['42501', 'insufficient_privilege'],
    );
    const reconciled = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'RECONCILED',
      kind: 'TO_MATCH',
      reason: 'Reference and payer record agree.',
      requestId: 'm10-test-decision',
      auditAction: 'reconciliation.match',
    });
    expect(reconciled.state).toBe('RECONCILED');

    await expectPgFailure(
      () =>
        testDb()
          .update(reconciliationEvidence)
          .set({ note: 'tampered' })
          .where(eq(reconciliationEvidence.id, evidence.id)),
      ['42501', 'insufficient_privilege'],
    );
    const stored = await testDb()
      .select()
      .from(reconciliationEvidence)
      .where(eq(reconciliationEvidence.id, evidence.id));
    expect(stored[0]?.note).toBe('Statement reference manually checked.');

    const afterCases = await testDb().select().from(reconciliationCases);
    expect(afterCases[0]?.paymentId).toBe(payment.id);
    expect(afterCases[0]).not.toHaveProperty('amountKobo');
    expect(afterCases[0]).not.toHaveProperty('unallocatedKobo');
  });

  it('rejects service-bypass decision shapes at the database boundary', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctx, 'CONFIRMED', 70_000);

    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCases).values({
          organizationId: ids.orgId,
          paymentId: payment.id,
          kind: 'TO_MATCH',
          state: 'RECONCILED',
          createdBy: ids.aliceId,
        }),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb()
          .insert(reconciliationCases)
          .values({
            organizationId: ids.orgId,
            kind: 'TO_MATCH',
            state: 'UNMATCHED',
            createdBy: ids.aliceId,
          } as any),
      ['23502'],
    );

    const caseRow = await getOrCreateCase(testDb(), ctx, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 70_000,
      unallocatedKobo: 70_000,
    });
    await expectPgFailure(
      () =>
        testDb()
          .insert(reconciliationEvidence)
          .values({
            organizationId: ids.orgId,
            caseId: caseRow.id,
            kind: 'OPERATOR_NOTE',
            createdBy: ids.aliceId,
          } as any),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationEvidence).values({
          organizationId: ids.orgId,
          caseId: caseRow.id,
          kind: 'OPERATOR_NOTE',
          note: 'Cross-tenant attribution.',
          createdBy: ids.bobId,
        }),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb()
          .update(reconciliationCases)
          .set({ resolvedBy: ids.bobId })
          .where(eq(reconciliationCases.id, caseRow.id)),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCandidates).values({
          organizationId: ids.orgId,
          caseId: caseRow.id,
          studentId: ids.studentAId,
          basis: 'Cross-tenant attribution.',
          state: 'PROPOSED',
          createdBy: ids.bobId,
        }),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCandidates).values({
          organizationId: ids.orgId,
          caseId: caseRow.id,
          studentId: ids.studentAId,
          basis: '',
          state: 'PROPOSED',
          createdBy: ids.aliceId,
        }),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCandidates).values({
          organizationId: ids.orgId,
          caseId: caseRow.id,
          studentId: ids.studentAId,
          basis: 'Bypassed service',
          state: 'ACCEPTED',
          createdBy: ids.aliceId,
          decidedBy: ids.aliceId,
          decidedAt: new Date(),
        }),
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases SET state = 'RECONCILED', version = version + 1 WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
  });

  it('rejects public-link and forged platform contexts for M10 control records', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctxA: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctxA, 'CONFIRMED', 60_000);
    const caseA = await getOrCreateCase(testDb(), ctxA, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 60_000,
      unallocatedKobo: 60_000,
    });

    const platformUserId = randomUUID() as UUID;
    await testSql()`SELECT auth_enter_system_context()`;
    await testSql()`
      INSERT INTO users (id, email, first_name, last_name, is_platform_admin)
      VALUES (${platformUserId}::uuid, ${`m10-platform-${platformUserId}@example.invalid`}, 'M10', 'Platform', true)
    `;
    await testSql()`SELECT clear_app_context()`;

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    await testSql()`
      SELECT set_config('app.is_platform_admin', '1', false),
             set_config('app.platform_admin_id', ${platformUserId}::text, false)
    `;
    expect(
      await testDb().select().from(reconciliationCases).where(eq(reconciliationCases.id, caseA.id)),
    ).toHaveLength(0);

    await testSql()`SELECT auth_set_public_context(${ids.orgId}::uuid)`;
    expect(await testDb().select().from(reconciliationCases)).toHaveLength(0);
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCases).values({
          organizationId: ids.orgId,
          paymentId: payment.id,
          kind: 'TO_MATCH',
          state: 'UNMATCHED',
          createdBy: ids.aliceId,
        }),
      ['42501'],
    );

    await testSql()`SELECT enter_platform_context(${platformUserId}::uuid)`;
    expect(
      await testDb().select().from(reconciliationCases).where(eq(reconciliationCases.id, caseA.id)),
    ).toHaveLength(1);
  });

  it('does not reopen terminal cases when the payment has no derived reconciliation work', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctx, 'CONFIRMED', 50_000);
    const caseRow = await getOrCreateCase(testDb(), ctx, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 50_000,
      unallocatedKobo: 50_000,
    });
    await addEvidence(testDb(), ctx, {
      caseId: caseRow.id,
      kind: 'OPERATOR_NOTE',
      note: 'Terminal review evidence.',
    });
    await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'RECONCILED',
      close: true,
      resolutionCode: 'NO_FINANCIAL_ACTION',
      resolutionNote: 'No further reconciliation work.',
      auditAction: 'test.terminal',
    });
    await expect(
      getOrCreateCase(testDb(), ctx, {
        id: payment.id as UUID,
        status: 'CONFIRMED',
        amountKobo: 50_000,
        unallocatedKobo: 0,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await testDb()
        .select()
        .from(reconciliationCases)
        .where(eq(reconciliationCases.paymentId, payment.id)),
    ).toHaveLength(1);
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCandidates).values({
          organizationId: ids.orgId,
          caseId: caseRow.id,
          studentId: ids.studentAId,
          basis: 'Late candidate must be rejected.',
          state: 'PROPOSED',
          createdBy: ids.aliceId,
        }),
      ['23514'],
    );
  });

  it('enforces tenant isolation for queue visibility and cross-tenant case writes', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctxA: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctxA, 'CONFIRMED', 50_000);
    const caseA = await getOrCreateCase(testDb(), ctxA, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 50_000,
      unallocatedKobo: 50_000,
    });
    await addEvidence(testDb(), ctxA, {
      caseId: caseA.id,
      kind: 'OPERATOR_NOTE',
      note: 'Tenant A evidence.',
    });
    await createAcceptedCandidate(testDb(), ctxA, {
      caseId: caseA.id,
      studentId: ids.studentAId,
      basis: 'Tenant A candidate.',
    });
    const queueA = await listQueue(testDb(), ctxA);
    expect(queueA.rows.every((row) => row.organizationId === ids.orgId)).toBe(true);

    const ctxB: TenantCtx = { organizationId: ids.orgBId, userId: ids.bobId };
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCases).values({
          organizationId: ids.orgBId,
          paymentId: payment.id,
          kind: 'TO_MATCH',
          state: 'UNMATCHED',
          createdBy: ids.bobId,
        }),
      ['42501', '23514', '23503'],
    );

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    await testSql()`SELECT set_config('app.is_platform_admin', '1', false), set_config('app.platform_admin_id', '', false)`;
    expect(await testDb().select().from(reconciliationCases)).toHaveLength(0);
    expect(await testDb().select().from(reconciliationEvidence)).toHaveLength(0);
    expect(await testDb().select().from(reconciliationCandidates)).toHaveLength(0);
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCases).values({
          organizationId: ids.orgId,
          paymentId: payment.id,
          kind: 'TO_MATCH',
          state: 'UNMATCHED',
          createdBy: ids.bobId,
        }),
      ['42501', '23514'],
    );
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const queueB = await listQueue(testDb(), ctxB);
    expect(queueB.rows).toHaveLength(0);
    expect(
      await testDb().select().from(reconciliationCases).where(eq(reconciliationCases.id, caseA.id)),
    ).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(reconciliationEvidence)
        .where(eq(reconciliationEvidence.caseId, caseA.id)),
    ).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(reconciliationCandidates)
        .where(eq(reconciliationCandidates.caseId, caseA.id)),
    ).toHaveLength(0);
    expect(
      await testDb()
        .update(reconciliationCases)
        .set({ reason: 'foreign mutation' })
        .where(eq(reconciliationCases.id, caseA.id))
        .returning(),
    ).toHaveLength(0);
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationEvidence).values({
          organizationId: ids.orgBId,
          caseId: caseA.id,
          kind: 'OPERATOR_NOTE',
          note: 'Foreign evidence.',
          createdBy: ids.bobId,
        }),
      ['42501', '23514', '23503'],
    );
    await expectPgFailure(
      () =>
        testDb().insert(reconciliationCandidates).values({
          organizationId: ids.orgBId,
          caseId: caseA.id,
          studentId: ids.studentBId,
          basis: 'Foreign candidate.',
          createdBy: ids.bobId,
        }),
      ['42501', '23514', '23503'],
    );
  });

  it('reflects a fully allocated authoritative payment as a closed ALLOCATED case', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const invoice = await invoicesRepo.createDraft(testDb(), ctx, {
      studentId: ids.studentAId,
      termId: ids.termId,
      sessionId: ids.sessionId,
    });
    await invoiceLinesRepo.addLines(testDb(), ctx, invoice.id, [
      {
        description: 'M10 allocation target',
        quantity: 1,
        unitRateKobo: kobo(100_000),
        amountKobo: kobo(100_000),
      },
    ]);
    const issued = await invoicesRepo.issue(testDb(), ctx, invoice.id);
    const payment = await seedPayment(testDb(), ctx, 'CONFIRMED', 100_000);
    const caseRow = await getOrCreateCase(testDb(), ctx, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 100_000,
      unallocatedKobo: 100_000,
    });
    await addEvidence(testDb(), ctx, {
      caseId: caseRow.id,
      kind: 'OPERATOR_NOTE',
      note: 'Invoice and payment manually linked.',
    });
    await createAcceptedCandidate(testDb(), ctx, {
      caseId: caseRow.id,
      studentId: ids.studentAId,
      invoiceId: issued.id,
      basis: 'Human-reviewed invoice match.',
    });
    const allocation = await allocationsRepo.allocate(testDb(), ctx, {
      paymentId: payment.id,
      invoiceId: issued.id,
      amountKobo: kobo(100_000),
    });
    expect(allocation.payment.unallocatedKobo).toBe(0);
    expect(allocation.invoice.status).toBe('PAID');
    const closed = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'ALLOCATED',
      kind: 'TO_ALLOCATE',
      close: true,
      auditAction: 'reconciliation.allocate',
    });
    expect(closed.state).toBe('ALLOCATED');
    expect(closed.closedAt).toBeTruthy();
  });

  it('rejects illegal, stale, and closed transitions at the database/service boundary', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctx, 'CONFIRMED', 80_000);
    const caseRow = await getOrCreateCase(testDb(), ctx, {
      id: payment.id as UUID,
      status: payment.status,
      amountKobo: 80_000,
      unallocatedKobo: 80_000,
    });

    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases SET state = 'ALLOCATED' WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
    const first = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'FLAGGED',
      reason: 'Review',
      auditAction: 'test.flag',
    });
    expect(first.state).toBe('FLAGGED');
    await expectPgFailure(
      () =>
        updateCaseState(testDb(), ctx, {
          caseId: caseRow.id,
          state: 'ALLOCATED',
          auditAction: 'test.illegal',
        }),
      ['23514', 'CONFLICT'],
    );
    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases
          SET state = 'UNMATCHED', previous_state = 'RECONCILED', version = version + 1
        WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
    const unflagged = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'UNMATCHED',
      previousState: null,
      reason: 'Reviewed',
      auditAction: 'test.unflag',
    });
    expect(unflagged.state).toBe('UNMATCHED');
    await addEvidence(testDb(), ctx, {
      caseId: caseRow.id,
      kind: 'OPERATOR_NOTE',
      note: 'Closeout review completed.',
    });
    const acceptedCandidate = await createAcceptedCandidate(testDb(), ctx, {
      caseId: caseRow.id,
      studentId: ids.studentAId,
      basis: 'Candidate established for allocation-guard regression.',
    });
    const secondPayment = await seedPayment(testDb(), ctx, 'CONFIRMED', 20_000);
    const secondCase = await getOrCreateCase(testDb(), ctx, {
      id: secondPayment.id as UUID,
      status: secondPayment.status,
      amountKobo: 20_000,
      unallocatedKobo: 20_000,
    });
    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_candidates
          SET case_id = ${secondCase.id}::uuid
        WHERE id = ${acceptedCandidate.id}::uuid`,
      ['23514', '42501'],
    );
    const allocationGuardError = await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases
          SET state = 'ALLOCATED', closed_at = now(), resolved_by = ${ids.aliceId}::uuid,
              resolved_at = now(), version = version + 1
        WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
    expect(allocationGuardError.message).toMatch(/fully allocated confirmed payment/i);
    const reconciled = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'RECONCILED',
      auditAction: 'test.reconciled',
    });
    expect(reconciled.state).toBe('RECONCILED');
    const flaggedAgain = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'FLAGGED',
      previousState: 'RECONCILED',
      reason: 'Second review',
      auditAction: 'test.flag_again',
    });
    expect(flaggedAgain.state).toBe('FLAGGED');
    const restored = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'RECONCILED',
      previousState: null,
      reason: 'Second review complete',
      auditAction: 'test.restore_reconciled',
    });
    expect(restored.state).toBe('RECONCILED');
    const closed = await updateCaseState(testDb(), ctx, {
      caseId: caseRow.id,
      state: 'RECONCILED',
      close: true,
      resolutionCode: 'NO_FINANCIAL_ACTION',
      resolutionNote: 'No change.',
      auditAction: 'test.close',
    });
    expect(closed.closedAt).toBeTruthy();
    await expectPgFailure(
      () =>
        updateCaseState(testDb(), ctx, {
          caseId: caseRow.id,
          state: 'FLAGGED',
          auditAction: 'test.closed',
        }),
      ['CONFLICT'],
    );
    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases
          SET reason = 'direct terminal history rewrite', version = version + 1
        WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
    await expectPgFailure(
      () =>
        testSql()`UPDATE reconciliation_cases
          SET closed_at = NULL, version = version + 1
        WHERE id = ${caseRow.id}::uuid`,
      ['23514'],
    );
  });
});

describe('M10 reconciliation control plane — concurrent case creation', () => {
  let fixture: ConcurrencyFixtures | undefined;
  const connections: Array<{ sql: postgres.Sql; db: ReturnType<typeof drizzle> }> = [];

  afterEach(async () => {
    await Promise.all(
      connections.splice(0).map(async ({ sql }) => {
        await sql`SELECT clear_app_context()`.catch(() => {});
        await sql.end({ timeout: 5 });
      }),
    );
    await fixture?.teardown();
    fixture = undefined;
  });

  it('converges concurrent open-case creation to one case per payment', async () => {
    fixture = await setupConcurrencyFixtures();
    const open = async () => {
      const sql = postgres(URL, { max: 1 });
      await sql`SELECT set_tenant_context(${fixture!.orgId}::uuid, ${fixture!.userId}::uuid)`;
      const db = drizzle(sql);
      connections.push({ sql, db });
      return {
        sql,
        db,
        ctx: { organizationId: fixture!.orgId, userId: fixture!.userId } as TenantCtx,
      };
    };
    const a = await open();
    const payment = await paymentsRepo.record(a.db as any, a.ctx, {
      method: 'BANK_TRANSFER',
      amountKobo: 90_000 as any,
      initialStatus: 'CONFIRMED',
      reference: `M10-CONCURRENT-${randomUUID()}`,
    });
    const b = await open();
    const [caseA, caseB] = await Promise.all([
      reconciliationRepo.ensureOpenCase(a.db as any, a.ctx, {
        paymentId: payment.id as UUID,
        kind: 'TO_ALLOCATE',
      }),
      reconciliationRepo.ensureOpenCase(b.db as any, b.ctx, {
        paymentId: payment.id as UUID,
        kind: 'TO_ALLOCATE',
      }),
    ]);
    expect(caseA.id).toBe(caseB.id);
    const visible = await fixture.asTenant(
      async (sql) =>
        sql<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM reconciliation_cases WHERE payment_id = ${payment.id}::uuid AND closed_at IS NULL`,
    );
    expect(visible[0]!.n).toBe('1');
    await addEvidence(a.db as any, a.ctx, {
      caseId: caseA.id as UUID,
      kind: 'OPERATOR_NOTE',
      note: 'Concurrent candidate review evidence.',
    });

    const candidateResults = await Promise.allSettled([
      createAcceptedCandidate(a.db as any, a.ctx, {
        caseId: caseA.id as UUID,
        studentId: fixture.studentId,
        basis: 'Concurrent operator decision A',
      }),
      createAcceptedCandidate(b.db as any, b.ctx, {
        caseId: caseA.id as UUID,
        studentId: fixture.studentId,
        basis: 'Concurrent operator decision B',
      }),
    ]);
    expect(candidateResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(candidateResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const queueWithCandidate = await listQueue(a.db as any, a.ctx, { limit: 10 });
    expect(queueWithCandidate.rows.find((row) => row.paymentId === payment.id)).toMatchObject({
      studentName: 'Cc Student',
    });
    const candidateCounts = await fixture.asTenant(
      async (sql) =>
        sql<{ accepted: string; total: string }[]>`SELECT
          count(*) FILTER (WHERE state = 'ACCEPTED')::text AS accepted,
          count(*)::text AS total
        FROM reconciliation_candidates
        WHERE case_id = ${caseA.id}::uuid`,
    );
    expect(candidateCounts[0]!.accepted).toBe('1');
    expect(candidateCounts[0]!.total).toBe('1');
  }, 60000);
});
