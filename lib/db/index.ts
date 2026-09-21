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
 * The onconnect hook enforces that the application runtime role has
 * `search_path = pg_catalog, public`, resets tenant GUCs, and refuses to
 * run if the session user somehow has BYPASSRLS or SUPERUSER.
 */
import 'server-only';

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serverEnv } from '@/lib/security/env';
import * as schema from './schema';

if (!serverEnv.db.url) {
  // Lazy-fail: throw when getDb()/getSql() is called, not at import time,
  // so static generation of non-DB routes still works.
}

const globalForDb = globalThis as unknown as {
  _scolairaSql?: postgres.Sql;
  _scolairaDb?: ReturnType<typeof createDb>;
};

function createDb(sql: postgres.Sql) {
  return drizzle(sql, { schema, logger: serverEnv.nodeEnv === 'development' });
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
    // Pool is constrained to a single connection because all GUC-based
    // tenant/security context (app.organization_id, app.auth_bootstrap, …)
    // is scoped to a connection. Until every request path obtains a
    // reserved connection for its whole lifetime (post-M5 hardening), a
    // pool larger than 1 risks RLS-context leakage or default-deny between
    // setSystemContext() and the subsequent query. This is safe for SCOLAIRA
    // because (a) Next.js already serialises request handlers per process
    // and (b) the workload is low-concurrency school admin traffic.
    max: 1,
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
        // Reset tenant GUCs to a known-clean state so even a misbehaving
        // prior connection cannot leak context. (The login role is already
        // scolaira_app; no SET ROLE needed.)
        await client.simple(`
          SET SESSION app.organization_id = '';
          SET SESSION app.user_id = '';
          SET SESSION app.acting_role = '';
          SET SESSION app.is_platform_admin = '0';
          SET SESSION app.platform_admin_id = '';
          SET SESSION app.platform_token = '';
          SET SESSION app.auth_bootstrap = '0';
          SET SESSION app.bypass_financial_triggers = '0';
          SET SESSION app.tenant_token = '';
        `);
      }
    },
  } as any);
  globalForDb._scolairaSql = sql;
  globalForDb._scolairaDb = createDb(sql);
  return sql;
}

export type Sql = postgres.Sql;

/** Get the raw postgres client (for migrations and hand-tuned SQL). */
export function getSql(): postgres.Sql {
  return getOrCreateSql();
}

export type Database = ReturnType<typeof createDb>;

export function getDb(): Database {
  const sql = getOrCreateSql();
  if (!globalForDb._scolairaDb) {
    globalForDb._scolairaDb = createDb(sql);
  }
  return globalForDb._scolairaDb!;
}

export async function closeDb(): Promise<void> {
  if (globalForDb._scolairaSql) {
    await globalForDb._scolairaSql.end({ timeout: 5 });
    globalForDb._scolairaSql = undefined;
    globalForDb._scolairaDb = undefined;
  }
}
