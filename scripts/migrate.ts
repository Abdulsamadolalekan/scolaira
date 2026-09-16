/**
 * Standalone migration runner (Node + tsx, no Next.js dependency).
 *
 * Usage: npx tsx scripts/migrate.ts
 *
 * Used by CI/CD and production deploys. Shares the same migrations folder and
 * the same drizzle journal table as `lib/db/migrate.ts` — the two runners are
 * entry points to one authoritative migration path.
 * See `lib/db/migrate.ts` for architecture details.
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Minimal .env/.env.local loader (no dotenv dependency)
for (const file of ['.env', '.env.local']) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // file not present — ok
  }
}

// Use DATABASE_MIGRATION_URL if set; otherwise DATABASE_URL.
const url: string = (process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL) as string;
if (!url) {
  console.error('Set DATABASE_URL or DATABASE_MIGRATION_URL before running migrations.');
  process.exit(1);
}

const folder = resolve(process.cwd(), 'lib/db/migrations');

async function run() {
  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql);
    const before = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations`.catch(
      () => [{ c: 0 }],
    );
    const beforeCount = Number(before[0]?.c ?? 0);
    await migrate(db, { migrationsFolder: folder });
    const after = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations`;
    const afterCount = Number(after[0]?.c ?? 0);
    console.info(`[db] migrations applied. new=${afterCount - beforeCount} total=${afterCount}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

run().catch((err) => {
  console.error('[db] migration failed:', err);
  process.exit(1);
});
