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
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import { reconciliationCases, reconciliationEvidence } from '@/lib/db/schema';
import {
  addEvidence,
  countEvidence,
  getOrCreateCase,
  listQueue,
  updateCaseState,
} from '@/lib/reconciliation';
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

  it('enforces tenant isolation for queue visibility and cross-tenant case writes', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const ctxA: TenantCtx = { organizationId: ids.orgId, userId: ids.aliceId };
    const payment = await seedPayment(testDb(), ctxA, 'CONFIRMED', 50_000);
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
    const queueB = await listQueue(testDb(), ctxB);
    expect(queueB.rows).toHaveLength(0);
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
  }, 60000);
});
