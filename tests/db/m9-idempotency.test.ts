// @vitest-environment node
/** M9 idempotency concurrency against separate real PostgreSQL sessions. */
import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { setupConcurrencyFixtures, type ConcurrencyFixtures } from '../support/concurrent-seed';
import { begin, complete } from '@/lib/m9/idempotency';
import type { TenantCtx } from '@/lib/db/repo/_context';

const URL = process.env.DATABASE_URL ?? 'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';

type TestConnection = { sql: postgres.Sql; db: ReturnType<typeof drizzle> };

async function openTenant(orgId: string, userId: string): Promise<TestConnection> {
  const sql = postgres(URL, { max: 1 });
  await sql`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
  return { sql, db: drizzle(sql) };
}

async function closeTenant(connection: TestConnection): Promise<void> {
  await connection.sql`SELECT clear_app_context()`.catch(() => {});
  await connection.sql.end({ timeout: 5 });
}

describe('M9 idempotency — real concurrent sessions', () => {
  let fixture: ConcurrencyFixtures | undefined;
  const connections: TestConnection[] = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(closeTenant));
    await fixture?.teardown();
    fixture = undefined;
  });

  it('serializes the same key, replays the committed winner, and rejects key reuse', async () => {
    fixture = await setupConcurrencyFixtures();
    const ctx: TenantCtx = { organizationId: fixture.orgId, userId: fixture.userId } as TenantCtx;
    const key = `m9-concurrent-${fixture.orgId}`;
    const path = '/api/classes';
    const payload = { name: 'same-request' };
    const request = () => new Request('http://test.local/api/classes', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(payload),
    });

    const first = await openTenant(fixture.orgId, fixture.userId);
    const second = await openTenant(fixture.orgId, fixture.userId);
    connections.push(first, second);

    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });

    const winner = first.db.transaction(async (tx) => {
      const result = await begin(tx as any, ctx, request(), { scope: 'class.create', path, payload });
      expect(result.replay).toBeNull();
      acquired();
      await releasePromise;
      await complete(tx as any, ctx, result.key, 201, { class: { id: 'winner' } });
      return result.key;
    });

    await acquiredPromise;
    const loser = second.db.transaction(async (tx) => {
      const result = await begin(tx as any, ctx, request(), { scope: 'class.create', path, payload });
      return result.replay;
    });

    // The second INSERT waits on the first transaction's unique-key outcome;
    // it must not abort its transaction with a raw 23505.
    release();
    expect(await winner).toBe(key);
    const replay = await loser;
    expect(replay).not.toBeNull();
    expect(replay!.status).toBe(201);
    expect(replay!.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay!.json()).toEqual({ class: { id: 'winner' } });

    const third = await openTenant(fixture.orgId, fixture.userId);
    connections.push(third);
    const reused = await third.db.transaction(async (tx) => begin(tx as any, ctx, request(), {
      scope: 'class.create', path, payload: { name: 'different-request' },
    }));
    expect(reused.replay).not.toBeNull();
    expect(reused.replay!.status).toBe(409);
    expect(await reused.replay!.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const visible = await fixture.asTenant(async (sql) => sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM idempotency_keys
       WHERE organization_id = ${fixture!.orgId}::uuid
         AND user_id = ${fixture!.userId}::uuid
         AND key = ${key}
    `);
    expect(Number(visible[0]!.count)).toBe(1);
  }, 60000);
});
