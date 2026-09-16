/**
 * Helper for concurrency tests: creates a fresh organization (with one
 * finance officer, session, term, class, student) via AUTOCOMMIT on a new
 * connection so the data is visible to other concurrent connections.
 *
 * Because concurrency tests cannot rely on the per-test BEGIN/ROLLBACK
 * transaction (other connections cannot see uncommitted writes), we create
 * fixtures outside of the main connection.
 *
 * Returns a teardown function that DROPs the organization (CASCADE removes
 * all tenant rows via FKs) to avoid leaking state between tests.
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { UUID } from '@/lib/db/repo/_context';

const URL = process.env.DATABASE_URL ?? 'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';

export interface ConcurrencyFixtures {
  orgId: UUID;
  userId: UUID;
  sessionId: UUID;
  termId: UUID;
  classId: UUID;
  studentId: UUID;
  /**
   * Run `fn(sql)` in tenant context (authenticated as the org's finance
   * officer) on a FRESH, short-lived connection. The connection is closed
   * after fn resolves.
   */
  asTenant: <T>(fn: (sql: postgres.Sql) => Promise<T>) => Promise<T>;
  teardown: () => Promise<void>;
}

export async function setupConcurrencyFixtures(): Promise<ConcurrencyFixtures> {
  const orgId = randomUUID() as UUID;
  const userId = randomUUID() as UUID;
  const sessionId = randomUUID() as UUID;
  const termId = randomUUID() as UUID;
  const classId = randomUUID() as UUID;
  const studentId = randomUUID() as UUID;

  const sql = postgres(URL, { max: 1 });
  try {
    await sql`SELECT set_tenant_context_for_system(NULL, NULL)`;
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}::uuid, 'CC-' || ${orgId}, 'cc-' || ${orgId})`;
    await sql`INSERT INTO users (id, email, first_name, last_name) VALUES (${userId}::uuid, 'cc-' || ${userId} || '@x.y', 'Cc', 'User')`;
    await sql`INSERT INTO organization_members (organization_id, user_id, role, status) VALUES (${orgId}::uuid, ${userId}::uuid, 'FINANCE_OFFICER', 'ACTIVE')`;
    await sql`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
    await sql`INSERT INTO academic_sessions (id, name, starts_on, is_current, status) VALUES (${sessionId}::uuid, 'cc', '2026-01-01'::date, true, 'ACTIVE')`;
    await sql`INSERT INTO terms (id, session_id, name, label, starts_on, due_date, is_current, status) VALUES (${termId}::uuid, ${sessionId}::uuid, 'T', '1', '2026-01-01'::date, '2026-12-01'::date, true, 'ACTIVE')`;
    await sql`INSERT INTO classes (id, name) VALUES (${classId}::uuid, 'C')`;
    await sql`INSERT INTO students (id, student_id, first_name, last_name, status) VALUES (${studentId}::uuid, 'CC-1', 'Cc', 'Student', 'ACTIVE')`;
    await sql`SELECT set_config('app.organization_id', '', false), set_config('app.user_id', '', false), set_config('app.is_platform_admin', '0', false), set_config('app.bypass_financial_triggers', '0', false)`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  return {
    orgId, userId, sessionId, termId, classId, studentId,
    asTenant: async (fn) => {
      const s = postgres(URL, { max: 1 });
      try {
        await s`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
        return await fn(s);
      } finally {
        await s`SELECT set_config('app.organization_id', '', false), set_config('app.user_id', '', false), set_config('app.is_platform_admin', '0', false)`.catch(() => {});
        await s.end({ timeout: 5 });
      }
    },
    teardown: async () => {
      // No-op: global setup DROPs public schema before each vitest run, so
      // any leaked org is wiped between runs. We cannot DELETE organizations
      // directly because trg_guard_financial_delete fires.
    },
  };
}
