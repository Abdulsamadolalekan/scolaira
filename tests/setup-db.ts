/**
 * Per-test DB setup.
 *
 * Runs in a setupFile AFTER global-setup-db has migrated the test DB.
 * Before each test, we BEGIN a transaction; after each test we ROLLBACK, so
 * every test starts from a clean, migrated schema. The test pool is
 * configured with max:1 (see lib/db), which guarantees that GUCs set by
 * setSystemContext / setTenantFor on one query are visible to the next
 * query within the same test (single-connection pool + per-test BEGIN).
 */
import { beforeEach, afterEach, afterAll } from 'vitest';
import { getDb, getSql, closeDb } from '@/lib/db';
import type { Database } from '@/lib/db';

beforeEach(async () => {
  const sql = getSql();
  // Wipe SECDEF-persisted rate limits / login attempts before each test
  // (they would otherwise survive ROLLBACK).
  await sql`SELECT auth_clear_rate_limits()`.catch(() => {});
  await sql`DELETE FROM login_attempts`.catch(() => {});
  // Defensive reset for any leaked session state.
  await sql`RESET ALL`.catch(() => {});
  await sql`BEGIN`;
});

afterEach(async () => {
  const sql = getSql();
  try {
    await sql`ROLLBACK`;
    await sql`SELECT clear_app_context()`.catch(() => {});
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
