/**
 * Standalone migration runner.
 *
 * Runs as the OWNER role via DATABASE_MIGRATION_URL.
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { applyAllMigrations } from './apply-migrations';

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* ok */ }
}

const url: string = (process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL) as string;
if (!url) { console.error('Set DATABASE_MIGRATION_URL.'); process.exit(1); }
process.env.SCOLAIRA_BOOTSTRAP = '1';

async function run() {
  const sql = postgres(url, {
    max: 1,
    onconnect: async (client: any) => {
      await client.simple(`SET search_path = pg_catalog, public;`);
    },
  } as any);
  try {
    const result = await applyAllMigrations(sql, resolve(process.cwd(), 'lib/db/migrations'));
    await sql`GRANT USAGE ON SCHEMA public TO scolaira_app`;
    await sql`GRANT CREATE ON SCHEMA public TO scolaira_app`;
    await sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO scolaira_app`;
    await sql`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app`;
    // Re-apply append-only / column-level restrictions after the broad
    // bootstrap grant. The runtime role must not regain mutation privileges
    // merely because a migration was applied.
    await sql`REVOKE UPDATE, DELETE ON audit_events, reversals FROM scolaira_app`;
    await sql`REVOKE ALL PRIVILEGES ON waivers FROM scolaira_app`;
    await sql`GRANT SELECT, INSERT ON waivers TO scolaira_app`;
    await sql`REVOKE DELETE ON invoices, invoice_lines, payments, payment_allocations, receipts, class_enrollments FROM scolaira_app`;
    // NOTE: EXECUTE on functions is NOT granted wholesale. Each SECURITY
    // DEFINER helper GRANTs EXECUTE explicitly inside its own migration
    // (see 0010_lockdown_secdef.sql §7 for the whitelist). Granting EXECUTE
    // ON ALL FUNCTIONS would re-expose restricted helpers like
    // set_tenant_context_for_system to the runtime role.
    //
    // Restore the conservative default-privilege baseline so future
    // function replacements don't auto-grant EXECUTE.
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, scolaira_app`;
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO scolaira_app, scolaira`;
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO scolaira_app, scolaira`;
    console.info(`[db] migrations applied. new=${result.applied} total=${result.total}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
run().catch((e) => { console.error('[db] migration failed:', e); process.exit(1); });
