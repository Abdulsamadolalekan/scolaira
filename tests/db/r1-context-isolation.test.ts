// @vitest-environment node
/**
 * R1 (C-1) — authorization context isolation under concurrency.
 *
 * The pre-R1 defect (proved against the frozen tree): tenant context was
 * written with SESSION scope on whatever pooled connection happened to serve
 * the statement, and cleanup was a best-effort application-level clear of five
 * variables. A statement issued later on that connection — by an unrelated
 * request — could therefore run under a previous tenant's identity.
 *
 * These tests are adversarial: they do not inspect the implementation, they
 * attack the boundary with concurrent connections and forged GUCs, and they
 * assert on what the database actually returns.
 *
 * NOTE ON POOLS: the per-test harness pins one connection (`max: 1`) for its
 * own transaction, so concurrency cannot be observed there. These tests build
 * their own pools — including a multi-connection pool — and pass them to
 * `withScopedDb(..., { client })`, which is exactly how the R1 tests prove
 * isolation does not depend on the pool size.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { withScopedDb, withSystemContext } from '@/lib/db/tenant';
import { getRootSql, getSql } from '@/lib/db';
import { CONTEXT_GUCS } from '@/lib/db/context';
import { setupConcurrencyFixtures, type ConcurrencyFixtures } from '../support/concurrent-seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

/**
 * H-6: use the CONFIGURED database, verbatim.
 *
 * This used to rewrite whatever `DATABASE_URL` said into `…/scolaira_test`. The
 * effect was that the suite read one database while seeding fixtures into
 * another whenever the environment pointed elsewhere — measured as nine failures
 * ("User … is not an active member of organization …") when the suite was run
 * against a dedicated CI database, and a silent risk of asserting against the
 * wrong database when the names happened to line up. A verification suite must
 * exercise the database it was told to use.
 */
const APP_URL =
  process.env.DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';

function makePool(max: number): postgres.Sql {
  return postgres(APP_URL, {
    max,
    onconnect: async (client: any) => {
      await client.simple(`SET search_path = pg_catalog, public;`);
    },
  } as any);
}

/** Read every identity-bearing GUC from whichever connection serves the call. */
async function contextOf(sql: postgres.Sql): Promise<Record<string, string | null>> {
  const cols = CONTEXT_GUCS.map(
    (name, i) => `NULLIF(current_setting('${name}', true), '') AS c${i}`,
  ).join(', ');
  const rows = (await sql.unsafe(`SELECT ${cols}`)) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  const out: Record<string, string | null> = {};
  CONTEXT_GUCS.forEach((name, i) => {
    const v = row[`c${i}`];
    out[name] = v === null || v === undefined ? null : String(v);
  });
  return out;
}

/**
 * Neutrality of a single context variable.
 *
 * A connection is neutral when it carries no identity. Empty is neutral; the
 * explicit `'0'` written by `clear_app_context()` / the pool's connection hook
 * for the boolean authorization flags is also neutral — what matters is that
 * no variable can authorize anything, which the tests additionally prove by
 * asking the DATABASE (row counts and `auth_is_tenant_authorized()`).
 */
const BOOLEAN_GUCS = new Set([
  'app.is_platform_admin',
  'app.auth_bootstrap',
  'app.bypass_financial_triggers',
  'app.public_context',
]);

function isNeutralValue(name: string, value: string | null): boolean {
  if (value === null || value === '') return true;
  if (BOOLEAN_GUCS.has(name)) return value === '0';
  return false;
}

/**
 * Prove neutrality by inspecting EVERY connection the pool owns, not just the
 * one a forked `unsafe()` call happens to land on. Connections are reserved
 * (which takes them out of general circulation), read, and released.
 */
async function expectPoolNeutral(pool: postgres.Sql, size: number): Promise<void> {
  const held: any[] = [];
  try {
    for (let i = 0; i < size; i++) held.push(await pool.reserve());
    const states = await Promise.all(held.map((c) => contextOf(c as unknown as postgres.Sql)));
    for (const state of states) {
      expect(Object.entries(state).filter(([name, v]) => !isNeutralValue(name, v))).toEqual([]);
    }
  } finally {
    for (const c of held) c.release();
  }
}

