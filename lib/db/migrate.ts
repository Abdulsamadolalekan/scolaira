/**
 * Database migration runner.
 *
 * There are TWO public entry points that both invoke the same underlying
 * migration logic:
 *
 *   1. `lib/db/migrate.ts` (this file) — imported by the Next.js runtime
 *      (e.g. instrumentation.ts auto-migrates in dev) and exposes helpers
 *      that can be called from server-only code. It relies on `server-only`
 *      and imports from `@/lib/security/env`.
 *
 *   2. `scripts/migrate.ts` — a standalone Node script runnable via
 *      `npx tsx scripts/migrate.ts` from CI/CD or production hosts. It does
 *      NOT import anything from Next.js; it has a tiny inline .env loader so
 *      the script can run without a built Next.js bundle. Both entry points
 *      apply migrations from the same folder and write to the same drizzle
 *      journal table (`drizzle.__drizzle_migrations`) — there is exactly ONE
 *      authoritative migration path.
 *
 * Adding a new migration:
 *   - Edit the SQL in lib/db/migrations/NNNN_name.sql (drizzle-kit generate
 *     scaffolds these; manual edits are fine because M2 uses hand-written SQL
 *     for triggers/constraints).
 *   - Add the entry to lib/db/migrations/meta/_journal.json.
 *   - Run `npm run db:migrate` (which uses scripts/migrate.ts).
 *
 * From an EMPTY database the schema must reproduce via:
 *   migrations 0000_init.sql → 0001_integrity.sql → any future NNNN_*.sql.
 */
import 'server-only';

import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { serverEnv } from '@/lib/security/env';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'lib/db/migrations');

/**
 * Run pending migrations. Returns the number of migrations applied in this
 * invocation. Safe to call multiple times; drizzle tracks applied migrations
 * in `drizzle.__drizzle_migrations` and will not re-apply them.
 */
export async function runMigrations(options?: {
  /** Override the migrations folder (used by tests pointing to a tmp dir). */
  migrationsFolder?: string;
  /** Override database URL (used by tests). */
  databaseUrl?: string;
}): Promise<{ appliedCount: number }> {
  const url = options?.databaseUrl ?? serverEnv.db.url;
  if (!url) {
    throw new Error(
      'Cannot run migrations without DATABASE_URL. Set it in .env.local or set DATABASE_MIGRATION_URL.',
    );
  }

  // Use a dedicated single-connection pool for migrations so we don't starve
  // the application pool (max: 1).
  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql);
    const before = await sql<{ count: string }[]>`SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations`.catch(
      () => [{ count: '0' }],
    );
    const beforeCount = Number(before[0]?.count ?? 0);
    await drizzleMigrate(db, {
      migrationsFolder: options?.migrationsFolder ?? MIGRATIONS_FOLDER,
    });
    const after = await sql<{ count: string }[]>`SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations`;
    const afterCount = Number(after[0]?.count ?? 0);
    return { appliedCount: afterCount - beforeCount };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Invoked by `npm run db:migrate`. Runs migrations and exits.
 */
export async function migrateAndExit(code = 0): Promise<never> {
  try {
    const result = await runMigrations();
    // eslint-disable-next-line no-console
    console.info(`[db] migrations applied: ${result.appliedCount} new`);
    process.exit(code);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] migration failed:', err);
    process.exit(1);
  }
}
