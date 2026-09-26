/**
 * Database client.
 *
 * Two connection strings exist for security principal separation:
 *
 *   DATABASE_URL
 *     Runtime application credential. Connects as `scolaira_app` —
 *     NOSUPERUSER, NOBYPASSRLS, least privilege. RLS IS ENFORCED against
 *     this role. Every HTTP request runs under this principal.
 *
 *   DATABASE_MIGRATION_URL
 *     Migration/bootstrap credential. Connects as `scolaira_owner` — may
 *     create schemas, tables, functions, roles. Used ONLY by migrations
 *     (scripts/migrate.ts, tests/global-setup-db.ts) and one-time
 *     provisioning. NEVER used by request handlers.
 *
 * R1 (C-1) — CONTEXT ISOLATION
 * ----------------------------
 * Authorization context lives in Postgres GUCs, which are a property of a
 * *connection*. Before R1 this module served everything from a pool pinned to
 * `max: 1`, which made "the connection" implicitly shared and left context
 * lifecycle to application cleanup.
 *
 * Isolation is now provided by `lib/db/scope.ts::runScoped()`:
 *
 *   - a request reserves an exclusive connection for its whole lifetime;
 *   - context is applied inside a transaction with transaction-local
 *     semantics, so Postgres reverts it;
 *   - the reserved client is published through AsyncLocalStorage, so
 *     `getSql()`/`getDb()` below resolve to that exact connection;
 *   - teardown reads every context variable back and fails closed if the
 *     connection cannot be proven neutral.
 *
 * The pool size is therefore NOT a security boundary (see
 * `SCOLAIRA_DB_POOL_MAX`). The `onconnect` hook additionally resets the full
 * context registry on every newly established connection as defence in depth,
 * and refuses to run at all if the session role can bypass RLS.
 *
 * `getSql()` / `getDb()` called OUTSIDE a scope return the shared pool handle.
 * That is correct for migration/test/administrative work that deliberately has
 * no tenant context, and it is what the RLS default-deny policies expect.
 */
import 'server-only';

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serverEnv } from '@/lib/security/env';
import * as schema from './schema';
import { CONTEXT_GUCS } from './context';
import { currentScope } from './scope-registry';

if (!serverEnv.db.url) {
  // Lazy-fail: throw when getDb()/getSql() is called, not at import time,
  // so static generation of non-DB routes still works.
}

const globalForDb = globalThis as unknown as {
  _scolairaSql?: postgres.Sql;
  _scolairaDb?: ReturnType<typeof createDb>;
};

/**
 * Pool size.
 *
 * This is NOT a security boundary. Before R1 the whole isolation model rested
 * on it being 1 (a single implicit connection made "the connection" the same
 * for everything); the readiness audit proved that this leaves context on the
 * connection for whoever uses it next. Isolation now comes from per-scope
 * connection reservation + transaction-local context + verified teardown
 * (lib/db/scope.ts), and the R1 test-suite proves it with a pool larger than 1.
 *
 * The default stays 1 because the integration harness pins one connection for
 * its per-test transaction (tests/setup-db.ts). Deployments set
 * SCOLAIRA_DB_POOL_MAX to match their connection budget.
 */
const POOL_MAX = (() => {
  const raw = process.env.SCOLAIRA_DB_POOL_MAX;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return 1;
})();

function createDb(sql: postgres.Sql) {
  return drizzle(sql, { schema, logger: serverEnv.nodeEnv === 'development' });
}

/** The SQL that returns every context variable to its empty default. */
function resetContextSql(): string {
  return CONTEXT_GUCS.map((name) => `SET SESSION ${name} = '';`).join('\n          ');
}

