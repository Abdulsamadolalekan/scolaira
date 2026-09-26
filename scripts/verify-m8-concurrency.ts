/**
 * M8 verification harness: run two real runtime-role bill transactions at
 * once and prove that one ordinary invoice, one billing key, and one BILLED
 * term commit. Invoked by the closeout verification command against a throwaway
 * database created by the shell wrapper.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from './apply-migrations';
import * as schema from '@/lib/db/schema';
import * as billing from '@/lib/db/repo/billing';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

const dbName = process.env.M8_CONCURRENCY_DATABASE;
if (!dbName) throw new Error('M8_CONCURRENCY_DATABASE is required');
const ownerUrl = `postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/${dbName}`;
const runtimeUrl = `postgresql://scolaira_app:scolaira_app_pw@localhost:5432/${dbName}`;

async function main() {
  const owner = postgres(ownerUrl, { max: 1 });
  await owner`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  const migrated = await applyAllMigrations(owner, resolve(process.cwd(), 'lib/db/migrations'));
  await owner`GRANT USAGE, CREATE ON SCHEMA public TO scolaira_app`;
  await owner`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO scolaira_app`;
  await owner`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app`;
  await owner`REVOKE UPDATE, DELETE ON audit_events, reversals FROM scolaira_app`;
  await owner`REVOKE ALL PRIVILEGES ON waivers FROM scolaira_app`;
  await owner`GRANT SELECT, INSERT ON waivers TO scolaira_app`;
  await owner`REVOKE DELETE ON invoices, invoice_lines, payments, payment_allocations, receipts, class_enrollments FROM scolaira_app`;
  await owner`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
  await owner`REVOKE UPDATE ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app`;
  await owner`GRANT UPDATE (kind, state, previous_state, reason, resolution_code, resolution_note, resolved_by, resolved_at, closed_at, version) ON reconciliation_cases TO scolaira_app`;
  await owner`GRANT UPDATE (state, decided_by, decided_at) ON reconciliation_candidates TO scolaira_app`;
  await owner`REVOKE UPDATE, DELETE ON reconciliation_evidence FROM scolaira_app`;
  await owner`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON collections_cases, collections_case_events FROM scolaira_app`;
  await owner`REVOKE UPDATE ON collections_cases, collections_case_events FROM scolaira_app`;
  await owner`GRANT UPDATE (state, priority, assigned_to, next_action_at, resolved_by, resolved_at, closed_by, closed_at, version) ON collections_cases TO scolaira_app`;
  await owner`REVOKE UPDATE, DELETE ON collections_case_events FROM scolaira_app`;
  await owner`REVOKE UPDATE ON payment_allocations FROM scolaira_app`;

  const orgId = randomUUID() as UUID;
  const userId = randomUUID() as UUID;
  const sessionId = randomUUID() as UUID;
  const termId = randomUUID() as UUID;
  const classId = randomUUID() as UUID;
  const studentId = randomUUID() as UUID;
  const feeId = randomUUID() as UUID;
  const assignmentId = randomUUID() as UUID;

  // Bootstrap the identity rows first; FORCE RLS does not allow a tenant
  // context for an organization that has not been inserted yet.
  await owner`SELECT auth_enter_system_context()`;
  await owner`
    INSERT INTO organizations (id, name, slug) VALUES (${orgId}::uuid, 'M8 Concurrency School', ${`m8-concurrency-${orgId.slice(0, 8)}`})
  `;
  await owner`
    INSERT INTO users (id, email, first_name, last_name) VALUES (${userId}::uuid, ${`m8-${orgId.slice(0, 8)}@example.com`}, 'M8', 'Verifier')
  `;
  await owner`
    INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
    VALUES (${orgId}::uuid, ${userId}::uuid, 'FINANCE_OFFICER', 'ACTIVE', now())
  `;
  await owner`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
  await owner`
    INSERT INTO academic_sessions (id, organization_id, name, starts_on, is_current, status)
    VALUES (${sessionId}::uuid, ${orgId}::uuid, 'M8 Session', '2026-01-01', true, 'ACTIVE')
  `;
  await owner`
    INSERT INTO terms (id, organization_id, session_id, name, label, starts_on, is_current, status, billed)
    VALUES (${termId}::uuid, ${orgId}::uuid, ${sessionId}::uuid, 'M8 Term', '1st', '2026-01-01', true, 'ACTIVE', false)
  `;
  await owner`
    INSERT INTO classes (id, organization_id, name) VALUES (${classId}::uuid, ${orgId}::uuid, 'M8 Class')
  `;
  await owner`
    INSERT INTO students (id, organization_id, student_id, first_name, last_name, status)
    VALUES (${studentId}::uuid, ${orgId}::uuid, 'M8-001', 'Ada', 'Concurrency', 'ACTIVE')
  `;
  await owner`
    INSERT INTO class_enrollments (organization_id, student_id, class_id, term_id, enrolled_on)
    VALUES (${orgId}::uuid, ${studentId}::uuid, ${classId}::uuid, ${termId}::uuid, '2026-01-01')
  `;
  await owner`
    INSERT INTO fee_definitions (id, organization_id, code, name, default_amount_kobo, is_active)
    VALUES (${feeId}::uuid, ${orgId}::uuid, 'TUITION', 'Tuition', 100000, true)
  `;
  await owner`
    INSERT INTO fee_assignments (id, organization_id, fee_definition_id, term_id, amount_kobo, adjustment_kobo, status)
    VALUES (${assignmentId}::uuid, ${orgId}::uuid, ${feeId}::uuid, ${termId}::uuid, 100000, 0, 'ACTIVE')
  `;

  const sqlA = postgres(runtimeUrl, { max: 1 });
  const sqlB = postgres(runtimeUrl, { max: 1 });
  await Promise.all([
    sqlA`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`,
    sqlB`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`,
  ]);
  const dbA = drizzle(sqlA, { schema });
  const dbB = drizzle(sqlB, { schema });
  const ctx: TenantCtx = { organizationId: orgId, userId };

  const results = await Promise.allSettled([
    dbA.transaction((tx) => billing.billTerm(tx as any, ctx, termId, [], 'concurrent-a')),
    dbB.transaction((tx) => billing.billTerm(tx as any, ctx, termId, [], 'concurrent-b')),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new Error(`Concurrent bill failure: ${JSON.stringify(failures)}`);

  const check = await owner`
    SELECT
      (SELECT count(*)::int FROM invoices WHERE organization_id = ${orgId}::uuid) AS invoices,
      (SELECT count(*)::int FROM invoice_lines WHERE organization_id = ${orgId}::uuid AND fee_assignment_id = ${assignmentId}::uuid) AS lines,
      (SELECT status::text FROM terms WHERE id = ${termId}::uuid) AS status,
      (SELECT billed FROM terms WHERE id = ${termId}::uuid) AS billed
  `;
  const row = check[0]!;
  if (
    Number(row.invoices) !== 1 ||
    Number(row.lines) !== 1 ||
    row.status !== 'BILLED' ||
    row.billed !== true
  ) {
    throw new Error(`Concurrency invariant failed: ${JSON.stringify(row)}`);
  }
  console.log(
    JSON.stringify({
      migrated,
      concurrentResults: results.map((result) =>
        result.status === 'fulfilled'
          ? { createdInvoices: result.value.createdInvoices, unchanged: result.value.unchanged }
          : result,
      ),
      invariant: row,
    }),
  );

  await sqlA.end();
  await sqlB.end();
  await owner.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
