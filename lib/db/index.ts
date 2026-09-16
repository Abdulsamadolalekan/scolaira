/**
 * Database client.
 *
 * - Server-only (enforced via `server-only` import).
 * - Singleton across hot reloads in dev.
 * - Uses the `postgres` JS driver (fast, native types, good serverless support).
 * - Returns a Drizzle instance wired to all tables in `./schema`.
 */
import 'server-only';

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serverEnv } from '@/lib/security/env';
import * as schema from './schema';

// Fail fast at import time if DATABASE_URL is not set. This prevents mysterious
// runtime errors later; in M1 previews (which don't hit the DB) the import is
// behind the NavShell demo routes that don't call getDb, but the module can
// still be loaded as long as DATABASE_URL exists.
if (!serverEnv.db.url) {
  // Allow static-generation of non-DB routes (e.g. primitives preview) during
  // build by only throwing when getDb() is actually called.
  // Mark this as a lazy-fail module.
}

// Global singleton so Next.js HMR in dev doesn't create a new pool per request.
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
  const sql = postgres(serverEnv.db.url, {
    max: serverEnv.nodeEnv === 'test' ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Keep BIGINT as number (we use safe-integer kobo, never > MAX_SAFE_INTEGER).
    // For values that could exceed 2^53-1 (e.g. aggregate counts beyond 9Q), we
    // cast explicitly at the query. 90 trillion naira = 9 quadrillion kobo is
    // well over; in practice SCOLAIRA never approaches this.
    //
    // NOTE: `postgres` v3 ships column-type defaults on the exported `postgres`
    // namespace via `postgres.types`, not `postgres.defaults`. BIGINT is already
    // returned as a JS number by default; we do not override the transform.
    // Prefer prepared statements for better perf on repeat queries.
    prepare: true,
  });
  globalForDb._scolairaSql = sql;
  globalForDb._scolairaDb = createDb(sql);
  return sql;
}

export type Sql = postgres.Sql;

/**
 * Get the raw postgres client (for migrations and hand-tuned SQL).
 * Most callers should use `getDb()` for typed queries.
 */
export function getSql(): postgres.Sql {
  return getOrCreateSql();
}

/** Database type (Drizzle) — importable for repo function signatures. */
export type Database = ReturnType<typeof createDb>;

/**
 * Returns the singleton Drizzle database instance.
 *
 * Throws if DATABASE_URL is missing. Should only be called from server
 * components / route handlers / server-side services.
 */
export function getDb(): Database {
  const sql = getOrCreateSql();
  if (!globalForDb._scolairaDb) {
    globalForDb._scolairaDb = createDb(sql);
  }
  return globalForDb._scolairaDb!;
}

/**
 * Close the pool (used in tests / scripts / shutdown hooks).
 */
export async function closeDb(): Promise<void> {
  if (globalForDb._scolairaSql) {
    await globalForDb._scolairaSql.end({ timeout: 5 });
    globalForDb._scolairaSql = undefined;
    globalForDb._scolairaDb = undefined;
  }
}
