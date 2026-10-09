/**
 * Helpers for concurrency tests that need a SECOND Postgres connection
 * (simulating two simultaneous bursar requests / webhook deliveries).
 *
 * The default `testDb()` connection is shared across the test and is pinned
 * inside a per-test BEGIN/ROLLBACK. A second connection cannot see uncommitted
 * writes, so concurrency tests must COMMIT their setup on the separate
 * connection and clean up explicitly (we use a unique org per test via seed
 * and rely on the global setup recreating the schema between vitest runs,
 * plus manual cleanup for committed rows).
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Database } from '@/lib/db';

const url =
  process.env.DATABASE_URL ??
  'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';

/**
 * Run `fn` with a dedicated Postgres connection (not the shared per-test one).
 * The connection is closed after the callback returns.
 *
 * NOTE: the callback runs on a connection that does NOT participate in the
 * per-test transaction. Any writes it COMMITS will persist after the test's
 * ROLLBACK — callers must pass `shouldCleanup=true` (default) to drop rows by
 * org/session id at the end, OR scope their fixture data with unique IDs
 * (which we do by seeding fresh orgs per concurrency test, but that is slow;
 * instead we accept that concurrency tests run against a migrated DB and
 * leave no critical state because each test creates its own org and cleans
 * it up).
 */
export async function withSeparateConnection<T>(
  fn: (args: { sql: postgres.Sql; db: Database }) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql) as unknown as Database;
    return await fn({ sql, db });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
