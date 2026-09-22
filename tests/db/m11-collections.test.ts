// @vitest-environment node
/** M11 collections workflow, tenant isolation, live-financial reads, and races. */
import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  testDb,
  testSql,
  enableSavepointTransactionsForTest,
  disableSavepointTransactionsForTest,
} from '../setup-db';
import { seedTwoOrgs } from '../support/seed';
import { setupConcurrencyFixtures, type ConcurrencyFixtures } from '../support/concurrent-seed';
import { withSystemContext } from '@/lib/db/tenant';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as collectionsRepo from '@/lib/db/repo/collections';
import * as reminderRepo from '@/lib/db/repo/reminders';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import { collectionsCaseEvents, reconciliationCandidates } from '@/lib/db/schema';
import { kobo } from '@/lib/money';
import type { Database } from '@/lib/db';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

type Fixture = Awaited<ReturnType<typeof seedTwoOrgs>>;

const runtimeUrl =
  process.env.DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';

async function expectPgFailure(fn: () => Promise<unknown>): Promise<unknown> {
  const name = `m11_${randomUUID().replaceAll('-', '')}`;
  await testSql().unsafe(`SAVEPOINT ${name}`);
  let error: unknown;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  await testSql().unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
  await testSql().unsafe(`RELEASE SAVEPOINT ${name}`);
  expect(error).toBeTruthy();
  return error;
}

async function seedOutstanding(ids: Fixture): Promise<{
  ids: Fixture;
  ctx: TenantCtx;
  invoiceId: UUID;
  caseRow: collectionsRepo.CollectionsCase;
}> {
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  const ctx: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
  const invoice = await invoicesRepo.createDraft(testDb(), ctx, {
    studentId: ids.studentAId,
    termId: ids.termId,
    sessionId: ids.sessionId,
  });
  await invoiceLinesRepo.addLines(testDb(), ctx, invoice.id, [
    {
      description: 'M11 tuition',
      quantity: 1,
      unitRateKobo: kobo(100_000),
      amountKobo: kobo(100_000),
    },
  ]);
  const issued = await invoicesRepo.issue(testDb(), ctx, invoice.id);
  const caseRow = await collectionsRepo.createCase(testDb(), ctx, {
    studentId: ids.studentAId,
    priority: 'HIGH',
    reason: 'Follow up on open term invoice',
    requestId: 'm11-seed',
  });
  return { ids, ctx, invoiceId: issued.id, caseRow };
}

