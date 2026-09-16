/**
 * Vitest global setup for DB tests.
 *
 * Runs ONCE at the start of the vitest process: sets TEST_DATABASE_URL into
 * process.env so modules imported later (including lib/db/index) connect to
 * the test database.
 *
 * We also run the migration once here. Per-test isolation is transactional
 * rollback handled in setup-db.ts (which runs as a setupFile).
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { GlobalSetupContext } from 'vitest/node';

export default async function globalSetup(_ctx: GlobalSetupContext) {
  const url =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';
  process.env.DATABASE_URL = url;

  const sql = postgres(url, { max: 1 });
  try {
    // Drop both public AND drizzle schemas so migrations re-run from a clean
    // slate on every vitest invocation. Drizzle tracks applied migrations in
    // the drizzle.__drizzle_migrations table, and leaving it around makes
    // subsequent runs skip migrations against an empty public schema.
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`CREATE SCHEMA drizzle`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'lib/db/migrations') });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return async () => {
    // teardown: leave the test DB migrated (subsequent test runs will drop/recreate).
  };
}