function getOrCreateSql(): postgres.Sql {
  if (globalForDb._scolairaSql) return globalForDb._scolairaSql;
  if (!serverEnv.db.url) {
    throw new Error(
      'DATABASE_URL is not set. Configure it in .env.local before accessing the database.',
    );
  }
  const isBootstrap = process.env.SCOLAIRA_BOOTSTRAP === '1';
  const url = isBootstrap ? (serverEnv.db.migrationUrl ?? serverEnv.db.url) : serverEnv.db.url;
  const sql = postgres(url, {
    // Isolation does NOT rely on this number. Requests reserve an exclusive
    // connection for their whole lifetime; see lib/db/scope.ts.
    max: POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    // `onconnect` is supported at runtime by postgres.js v3 but is not
    // yet exposed in its published .d.ts; cast through any to keep the
    // types happy. The hook fires once per fresh connection from the
    // pool (verified in tests/auth/runtime-role-safety.test.ts).
    onconnect: async (client: any) => {
      await client.simple(`SET search_path = pg_catalog, public;`);
      if (!isBootstrap) {
        // DEFENSE IN DEPTH: refuse to run if the session has SUPERUSER or
        // BYPASSRLS. This is a hard fail-fast guard, not just a config
        // check — it prevents any future misconfiguration (bad
        // credentials, swapped URL, superuser grant) from silently
        // disabling RLS at runtime.
        const res: Array<Record<string, unknown>> = await client.unsafe(`
          SELECT rolsuper::text, rolbypassrls::text
            FROM pg_roles
           WHERE rolname = current_user;
        `);
        const row = (Array.isArray(res) ? res[0] : undefined) as
          { rolsuper?: unknown; rolbypassrls?: unknown } | undefined;
        if (!row) {
          throw new Error(
            'DATABASE SECURITY FAILURE: could not read role attributes for current_user',
          );
        }
        if (String(row.rolsuper) === 't' || String(row.rolbypassrls) === 't') {
          throw new Error(
            'DATABASE SECURITY FAILURE: runtime DB principal is SUPERUSER or has BYPASSRLS. ' +
              'Tenant RLS cannot be enforced. Refusing to start. ' +
              '(Use DATABASE_MIGRATION_URL for migrations; DATABASE_URL must be the least-privileged role.)',
          );
        }
        // Reset the FULL context registry to a known-clean state so a
        // connection cannot be born carrying another request's identity.
        // (The login role is already scolaira_app; no SET ROLE needed.)
        await client.simple(resetContextSql());
      }
    },
  } as any);
  globalForDb._scolairaSql = sql;
  globalForDb._scolairaDb = createDb(sql);
  return sql;
}

export type Sql = postgres.Sql;

/**
 * The shared pool handle, ignoring any active scope.
 *
 * Used by the scope machinery itself (to reserve a connection) and by
 * migration/administrative code. Application code should call `getSql()`.
 */
export function getRootSql(): postgres.Sql {
  return getOrCreateSql();
}

/**
 * Get the raw postgres client for the current execution context.
 *
 * Inside a scope this is the request's exclusively reserved connection — the
 * one whose transaction carries the request's authorization context.
 */
export function getSql(): postgres.Sql {
  const scoped = currentScope();
  return (scoped?.sql as postgres.Sql | undefined) ?? getOrCreateSql();
}

export type Database = ReturnType<typeof createDb>;

/**
 * Get the drizzle handle for the current execution context.
 *
 * Inside a scope this is bound to the request's reserved connection; outside a
 * scope it is the shared pool handle.
 */
export function getDb(): Database {
  const scoped = currentScope();
  if (scoped) return scoped.db as unknown as Database;
  const sql = getOrCreateSql();
  if (!globalForDb._scolairaDb) {
    globalForDb._scolairaDb = createDb(sql);
  }
  return globalForDb._scolairaDb!;
}

/** Pool size in effect (diagnostics/tests only). */
export function poolSize(): number {
  return POOL_MAX;
}

export async function closeDb(): Promise<void> {
  if (globalForDb._scolairaSql) {
    await globalForDb._scolairaSql.end({ timeout: 5 });
    globalForDb._scolairaSql = undefined;
    globalForDb._scolairaDb = undefined;
  }
}
