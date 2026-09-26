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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ok */
  }
}

const url: string = (process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL) as string;
if (!url) {
  console.error('Set DATABASE_MIGRATION_URL.');
  process.exit(1);
}
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
    // R1: grant ONLY the DML the application uses. A blanket
    // `GRANT ALL PRIVILEGES` re-granted TRUNCATE/REFERENCES/TRIGGER — and
    // silently overrode migration-level revokes (including `REVOKE ALL ON
    // app_meta`), because TRUNCATE is not subject to row-level security.
    await sql`GRANT USAGE ON SCHEMA public TO scolaira_app`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scolaira_app`;
    await sql`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app`;
    await sql`REVOKE CREATE ON SCHEMA public FROM scolaira_app`;
    await sql`REVOKE ALL ON app_meta FROM scolaira_app`;
    // R3: the public submission replay cache is written and read only by the
    // SECURITY DEFINER entry point; the runtime role must not regain access
    // to it from the broad bootstrap grant above.
    await sql`REVOKE ALL ON public_submission_keys FROM scolaira_app`;
    // H-5: the operational event log is owner-only data. `ALTER DEFAULT
    // PRIVILEGES` grants DML to the runtime role on every NEW table, so an
    // in-migration REVOKE is not enough — it must be re-applied after the
    // blanket grant, exactly like the replay cache above. Guarded by
    // `to_regclass` because this step also runs when the schema is older than
    // the migration that creates the table (the 46 -> 47 upgrade path).
    await sql`
      DO $$
      BEGIN
        IF to_regclass('public.public_surface_events') IS NOT NULL THEN
          EXECUTE 'REVOKE ALL ON public_surface_events FROM PUBLIC';
          EXECUTE 'REVOKE ALL ON public_surface_events FROM scolaira_app';
        END IF;
      END
      $$`;

    // Re-apply append-only / column-level restrictions after the broad
    // bootstrap grant. The runtime role must not regain mutation privileges
    // merely because a migration was applied.
    await sql`REVOKE UPDATE, DELETE ON audit_events, reversals FROM scolaira_app`;
    await sql`REVOKE ALL PRIVILEGES ON waivers FROM scolaira_app`;
    await sql`GRANT SELECT, INSERT ON waivers TO scolaira_app`;
    await sql`REVOKE DELETE ON invoices, invoice_lines, payments, payment_allocations, receipts, class_enrollments FROM scolaira_app`;
    await sql`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
    await sql`REVOKE UPDATE ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
    await sql`GRANT UPDATE (kind, state, previous_state, reason, resolution_code, resolution_note, resolved_by, resolved_at, closed_at, version) ON reconciliation_cases TO scolaira_app`;
    await sql`GRANT UPDATE (state, decided_by, decided_at) ON reconciliation_candidates TO scolaira_app`;
    await sql`REVOKE UPDATE, DELETE ON reconciliation_evidence FROM scolaira_app`;
    // H-2: a financial period is boundary evidence and a scope setting is an
    // audit trail; neither may be deleted by the runtime role. Re-applied here
    // because the blanket DML grant above would otherwise restore DELETE on
    // every table the migration created. `to_regclass`-guarded so the step is
    // safe on a schema older than 0048.
    await sql`
      DO $$
      BEGIN
        IF to_regclass('public.financial_periods') IS NOT NULL THEN
          EXECUTE 'REVOKE DELETE ON public.financial_periods FROM scolaira_app';
        END IF;
        IF to_regclass('public.surface_scope_settings') IS NOT NULL THEN
          EXECUTE 'REVOKE DELETE ON public.surface_scope_settings FROM scolaira_app';
        END IF;
      END
      $$`;
    // M11 collections cases are mutable only through workflow columns; their
    // history is append-only even after the broad post-migration grant.
    await sql`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON collections_cases, collections_case_events FROM scolaira_app`;
    await sql`REVOKE UPDATE ON collections_cases, collections_case_events FROM scolaira_app`;
    await sql`GRANT UPDATE (state, priority, assigned_to, next_action_at, resolved_by, resolved_at, closed_by, closed_at, version) ON collections_cases TO scolaira_app`;
    await sql`REVOKE UPDATE, DELETE ON collections_case_events FROM scolaira_app`;
    // NOTE: EXECUTE on functions is NOT granted wholesale. Each SECURITY
    // DEFINER helper GRANTs EXECUTE explicitly inside its own migration
    // (see 0010_lockdown_secdef.sql §7 for the whitelist). Granting EXECUTE
    // ON ALL FUNCTIONS would re-expose restricted helpers like
    // set_tenant_context_for_system to the runtime role.
    //
    // Restore the conservative default-privilege baseline so future
    // function replacements don't auto-grant EXECUTE.
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, scolaira_app`;
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO scolaira_app, scolaira`;
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO scolaira_app, scolaira`;
    console.info(`[db] migrations applied. new=${result.applied} total=${result.total}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
run().catch((e) => {
  console.error('[db] migration failed:', e);
  process.exit(1);
});