describe('M11 collections operational control plane', () => {
  afterEach(() => disableSavepointTransactionsForTest());

  it('creates only against a live outstanding obligation and reads current financial truth without shadow balances', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ctx, invoiceId, caseRow } = await seedOutstanding(ids);

    expect(caseRow.state).toBe('OPEN');
    expect(caseRow.version).toBe(0);
    expect(caseRow).not.toHaveProperty('balanceKobo');
    expect(caseRow).not.toHaveProperty('paidKobo');

    const queueBefore = await collectionsRepo.listQueue(testDb(), ctx);
    expect(queueBefore).toHaveLength(1);
    expect(queueBefore[0]).toMatchObject({ id: caseRow.id, outstandingKobo: 100_000 });

    const payment = await paymentsRepo.record(testDb(), ctx, {
      method: 'BANK_TRANSFER',
      amountKobo: kobo(40_000),
      reference: `M11-${randomUUID()}`,
    });
    await allocationsRepo.allocate(testDb(), ctx, {
      paymentId: payment.id,
      invoiceId,
      amountKobo: kobo(40_000),
    });

    const queueAfter = await collectionsRepo.listQueue(testDb(), ctx);
    expect(queueAfter[0]?.outstandingKobo).toBe(60_000);
    const detail = await collectionsRepo.getCaseDetail(testDb(), ctx, caseRow.id);
    expect(detail.obligations[0]?.outstandingKobo).toBe(60_000);
    expect(detail.payments.map((row) => row.allocationAmountKobo)).toContain(40_000);

    const finalPayment = await paymentsRepo.record(testDb(), ctx, {
      method: 'BANK_TRANSFER',
      amountKobo: kobo(60_000),
      reference: `M11-FINAL-${randomUUID()}`,
    });
    await allocationsRepo.allocate(testDb(), ctx, {
      paymentId: finalPayment.id,
      invoiceId,
      amountKobo: kobo(60_000),
    });
    const zeroBalanceQueue = await collectionsRepo.listQueue(testDb(), ctx);
    expect(zeroBalanceQueue[0]?.outstandingKobo).toBe(0);
    const zeroBalanceDetail = await collectionsRepo.getCaseDetail(testDb(), ctx, caseRow.id);
    expect(zeroBalanceDetail.case.state).toBe('OPEN');
    expect(zeroBalanceDetail.case.outstandingKobo).toBe(0);
    expect(zeroBalanceDetail.obligations[0]?.outstandingKobo).toBe(0);
  });

  it('shows candidate-linked unallocated M10 context without closing or allocating the collections case', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ctx, caseRow } = await seedOutstanding(ids);
    const payment = await paymentsRepo.record(testDb(), ctx, {
      method: 'BANK_TRANSFER',
      amountKobo: kobo(25_000),
      reference: `M11-UNALLOCATED-${randomUUID()}`,
    });
    const reconciliationCase = await reconciliationRepo.ensureOpenCase(testDb(), ctx, {
      paymentId: payment.id,
      kind: 'TO_MATCH',
      reason: 'Candidate-linked unallocated payment audit',
    });
    await testDb().insert(reconciliationCandidates).values({
      organizationId: ids.orgId,
      caseId: reconciliationCase.id,
      studentId: ids.studentAId,
      basis: 'Explicit student candidate for M11 audit',
      createdBy: ids.aliceId,
    });

    const detail = await collectionsRepo.getCaseDetail(testDb(), ctx, caseRow.id);
    expect(detail.case.state).toBe('OPEN');
    expect(detail.case.outstandingKobo).toBe(100_000);
    expect(detail.reconciliation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reconciliationCase.id,
          paymentNumber: payment.paymentNumber,
          paymentStatus: 'CONFIRMED',
          unallocatedKobo: 25_000,
        }),
      ]),
    );
    const unchangedPayment = await paymentsRepo.get(testDb(), ctx, payment.id);
    expect(unchangedPayment?.unallocatedKobo).toBe(25_000);
  });

  it('enforces one active student case per episode and allows a new case after immutable closure', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ctx, caseRow } = await seedOutstanding(ids);

    const duplicateError = await collectionsRepo
      .createCase(testDb(), ctx, {
        studentId: ids.studentAId,
        priority: 'NORMAL',
        reason: 'Second active episode must be rejected.',
      })
      .then(() => null)
      .catch((error: unknown) => error);
    const duplicateCause = duplicateError as {
      code?: string;
      cause?: { code?: string };
    };
    expect(duplicateCause.code ?? duplicateCause.cause?.code).toBe('23505');

    const resolved = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'RESOLVED',
      note: 'First episode resolved.',
      expectedVersion: 0,
    });
    const closed = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'CLOSED',
      note: 'First episode closed.',
      expectedVersion: resolved.version,
    });
    expect(closed.state).toBe('CLOSED');

    const nextEpisode = await collectionsRepo.createCase(testDb(), ctx, {
      studentId: ids.studentAId,
      priority: 'HIGH',
      reason: 'Later collection episode.',
    });
    expect(nextEpisode.id).not.toBe(caseRow.id);
    expect(nextEpisode.state).toBe('OPEN');
  });

  it('records PRINT as delivered while unsupported reminder channels remain pending', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ctx, invoiceId } = await seedOutstanding(ids);
    const base = {
      invoiceId,
      studentId: ids.studentAId,
      balanceKobo: 100_000,
      agingDays: 10,
      agingBucket: 'OVERDUE_30' as const,
      body: 'M11 reminder lifecycle test',
    };

    const sms = await reminderRepo.create(testDb(), ctx, { ...base, channel: 'SMS' });
    expect(sms.status).toBe('PENDING');
    expect(sms.sentAt).toBeNull();
    const print = await reminderRepo.create(testDb(), ctx, { ...base, channel: 'PRINT' });
    expect(print.status).toBe('SENT');
    expect(print.sentAt).toBeInstanceOf(Date);

    const directSentError = await expectPgFailure(async () => {
      await testSql()`
        INSERT INTO reminders (
          id, organization_id, invoice_id, student_id, channel, status,
          balance_kobo, aging_days, aging_bucket, body, created_by
        ) VALUES (
          ${randomUUID()}::uuid, ${ids.orgId}::uuid, ${invoiceId}::uuid,
          ${ids.studentAId}::uuid, 'EMAIL', 'SENT', 100000, 10,
          'OVERDUE_30', 'unsupported direct send', ${ids.aliceId}::uuid
        )
      `;
    });
    const directCause = directSentError as { code?: string; cause?: { code?: string } };
    expect(directCause.code ?? directCause.cause?.code).toBe('23514');
  });

  it('rejects forged same-tenant actors at the database boundary', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { caseRow } = await seedOutstanding(ids);
    const forgedActorId = randomUUID() as UUID;

    await withSystemContext(null, null, async () => {
      await testSql()`
        INSERT INTO users (id, email, first_name, last_name)
        VALUES (${forgedActorId}::uuid, ${`forged-${forgedActorId}@example.test`}, 'Forged', 'Actor')
      `;
      await testSql()`
        INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
        VALUES (${ids.orgId}::uuid, ${forgedActorId}::uuid, 'FINANCE_OFFICER', 'ACTIVE', now())
      `;
    });
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    const forgedEventError = await expectPgFailure(async () => {
      await testSql()`
        INSERT INTO collections_case_events (
          organization_id, case_id, event_type, note, created_by
        ) VALUES (
          ${ids.orgId}::uuid, ${caseRow.id}::uuid, 'NOTE',
          'forged actor event', ${forgedActorId}::uuid
        )
      `;
    });
    const forgedEventCause = forgedEventError as { code?: string; cause?: { code?: string } };
    expect(forgedEventCause.code ?? forgedEventCause.cause?.code).toBe('23514');

    const forgedResolutionError = await expectPgFailure(async () => {
      await testSql()`
        UPDATE collections_cases
           SET state = 'RESOLVED', resolved_by = ${forgedActorId}::uuid,
               resolved_at = now(), version = version + 1
         WHERE id = ${caseRow.id}::uuid
      `;
    });
    const forgedResolutionCause = forgedResolutionError as {
      code?: string;
      cause?: { code?: string };
    };
    expect(forgedResolutionCause.code ?? forgedResolutionCause.cause?.code).toBe('23514');
  });

  it('enforces the explicit lifecycle, optimistic versions, append-only history, and audit rows', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ctx, caseRow } = await seedOutstanding(ids);

    const inProgress = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'IN_PROGRESS',
      note: 'Bursary has started review.',
      expectedVersion: 0,
      requestId: 'm11-t1',
    });
    expect(inProgress.state).toBe('IN_PROGRESS');
    expect(inProgress.version).toBe(1);

    const escalated = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'ESCALATED',
      note: 'Escalate after first-line follow-up.',
      expectedVersion: 1,
      requestId: 'm11-escalate',
    });
    expect(escalated.state).toBe('ESCALATED');
    expect(escalated.version).toBe(2);

    await expect(
      collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
        toState: 'CLOSED',
        note: 'Invalid close attempt.',
        expectedVersion: 2,
        requestId: 'm11-invalid',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const resolved = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'RESOLVED',
      note: 'Payment arrangement recorded.',
      expectedVersion: 2,
      requestId: 'm11-t2',
    });
    expect(resolved.resolvedBy).toBe(ids.aliceId);
    const closed = await collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
      toState: 'CLOSED',
      note: 'Obligation follow-up completed.',
      expectedVersion: 3,
      requestId: 'm11-t3',
    });
    expect(closed.state).toBe('CLOSED');

    await expect(
      collectionsRepo.addCaseEvent(testDb(), ctx, caseRow.id, {
        eventType: 'NOTE',
        note: 'Should be rejected after closure.',
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      collectionsRepo.transitionCase(testDb(), ctx, caseRow.id, {
        toState: 'OPEN',
        note: 'Closed cases cannot reopen.',
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const eventRows = await testDb()
      .select()
      .from(collectionsCaseEvents)
      .where(eq(collectionsCaseEvents.caseId, caseRow.id));
    expect(eventRows.map((row) => row.eventType)).toEqual(
      expect.arrayContaining(['CREATED', 'STATE_CHANGE', 'RESOLVED', 'CLOSED']),
    );
    const deleteError = await expectPgFailure(() =>
      testDb().delete(collectionsCaseEvents).where(eq(collectionsCaseEvents.id, eventRows[0]!.id)),
    );
    const deleteCause = deleteError as { code?: string; cause?: { code?: string } };
    expect(deleteCause.code ?? deleteCause.cause?.code).toMatch(/42501|insufficient_privilege/);

    const updateError = await expectPgFailure(async () => {
      await testSql()`
        UPDATE collections_case_events
           SET note = 'forged historical rewrite'
         WHERE id = ${eventRows[0]!.id}::uuid
      `;
    });
    const updateCause = updateError as { code?: string; cause?: { code?: string } };
    expect(updateCause.code ?? updateCause.cause?.code).toMatch(/42501|insufficient_privilege/);

    const closedCaseError = await expectPgFailure(async () => {
      await testSql()`
        UPDATE collections_cases
           SET priority = 'URGENT', version = version + 1
         WHERE id = ${caseRow.id}::uuid
      `;
    });
    const closedCaseCause = closedCaseError as { code?: string; cause?: { code?: string } };
    expect(closedCaseCause.code ?? closedCaseCause.cause?.code).toBe('23514');
  });

  it('does not expose or accept another tenant case, even with a valid foreign UUID', async () => {
    enableSavepointTransactionsForTest();
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { caseRow } = await seedOutstanding(ids);

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const bobCtx: TenantCtx = { organizationId: ids.orgBId, userId: ids.bobId };
    await expect(collectionsRepo.getCaseDetail(testDb(), bobCtx, caseRow.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(
      collectionsRepo.createCase(testDb(), bobCtx, {
        studentId: ids.studentAId,
        priority: 'NORMAL',
        reason: 'Forged cross-tenant create',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const rows = await testDb()
      .select()
      .from(collectionsCaseEvents)
      .where(eq(collectionsCaseEvents.caseId, caseRow.id));
    expect(rows.length).toBeGreaterThan(0);
  });
});

async function withRepoConnection<T>(
  orgId: UUID,
  userId: UUID,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const sql = postgres(runtimeUrl, { max: 1 });
  try {
    await sql`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
    return await fn(drizzle(sql) as unknown as Database);
  } finally {
    await sql`SELECT set_config('app.organization_id', '', false), set_config('app.user_id', '', false), set_config('app.is_platform_admin', '0', false)`.catch(
      () => {},
    );
    await sql.end({ timeout: 5 });
  }
}

describe('M11 case concurrency', () => {
  let fixtures: ConcurrencyFixtures | undefined;

  afterEach(async () => {
    if (fixtures) await fixtures.teardown();
  });

  it('serializes concurrent opens for one student across independent connections', async () => {
    fixtures = await setupConcurrencyFixtures();
    const ctx: TenantCtx = { organizationId: fixtures.orgId, userId: fixtures.userId };
    await withRepoConnection(fixtures.orgId, fixtures.userId, async (db) => {
      const invoice = await invoicesRepo.createDraft(db, ctx, {
        studentId: fixtures!.studentId,
        termId: fixtures!.termId,
        sessionId: fixtures!.sessionId,
      });
      await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
        {
          description: 'Concurrent case open',
          quantity: 1,
          unitRateKobo: kobo(15_000),
          amountKobo: kobo(15_000),
        },
      ]);
      await invoicesRepo.issue(db, ctx, invoice.id);
    });

    const outcomes = await Promise.all(
      [1, 2].map((worker) =>
        withRepoConnection(fixtures!.orgId, fixtures!.userId, (db) =>
          collectionsRepo.createCase(db, ctx, {
            studentId: fixtures!.studentId,
            priority: 'NORMAL',
            reason: `Concurrent open worker ${worker}`,
          }),
        )
          .then(() => 'won')
          .catch((error: unknown) => {
            const typed = error as { code?: string; cause?: { code?: string } };
            return typed.code ?? typed.cause?.code ?? 'failed';
          }),
      ),
    );

    expect(outcomes.filter((value) => value === 'won')).toHaveLength(1);
    expect(outcomes.filter((value) => value === '23505')).toHaveLength(1);
  });

  it('serializes two stale transitions: exactly one request wins', async () => {
    fixtures = await setupConcurrencyFixtures();
    const ctx: TenantCtx = { organizationId: fixtures.orgId, userId: fixtures.userId };
    const created = await withRepoConnection(fixtures.orgId, fixtures.userId, async (db) => {
      const invoice = await invoicesRepo.createDraft(db, ctx, {
        studentId: fixtures!.studentId,
        termId: fixtures!.termId,
        sessionId: fixtures!.sessionId,
      });
      await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
        { description: 'Race', quantity: 1, unitRateKobo: kobo(20_000), amountKobo: kobo(20_000) },
      ]);
      await invoicesRepo.issue(db, ctx, invoice.id);
      return collectionsRepo.createCase(db, ctx, {
        studentId: fixtures!.studentId,
        priority: 'NORMAL',
        reason: 'Race test',
      });
    });

    const outcomes = await Promise.all(
      [
        withRepoConnection(fixtures.orgId, fixtures.userId, (db) =>
          collectionsRepo.transitionCase(db, ctx, created.id, {
            toState: 'IN_PROGRESS',
            note: 'Worker one',
            expectedVersion: 0,
          }),
        ),
        withRepoConnection(fixtures.orgId, fixtures.userId, (db) =>
          collectionsRepo.transitionCase(db, ctx, created.id, {
            toState: 'IN_PROGRESS',
            note: 'Worker two',
            expectedVersion: 0,
          }),
        ),
      ].map(async (promise) => {
        try {
          await promise;
          return 'won';
        } catch (error) {
          return (error as { code?: string }).code ?? 'failed';
        }
      }),
    );

    expect(outcomes.filter((value) => value === 'won')).toHaveLength(1);
    expect(outcomes.filter((value) => value === 'CONFLICT')).toHaveLength(1);
  });

  it('serializes reassignment and closure races with the same optimistic version guard', async () => {
    fixtures = await setupConcurrencyFixtures();
    const ctx: TenantCtx = { organizationId: fixtures.orgId, userId: fixtures.userId };
    const created = await withRepoConnection(fixtures.orgId, fixtures.userId, async (db) => {
      const invoice = await invoicesRepo.createDraft(db, ctx, {
        studentId: fixtures!.studentId,
        termId: fixtures!.termId,
        sessionId: fixtures!.sessionId,
      });
      await invoiceLinesRepo.addLines(db, ctx, invoice.id, [
        {
          description: 'Assignment race',
          quantity: 1,
          unitRateKobo: kobo(30_000),
          amountKobo: kobo(30_000),
        },
      ]);
      await invoicesRepo.issue(db, ctx, invoice.id);
      return collectionsRepo.createCase(db, ctx, {
        studentId: fixtures!.studentId,
        priority: 'HIGH',
        reason: 'Assignment and closure race',
      });
    });

    const assignmentOutcomes = await Promise.all(
      [1, 2].map(() =>
        withRepoConnection(fixtures!.orgId, fixtures!.userId, (db) =>
          collectionsRepo.assignCase(db, ctx, created.id, {
            assigneeId: fixtures!.userId,
            expectedVersion: 0,
          }),
        )
          .then(() => 'won')
          .catch((error) => (error as { code?: string }).code ?? 'failed'),
      ),
    );
    expect(assignmentOutcomes.filter((value) => value === 'won')).toHaveLength(1);
    expect(assignmentOutcomes.filter((value) => value === 'CONFLICT')).toHaveLength(1);

    const resolutionOutcomes = await Promise.all(
      [1, 2].map(() =>
        withRepoConnection(fixtures!.orgId, fixtures!.userId, (db) =>
          collectionsRepo.transitionCase(db, ctx, created.id, {
            toState: 'RESOLVED',
            note: 'Concurrent resolution worker.',
            expectedVersion: 1,
          }),
        )
          .then(() => 'won')
          .catch((error) => (error as { code?: string }).code ?? 'failed'),
      ),
    );
    expect(resolutionOutcomes.filter((value) => value === 'won')).toHaveLength(1);
    expect(resolutionOutcomes.filter((value) => value === 'CONFLICT')).toHaveLength(1);

    const closeOutcomes = await Promise.all(
      [1, 2].map(() =>
        withRepoConnection(fixtures!.orgId, fixtures!.userId, (db) =>
          collectionsRepo.transitionCase(db, ctx, created.id, {
            toState: 'CLOSED',
            note: 'Concurrent close worker.',
            expectedVersion: 2,
          }),
        )
          .then(() => 'won')
          .catch((error) => (error as { code?: string }).code ?? 'failed'),
      ),
    );
    expect(closeOutcomes.filter((value) => value === 'won')).toHaveLength(1);
    expect(closeOutcomes.filter((value) => value === 'CONFLICT')).toHaveLength(1);
  });
});
