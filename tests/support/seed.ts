/**
 * Deterministic seed helpers for DB tests.
 *
 * Uses raw SQL via the postgres client rather than drizzle inserts so we don't
 * have to supply every optional column / fight drizzle date/type coercion.
 * Assumes the caller has already entered system context; we set and clear
 * tenant GUCs inside the seed so each tenant's rows are stamped correctly.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { UUID } from '@/lib/db/repo/_context';

export interface SeededIds {
  orgId: UUID;
  orgBId: UUID;
  aliceId: UUID;
  bobId: UUID;
  sessionId: UUID;
  termId: UUID;
  classId: UUID;
  studentAId: UUID;
  studentBId: UUID;
  /** Org B's parallel academic session/term/class (for tenant-isolation attacks). */
  sessionBId: UUID;
  termBId: UUID;
  classBId: UUID;
}

/**
 * Seed a two-org, two-user, one-student-per-org fixture on the current
 * connection. Both orgs get an independent academic session/term/class so
 * tenant-isolation tests can attack with legitimate IDs from the other org.
 */
export async function seedTwoOrgs(sql: postgres.Sql): Promise<SeededIds> {
  const ids: SeededIds = {
    orgId: randomUUID() as UUID,
    orgBId: randomUUID() as UUID,
    aliceId: randomUUID() as UUID,
    bobId: randomUUID() as UUID,
    sessionId: randomUUID() as UUID,
    termId: randomUUID() as UUID,
    classId: randomUUID() as UUID,
    studentAId: randomUUID() as UUID,
    studentBId: randomUUID() as UUID,
    sessionBId: randomUUID() as UUID,
    termBId: randomUUID() as UUID,
    classBId: randomUUID() as UUID,
  };

  // Bootstrap mode + is_platform_admin flag (with empty platform_admin_id —
  // the SECURITY DEFINER validator auth_is_platform_admin_authorized() will
  // return false for this state, so RLS visibility stays narrow). We set the
  // platform flag only so the trg_set_org_from_context trigger accepts
  // explicit organization_ids during cross-tenant seeding.
  await sql`SELECT auth_enter_system_context()`;
  await sql`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;

  // Slugs and e-mails carry a per-invocation suffix: suites that commit their
  // fixtures (concurrency, R1 isolation) would otherwise collide with the next
  // suite's seed on the unique slug/e-mail indexes. The shape stays the same,
  // only the identifier is unique.
  const tag = ids.orgId.slice(0, 8);
  await sql`
    INSERT INTO organizations (id, name, slug) VALUES
      (${ids.orgId}::uuid, 'Demo School', ${'demo-school-' + tag}),
      (${ids.orgBId}::uuid, 'Rival School', ${'rival-school-' + tag})
      ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO users (id, email, first_name, last_name) VALUES
      (${ids.aliceId}::uuid, ${'alice+' + tag + '@demo.school'}, 'Alice', 'Demo'),
      (${ids.bobId}::uuid, ${'bob+' + tag + '@rival.school'}, 'Bob', 'Rival')
      ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at) VALUES
      (${ids.orgId}::uuid, ${ids.aliceId}::uuid, 'FINANCE_OFFICER', 'ACTIVE', now(), now(), now()),
      (${ids.orgBId}::uuid, ${ids.bobId}::uuid, 'FINANCE_OFFICER', 'ACTIVE', now(), now(), now())
      ON CONFLICT DO NOTHING
  `;
  await sql`SELECT clear_app_context()`;

  // Org A: session, term, class, one student
  await sql`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  await sql`
    INSERT INTO academic_sessions (id, name, starts_on, is_current, status) VALUES
      (${ids.sessionId}::uuid, '2025/2026', '2025-09-01'::date, true, 'ACTIVE')
  `;
  await sql`
    INSERT INTO terms (id, session_id, name, label, starts_on, due_date, is_current, status) VALUES
      (${ids.termId}::uuid, ${ids.sessionId}::uuid, 'Third Term', '3rd', '2026-04-15'::date, '2026-06-01'::date, true, 'ACTIVE')
  `;
  await sql`INSERT INTO classes (id, name) VALUES (${ids.classId}::uuid, 'SS3 West')`;
  await sql`
    INSERT INTO students (id, student_id, first_name, last_name, status) VALUES
      (${ids.studentAId}::uuid, 'STU-A01', 'Adeyemi', 'Bolarinwa', 'ACTIVE')
  `;

  // Org B: parallel structure
  await sql`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
  await sql`
    INSERT INTO academic_sessions (id, name, starts_on, is_current, status) VALUES
      (${ids.sessionBId}::uuid, '2025/2026', '2025-09-01'::date, true, 'ACTIVE')
  `;
  await sql`
    INSERT INTO terms (id, session_id, name, label, starts_on, due_date, is_current, status) VALUES
      (${ids.termBId}::uuid, ${ids.sessionBId}::uuid, 'Third Term', '3rd', '2026-04-15'::date, '2026-06-01'::date, true, 'ACTIVE')
  `;
  await sql`INSERT INTO classes (id, name) VALUES (${ids.classBId}::uuid, 'SS3 East')`;
  await sql`
    INSERT INTO students (id, student_id, first_name, last_name, status) VALUES
      (${ids.studentBId}::uuid, 'STU-B01', 'Fatima', 'Garba', 'ACTIVE')
  `;

  // Clear context before returning so each test can set its own.
  await sql`
    SELECT set_config('app.organization_id', '', false),
           set_config('app.user_id', '', false),
           set_config('app.is_platform_admin', '0', false),
           set_config('app.bypass_financial_triggers', '0', false)
  `;
  return ids;
}