async function insertInvoice(fx: ConcurrencyFixtures, pool: postgres.Sql, amount: number) {
  const ctx: TenantCtx = { organizationId: fx.orgId, userId: fx.userId };
  return withScopedDb(
    { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
    async (db, sql) => {
      const inv = await invoicesRepo.createDraft(db as any, ctx, {
        studentId: fx.studentId,
        termId: fx.termId,
        sessionId: fx.sessionId,
      });
      await invoiceLinesRepo.addLines(db as any, ctx, inv.id, [
        { description: 'R1', quantity: 1, unitRateKobo: kobo(amount), amountKobo: kobo(amount) },
      ]);
      const issued = await invoicesRepo.issue(db as any, ctx, inv.id);
      const pid = ((await sql.unsafe(`SELECT pg_backend_pid() AS pid`)) as any[])[0].pid;
      return {
        id: issued.id as unknown as UUID,
        invoiceNumber: issued.invoiceNumber,
        pid: Number(pid),
      };
    },
    { client: pool },
  );
}

async function readInvoiceIds(pool: postgres.Sql, fx: ConcurrencyFixtures) {
  return withScopedDb(
    { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
    async (_db, sql) => {
      const rows = (await sql.unsafe(
        `SELECT id::text AS id FROM invoices WHERE organization_id = $1::uuid`,
        [fx.orgId],
      )) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
    { client: pool },
  );
}

const multiPool = makePool(4);
const singlePool = makePool(1);
let fxA: ConcurrencyFixtures;
let fxB: ConcurrencyFixtures;

// Committed fixtures on their own connections: concurrent scopes cannot see
// another connection's uncommitted writes, so the adversarial cases below need
// data that genuinely exists in the database.
beforeAll(async () => {
  fxA = await setupConcurrencyFixtures();
  fxB = await setupConcurrencyFixtures();
}, 60_000);

afterAll(async () => {
  // Fixtures are committed (concurrent connections cannot see uncommitted
  // writes) and, like tests/db/concurrency.test.ts, are intentionally not
  // torn down row-by-row: financial rows are append-only by design, and the
  // global test setup drops the schema before every run.
  const sql = getRootSql();
  await sql`SELECT clear_app_context()`.catch(() => {});
  await multiPool.end({ timeout: 5 });
  await singlePool.end({ timeout: 5 });
});

describe('R1 C-1 — context is bound to the connection that runs the queries', () => {
  it('getSql(), the callback handle and the reserved connection are the same backend', async () => {
    const result = await withScopedDb(
      { kind: 'tenant', organizationId: fxA.orgId, userId: fxA.userId },
      async (_db, sql) => {
        const fromArg = ((await sql.unsafe(`SELECT pg_backend_pid() AS pid`)) as any[])[0].pid;
        const fromGetSql = ((await getSql().unsafe(`SELECT pg_backend_pid() AS pid`)) as any[])[0]
          .pid;
        const authorized = (await sql.unsafe(`SELECT auth_is_tenant_authorized() AS ok`)) as any[];
        return { fromArg: Number(fromArg), fromGetSql: Number(fromGetSql), ok: authorized[0].ok };
      },
      { client: multiPool },
    );
    expect(result.fromArg).toBe(result.fromGetSql);
    expect(result.ok).toBe(true);
  });

  it('a scope holds an EXCLUSIVE connection when the pool can spare one', async () => {
    let insidePid = 0;
    await withScopedDb(
      { kind: 'tenant', organizationId: fxA.orgId, userId: fxA.userId },
      async (_db, sql) => {
        insidePid = Number(((await sql.unsafe(`SELECT pg_backend_pid() AS pid`)) as any[])[0].pid);
        // A second consumer of the same pool gets a DIFFERENT connection, so it
        // cannot be scheduled onto the scope's connection.
        const other = await multiPool.reserve();
        try {
          const otherPid = Number(
            ((await other.unsafe(`SELECT pg_backend_pid() AS pid`)) as any[])[0].pid,
          );
          expect(otherPid).not.toBe(insidePid);
          const state = await contextOf(other as unknown as postgres.Sql);
          expect(Object.values(state).every((v) => v === null)).toBe(true);
        } finally {
          other.release();
        }
      },
      { client: multiPool },
    );
  });

  it('connection reuse cannot inherit context: the pooled connection is neutral afterwards', async () => {
    const fx = fxA;
    const used = await insertInvoice(fx, multiPool, 100_000);
    // The scope released its (dirty-if-buggy) connection back to the pool; do a
    // lot of unrelated statements so the pool reuses it, then check both the
    // visible context and what the database will actually expose.
    for (let i = 0; i < 6; i++) {
      await multiPool`SELECT 1 AS x`;
    }
    await expectPoolNeutral(multiPool, 4);

    const visible = (await multiPool.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[];
    expect(visible[0].n).toBe(0);
    expect(used.id).toBeTruthy();
  });
});

describe('R1 C-1 — concurrent requests for different tenants', () => {
  it('interleaved scopes on separate connections never see or mutate each other', async () => {
    const a = fxA;
    const b = fxB;

    const invA = await insertInvoice(a, multiPool, 500_000);
    const invB = await insertInvoice(b, multiPool, 700_000);

    const observations: Array<{
      round: number;
      who: string;
      own: string[];
      foreignHit: number;
      foreignMutated: number;
      ctxOrg: string | null;
    }> = [];

    const attack = (
      round: number,
      fx: ConcurrencyFixtures,
      ownInvoiceId: string,
      foreignInvoiceId: string,
      who: string,
    ) =>
      withScopedDb(
        { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
        async (_db, sql) => {
          // Yield between statements so the other tenant's scope interleaves.
          await new Promise((r) => setTimeout(r, 3));
          const ctxOrg = (
            (await sql.unsafe(
              `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
            )) as any[]
          )[0].org;
          const own = (await sql.unsafe(
            `SELECT id::text AS id FROM invoices WHERE organization_id = $1::uuid`,
            [fx.orgId],
          )) as Array<{ id: string }>;
          await new Promise((r) => setTimeout(r, 3));
          // Reading the other tenant's invoice by its real UUID must return nothing.
          const foreignHit = (
            (await sql.unsafe(`SELECT count(*)::int AS n FROM invoices WHERE id = $1::uuid`, [
              foreignInvoiceId,
            ])) as any[]
          )[0].n;
          // Attempting to mutate it must affect nothing.
          const foreignMutated = (
            (await sql.unsafe(
              `UPDATE invoices SET updated_at = now() WHERE id = $1::uuid RETURNING id`,
              [foreignInvoiceId],
            )) as any[]
          ).length;
          const ownCheck = own.map((r) => r.id);
          expect(ownCheck).toContain(ownInvoiceId);
          expect(ownCheck).not.toContain(foreignInvoiceId);
          observations.push({
            round,
            who,
            own: ownCheck,
            foreignHit: Number(foreignHit),
            foreignMutated,
            ctxOrg,
          });
          return null;
        },
        { client: multiPool },
      );

    await Promise.all(
      Array.from({ length: 8 }).flatMap((_v, i) => [
        attack(i, a, invA.id, invB.id, 'A'),
        attack(i, b, invB.id, invA.id, 'B'),
      ]),
    );

    expect(observations).toHaveLength(16);
    for (const o of observations) {
      const expectedOrg = o.who === 'A' ? a.orgId : b.orgId;
      expect(o.ctxOrg).toBe(expectedOrg);
      expect(o.foreignHit).toBe(0);
      expect(o.foreignMutated).toBe(0);
      expect(o.own).toContain(o.who === 'A' ? invA.id : invB.id);
    }

    // The two scopes ran on different backends (real concurrency, not
    // serialization): both invoice inserts reported their own backend.
    expect(invA.pid).not.toBe(invB.pid);
    // And no cross-tenant write survived.
    const aIds = await readInvoiceIds(multiPool, a);
    const bIds = await readInvoiceIds(multiPool, b);
    expect(aIds).not.toContain(invB.id);
    expect(bIds).not.toContain(invA.id);
  });

  it('single-connection pools serialize scopes instead of sharing a transaction', async () => {
    const fx = fxA;
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];

    const job = (tag: string) =>
      withScopedDb(
        { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
        async (_db, sql) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const org = (
            (await sql.unsafe(
              `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
            )) as any[]
          )[0].org;
          seen.push(`${tag}:${org}`);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return null;
        },
        { client: singlePool },
      );

    await Promise.all([job('1'), job('2'), job('3'), job('4')]);

    // Every scope saw its own tenant context and none of them overlapped: with
    // a single connection, scopes are serialized rather than allowed to share a
    // transaction — correctness does not depend on the pool size.
    expect(maxActive).toBe(1);
    expect(seen).toHaveLength(4);
    for (const entry of seen) {
      const [tag, org] = entry.split(':');
      expect(tag).toMatch(/^[1-4]$/);
      expect(org).toBe(fx.orgId);
    }
  });

  it('nested scopes restore the enclosing tenant context', async () => {
    const a = fxA;
    const b = fxB;
    const result = await withScopedDb(
      { kind: 'tenant', organizationId: a.orgId, userId: a.userId },
      async (_db, sql) => {
        const outerBefore = (
          (await sql.unsafe(
            `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
          )) as any[]
        )[0].org;
        const inner = await withScopedDb(
          { kind: 'tenant', organizationId: b.orgId, userId: b.userId },
          async (_innerDb, innerSql) => {
            const rows = (await innerSql.unsafe(
              `SELECT id::text AS id FROM invoices WHERE organization_id = $1::uuid`,
              [b.orgId],
            )) as Array<{ id: string }>;
            const org = (
              (await innerSql.unsafe(
                `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
              )) as any[]
            )[0].org;
            return { org, count: rows.length };
          },
          { client: multiPool },
        );
        const outerAfter = (
          (await sql.unsafe(
            `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
          )) as any[]
        )[0].org;
        const outerRows = (await sql.unsafe(
          `SELECT id::text AS id FROM invoices WHERE organization_id = $1::uuid`,
          [a.orgId],
        )) as Array<{ id: string }>;
        return { outerBefore, outerAfter, inner, outerCount: outerRows.length };
      },
      { client: multiPool },
    );

    expect(result.outerBefore).toBe(a.orgId);
    expect(result.inner.org).toBe(b.orgId);
    expect(result.inner.count).toBeGreaterThan(0);
    // The enclosing scope is restored and can still read its own tenant rows.
    expect(result.outerAfter).toBe(a.orgId);
    expect(result.outerCount).toBeGreaterThan(0);
  });
});

describe('R1 C-1 — forged, stale and absent context fail closed', () => {
  it('a cold connection sees nothing on tenant tables', async () => {
    const rows = (await getRootSql().unsafe(
      `SELECT (SELECT count(*)::int FROM invoices) AS invoices,
              (SELECT count(*)::int FROM students) AS students,
              (SELECT count(*)::int FROM payments) AS payments`,
    )) as any[];
    expect(rows[0]).toEqual({ invoices: 0, students: 0, payments: 0 });
  });

  it('forged GUCs do not authorize anything (session layer and inside a transaction)', async () => {
    const fx = fxA;
    // (a) session-scoped forgery, pinned to one connection
    const forged = await multiPool.reserve();
    let rows: any[];
    try {
      const attacker = forged as unknown as postgres.Sql;
      await attacker.unsafe(
        `SELECT set_config('app.organization_id', $1, false), set_config('app.user_id', $2, false), set_config('app.tenant_token', 'forged', false)`,
        [fx.orgId, fx.userId],
      );
      rows = (await attacker.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[];
      const authz = (await attacker.unsafe(`SELECT auth_is_tenant_authorized() AS ok`)) as any[];
      expect(authz[0].ok).toBe(false);
      await attacker.unsafe(`SELECT clear_app_context()`);
    } finally {
      forged.release();
    }
    expect(rows![0].n).toBe(0);

    // (b) transaction-local forgery, which is the layer a legitimate scope uses
    const inTxn = await multiPool.begin(async (tx: any) => {
      await tx.unsafe(
        `SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true), set_config('app.tenant_token', 'forged', true)`,
        [fx.orgId, fx.userId],
      );
      const n = ((await tx.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[])[0].n;
      const visible = ((await tx.unsafe(`SELECT count(*)::int AS n FROM students`)) as any[])[0].n;
      return { n: Number(n), visible: Number(visible) };
    });
    expect(inTxn.n).toBe(0);
    expect(inTxn.visible).toBe(0);
    await expectPoolNeutral(multiPool, 4);
  });

  it('a non-member cannot obtain tenant context', async () => {
    const a = fxA;
    const b = fxB;
    await expect(
      withScopedDb(
        { kind: 'tenant', organizationId: b.orgId, userId: a.userId },
        async () => null,
        { client: multiPool },
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a scope whose callback throws leaves the connection neutral and its writes rolled back', async () => {
    const fx = fxA;
    const marker = randomUUID();

    await expect(
      withScopedDb(
        { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
        async (_db, sql) => {
          await sql.unsafe(
            `INSERT INTO students (organization_id, student_id, first_name, last_name, status) VALUES ($1::uuid, $2, 'R1', 'Rollback', 'ACTIVE')`,
            [fx.orgId, `R1RB-${marker.slice(0, 8)}`],
          );
          throw new Error('boom');
        },
        { client: multiPool },
      ),
    ).rejects.toThrow('boom');

    // No leak of context, and the aborted write is gone.
    await expectPoolNeutral(multiPool, 4);
    const left = await withScopedDb(
      { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
      async (_db, sql) => {
        const rows = (await sql.unsafe(
          `SELECT count(*)::int AS n FROM students WHERE student_id = $1`,
          [`R1RB-${marker.slice(0, 8)}`],
        )) as any[];
        return Number(rows[0].n);
      },
      { client: multiPool },
    );
    expect(left).toBe(0);
  });

  it('a session-scoped write attempted inside a scope cannot survive it', async () => {
    const a = fxA;
    const b = fxB;
    // Simulates legacy code (or an attacker with SQL access through the app
    // role) writing context at session scope from inside a scope's callback.
    await withScopedDb(
      { kind: 'tenant', organizationId: a.orgId, userId: a.userId },
      async (_db, sql) => {
        await sql.unsafe(
          `SELECT set_config('app.organization_id', $1, false), set_config('app.user_id', $2, false), set_config('app.tenant_token', 'legacy', false), set_config('app.acting_role', 'OWNER', false)`,
          [b.orgId, b.userId],
        );
        return null;
      },
      { client: multiPool },
    );

    for (let i = 0; i < 4; i++) await multiPool`SELECT 1 AS x`;
    await expectPoolNeutral(multiPool, 4);
    const rows = (await multiPool.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[];
    expect(rows[0].n).toBe(0);
  });

  it('legacy session-scoped setters called inside a scope cannot outlive it', async () => {
    const a = fxA;
    const b = fxB;
    // `set_tenant_context` is the pre-R1 entry point; migration 0039 makes it
    // scope-aware so an in-scope call writes at the transaction-local layer and
    // is reverted with the scope instead of silently surviving on the pool.
    await withScopedDb(
      { kind: 'tenant', organizationId: a.orgId, userId: a.userId },
      async (_db, sql) => {
        await sql.unsafe(`SELECT set_tenant_context($1::uuid, $2::uuid)`, [b.orgId, b.userId]);
        const inner = (
          (await sql.unsafe(
            `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
          )) as any[]
        )[0].org;
        expect(inner).toBe(b.orgId);
        return null;
      },
      { client: multiPool },
    );

    await expectPoolNeutral(multiPool, 4);
    const rows = (await multiPool.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[];
    expect(rows[0].n).toBe(0);
  });

  it('system scope gives bootstrap visibility of identity tables only', async () => {
    const fx = fxA;
    const result = await withScopedDb(
      { kind: 'system' },
      async (_db, sql) => {
        const users = (await sql.unsafe(`SELECT count(*)::int AS n FROM users`)) as any[];
        const members = (await sql.unsafe(
          `SELECT count(*)::int AS n FROM organization_members`,
        )) as any[];
        const invoices = (await sql.unsafe(`SELECT count(*)::int AS n FROM invoices`)) as any[];
        const payments = (await sql.unsafe(`SELECT count(*)::int AS n FROM payments`)) as any[];
        return {
          users: Number(users[0].n),
          members: Number(members[0].n),
          invoices: Number(invoices[0].n),
          payments: Number(payments[0].n),
        };
      },
      { client: multiPool },
    );
    expect(result.users).toBeGreaterThan(0);
    expect(result.members).toBeGreaterThan(0);
    // Identity tables: yes. Financial tenancy: no.
    expect(result.invoices).toBe(0);
    expect(result.payments).toBe(0);
    expect(fx.orgId).toBeTruthy();
  });
});

describe('R1 C-1 — the shared (harness) connection is neutral after every scope', () => {
  it('withSystemContext and withTenant leave no context on the pool', async () => {
    const fx = fxA;
    const sql = getSql();
    await withSystemContext(null, null, async () => null);
    let state = await contextOf(sql);
    expect(Object.entries(state).filter(([, v]) => v !== null)).toEqual([]);

    await withScopedDb(
      { kind: 'tenant', organizationId: fx.orgId, userId: fx.userId },
      async (_db, scopedSql) => {
        const org = (
          (await scopedSql.unsafe(
            `SELECT NULLIF(current_setting('app.organization_id', true), '') AS org`,
          )) as any[]
        )[0].org;
        expect(org).toBe(fx.orgId);
        return null;
      },
    );
    state = await contextOf(sql);
    expect(Object.entries(state).filter(([, v]) => v !== null)).toEqual([]);
  });
});
