/**
 * Vitest global setup for DB tests.
 *
 * Connects as the OWNER role (DATABASE_MIGRATION_URL) to drop schemas,
 * apply migrations, and re-grant runtime privileges. Application code under
 * test connects as the runtime role (DATABASE_URL → scolaira_app).
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { applyAllMigrations } from '../scripts/apply-migrations';
import type { GlobalSetupContext } from 'vitest/node';

export default async function globalSetup(_ctx: GlobalSetupContext) {
  const migrationUrl =
    process.env.TEST_DATABASE_MIGRATION_URL ??
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';
  const runtimeUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';
  process.env.DATABASE_URL = runtimeUrl;
  process.env.DATABASE_MIGRATION_URL = migrationUrl;

  const sql = postgres(migrationUrl, {
    max: 1,
    onconnect: async (client: any) => {
      await client.simple(`SET search_path = pg_catalog, public;`);
    },
  } as any);
  try {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await sql`CREATE SCHEMA public AUTHORIZATION scolaira_owner`;
    await sql`CREATE SCHEMA drizzle AUTHORIZATION scolaira_owner`;
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
    const result = await applyAllMigrations(sql, resolve(process.cwd(), 'lib/db/migrations'));
    // R1: mirror `scripts/migrate.ts` exactly — DML only, no CREATE on the
    // schema, no TRUNCATE/REFERENCES/TRIGGER anywhere. The blanket
    // `GRANT ALL PRIVILEGES ON ALL TABLES` used to run here and re-grant what
    // the migrations had revoked (see migration 0044).
    await sql`GRANT USAGE ON SCHEMA public TO scolaira_app`;
    await sql`REVOKE CREATE ON SCHEMA public FROM scolaira_app`;
    await sql`GRANT USAGE ON SCHEMA drizzle TO scolaira_app`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scolaira_app`;
    await sql`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app`;
    await sql`REVOKE ALL ON app_meta FROM scolaira_app`;
    // Mirror the production migration runner's post-grant hardening. Tests
    // must exercise the same append-only privilege boundary as runtime.
    await sql`REVOKE UPDATE, DELETE ON audit_events, reversals FROM scolaira_app`;
    await sql`REVOKE ALL PRIVILEGES ON waivers FROM scolaira_app`;
    await sql`GRANT SELECT, INSERT ON waivers TO scolaira_app`;
    await sql`REVOKE DELETE ON invoices, invoice_lines, payments, payment_allocations, receipts, class_enrollments FROM scolaira_app`;
    await sql`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
    await sql`REVOKE UPDATE ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
    await sql`GRANT UPDATE (kind, state, previous_state, reason, resolution_code, resolution_note, resolved_by, resolved_at, closed_at, version) ON reconciliation_cases TO scolaira_app`;
    await sql`GRANT UPDATE (state, decided_by, decided_at) ON reconciliation_candidates TO scolaira_app`;
    await sql`REVOKE UPDATE, DELETE ON reconciliation_evidence FROM scolaira_app`;
    await sql`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON collections_cases, collections_case_events FROM scolaira_app`;
    await sql`REVOKE UPDATE ON collections_cases, collections_case_events FROM scolaira_app`;
    await sql`GRANT UPDATE (state, priority, assigned_to, next_action_at, resolved_by, resolved_at, closed_by, closed_at, version) ON collections_cases TO scolaira_app`;
    await sql`REVOKE UPDATE, DELETE ON collections_case_events FROM scolaira_app`;
    // Do NOT grant EXECUTE ON ALL FUNCTIONS. Migrations 0010+ explicitly
    // GRANT EXECUTE per-function on a whitelist; blanket grants re-expose
    // restricted SECURITY DEFINER helpers to the runtime role.
    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, scolaira_app`;
    console.info(`[test-db] migrations applied. new=${result.applied} total=${result.total}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return async () => {};
}
