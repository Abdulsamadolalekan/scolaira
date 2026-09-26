/**
 * Deterministic migration runner: applies SQL files in order by numeric
 * prefix, splitting on `--> statement-breakpoint`. Tracks applied migrations
 * in drizzle.__drizzle_migrations by filename tag.
 *
 * We use this instead of drizzle's migrate() because the migration meta
 * folder (snapshots) is not committed and the journal alone is insufficient
 * for drizzle's migrator when the meta dir has been pruned. This runner is
 * simple, auditable, and dependency-free.
 */
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

export async function applyAllMigrations(sql: postgres.Sql, folder: string) {
  const files = readdirSync(folder)
    .filter(f => f.endsWith('.sql'))
    .sort();
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    tag TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  const applied = new Set((await sql<{tag:string}[]>`SELECT tag FROM drizzle.__drizzle_migrations`).map(r => r.tag));
  for (const f of files) {
    const tag = f.replace(/\.sql$/, '');
    if (applied.has(tag)) continue;
    const sql_text = readFileSync(resolve(folder, f), 'utf8');
    const statements = sql_text.split(/--> statement-breakpoint/).map(s => s.trim()).filter(Boolean);
    console.log(`[db] applying ${f} (${statements.length} statements)`);
    await sql.begin(async tx => {
      for (const stmt of statements) {
        if (!stmt) continue;
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO drizzle.__drizzle_migrations (tag) VALUES (${tag})`;
    });
  }
  const after = await sql<{n:string}[]>`SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`;
  return { applied: files.length - applied.size, total: Number(after[0]!.n) };
}
