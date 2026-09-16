/**
 * Per-test DB setup.
 *
 * Runs in a setupFile AFTER global-setup-db has migrated the test DB.
 * Before each test, we BEGIN a transaction; after each test we ROLLBACK, so
 * every test starts from a clean, migrated schema.
 *
 * Tests must use testDb() / testSql() to access the connection.
 */
import { beforeEach, afterEach, afterAll } from 'vitest';
import { getDb, getSql, closeDb } from '@/lib/db';
import type { Database } from '@/lib/db';

beforeEach(async () => {
  const sql = getSql();
  // Defensive reset: wipe any role/session state that leaked from a prior
  // test (e.g. SET ROLE or SET LOCAL applied at the session level in a test
  // that crashed/aborted before cleanup).
  await sql`RESET ALL`.catch(() => {});
  await sql`BEGIN`;
});

afterEach(async () => {
  const sql = getSql();
  try {
    // ROLLBACK undoes any SET LOCAL within the transaction; additionally
    // RESET ROLE here guarantees a stray SET ROLE (non-LOCAL) from a test
    // that forgot to clean up does not leak into the next test's connection.
    await sql`ROLLBACK`;
    await sql`RESET ROLE`.catch(() => {});
  } catch {
    // already terminated
  }
});

afterAll(async () => {
  await closeDb();
});

export function testDb(): Database {
  return getDb();
}
export function testSql(): ReturnType<typeof getSql> {
  return getSql();
}
