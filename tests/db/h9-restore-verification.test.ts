// @vitest-environment node
/**
 * H-9 · H9-3 — the restore-verification tool must fail on a damaged database.
 *
 * A tool that reports PASS on a damaged database is worse than no tool, so this
 * suite attacks the tool rather than the schema:
 *
 *   1. it passes on a healthy, production-shaped database;
 *   2. it submits only read-only SQL — no INSERT/UPDATE/DELETE/TRUNCATE can be
 *      issued through the operator path, so verification cannot change
 *      financial truth;
 *   3. it names the violated invariant for each class of damage, and never
 *      reports a silent PASS.
 *
 * The damage runs against a DISPOSABLE database created here as a template copy
 * of the migrated, hardened test database (`scolaira_test`). A template copy is
 * used deliberately: it carries the exact posture the global setup produced
 * (migrations 0000–0050 plus the post-migration privilege hardening), so the
 * healthy PASS below is also a drift check — if the test harness ever stopped
 * hardening the database, the first assertion in this file would fail rather
 * than the damage assertions quietly passing against a permissive database.
 *
 * Every damage class is listed in the H-9 report §12. Damage is cumulative
 * (each step is applied on top of the previous ones) and each test asserts only
 * that its own failure appears, so a regression that adds a *new* false PASS is
 * still caught by the assertion following it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  readOnlyRunner,
  verifyRestoredDatabase,
  formatReport,
  type VerificationReport,
} from '@/lib/ops/restore-verification';
import { withScopedDb } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import { applyRichSeed } from '../support/rich-seed';
import type { RichIds } from '../support/rich-seed';

const OWNER_URL =
  process.env.TEST_DATABASE_MIGRATION_URL ??
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';
const APP_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';

const DAMAGE_DB = 'scolaira_h9_restore_damage';

/** Point a connection URL at a different database on the same cluster. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let admin: postgres.Sql;
let owner: postgres.Sql;
let app: postgres.Sql;
let seeded: RichIds;
let platformAdminId: string;

/**
 * Run the verification the way the operator CLI does: catalog + data checks on
 * ONE owner-credentialed database, with the data checks inside platform scope.
 * `statements` records every statement the tool submits.
 */
async function verify(statements?: string[]): Promise<VerificationReport> {
  return withScopedDb(
    { kind: 'platform', userId: platformAdminId },
    async (_db, scoped) =>
      verifyRestoredDatabase(
        readOnlyRunner((statement) => {
          statements?.push(statement);
          return scoped.unsafe(statement) as Promise<Array<Record<string, unknown>>>;
        }),
        { scope: `disposable damage database "${DAMAGE_DB}"`, dataReadable: true },
      ),
    { client: owner },
  );
}

/** Apply damage as the owner (the role an operator restoring a dump would have). */
async function damage(statement: string): Promise<void> {
  await owner.unsafe(statement);
}

/** All failure strings across a report, for readable assertions. */
function failures(report: VerificationReport): string[] {
  return report.checks.flatMap((check) => check.failures.flat());
}

function statusOf(report: VerificationReport, id: string): string {
  return report.checks.find((check) => check.id === id)?.status ?? 'MISSING';
}

beforeAll(async () => {
  // Connect to the maintenance database: the template source must be idle.
  admin = postgres(withDatabase(OWNER_URL, 'postgres'), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DAMAGE_DB} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${DAMAGE_DB} TEMPLATE scolaira_test`);

  owner = postgres(withDatabase(OWNER_URL, DAMAGE_DB), { max: 1 });
  app = postgres(withDatabase(APP_URL, DAMAGE_DB), { max: 1 });

  // The shared test database accumulates committed bulk fixtures from other
  // suites (the H-2 pagination suite inserts hundreds of invoices directly, with
  // no line items). Those rows genuinely violate the financial invariant this
  // tool checks — the tool is right to report them — but they make the shared
  // database useless as a *healthy* target. The clone is therefore emptied
  // first: catalog posture inherited, content owned by this file. The
  // `drizzle` schema is left alone so the migration-state check still has
  // something real to read.
  const tables = await owner<{ name: string }[]>`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `;
  expect(tables.length).toBeGreaterThan(0);
  // `app_meta` is exempt: it is the owner-only table that carries the tenant
  // context secret, and emptying it breaks the scoped-context machinery itself
  // ("tenant_ctx_secret not initialized"). It holds no tenant data.
  const tenantTables = tables.filter((t) => t.name !== 'app_meta');
  expect(tenantTables.length).toBeGreaterThan(0);
  await owner.unsafe(
    `TRUNCATE ${tenantTables.map((t) => `public."${t.name}"`).join(', ')} CASCADE`,
  );

  // Real fixtures, written through the repositories and triggers — not raw row
  // stuffing — so the healthy database is consistent for the right reasons.
  const ids = await seedTwoOrgs(app);
  seeded = await withScopedDb(
    { kind: 'seed', organizationId: null, userId: null },
    async (_db, sql) => applyRichSeed(sql as unknown as postgres.Sql, ids),
    { client: app },
  );

  // The tool refuses to read tenant data without a real platform administrator;
  // create one in bootstrap context exactly as the seed fixtures do, so the
  // platform scope below is a genuine authorization and not a bypass.
  platformAdminId = randomUUID();
  await app`SELECT auth_enter_system_context()`;
  await app`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;
  await app`
    INSERT INTO users (id, email, first_name, last_name, is_platform_admin)
    VALUES (${platformAdminId}::uuid, ${`ops-verify+${platformAdminId.slice(0, 8)}@example.com`}, 'Ops', 'Verifier', true)
  `;
  await app`SELECT clear_app_context()`;
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => {});
  await owner?.end({ timeout: 5 }).catch(() => {});
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DAMAGE_DB} WITH (FORCE)`).catch(() => {});
  await admin?.end({ timeout: 5 }).catch(() => {});
});

describe('H9-3 restore verification — healthy database', () => {
  it('reports VERIFIED, with every check PASS and none skipped', async () => {
    const report = await verify();
    expect(report.checks.length).toBeGreaterThan(0);
    // The message names the violations: a healthy-database regression must
    // explain itself rather than just reporting a count.
    const detail = JSON.stringify(
      report.checks.filter((check) => check.status !== 'PASS').map((c) => [c.id, c.failures]),
    );
    expect(report.summary.failed, detail).toBe(0);
    expect(report.summary.skipped).toBe(0);
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain('VERIFIED');
  });

  it('is read-only: every statement it submits reads, and none of them writes', async () => {
    const statements: string[] = [];
    await verify(statements);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      // Reads, plus the transaction-control statements that keep one broken
      // check from poisoning the next.
      expect(statement.trim()).toMatch(
        /^(select|with|savepoint\b|rollback to savepoint\b|release savepoint\b)/i,
      );
      // The leading verb decides: privilege names such as 'UPDATE'/'DELETE'
      // legitimately appear as string literals inside a SELECT.
      const verb = (statement.trim().split(/\s+/)[0] ?? '').toUpperCase();
      expect([
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'COPY',
        'ALTER',
        'DROP',
        'CREATE',
        'GRANT',
        'REVOKE',
      ]).not.toContain(verb);
    }
  });

  it('refuses to run a statement that is not a read', async () => {
    const guarded = readOnlyRunner(() => {
      throw new Error('the guard must never call through for a write');
    });
    for (const forbidden of [
      'DELETE FROM invoices',
      'update invoices set total_kobo = 0',
      'INSERT INTO audit_events (id) VALUES (gen_random_uuid())',
      'TRUNCATE invoices',
      'DROP TABLE invoices',
      'ALTER TABLE invoices DISABLE TRIGGER USER',
    ]) {
      await expect(guarded(forbidden)).rejects.toThrow(/read-only/i);
    }
    // Leading whitespace must not smuggle a write past the guard.
    await expect(guarded('  \n\t DELETE FROM invoices')).rejects.toThrow(/read-only/i);
  });

  it('does not report a pass when a check throws', async () => {
    const report = await verifyRestoredDatabase(
      () => {
        throw new Error('database went away mid-verification');
      },
      { scope: 'throwing runner', dataReadable: true },
    );
    expect(report.ok).toBe(false);
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(failures(report).join('\n')).toMatch(/database went away mid-verification/);
  });
});

describe('H9-3 restore verification — deliberate damage is detected and named', () => {
  it('detects a runtime role that regained DELETE on a financial table', async () => {
    await damage(`GRANT DELETE ON invoices TO scolaira_app`);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'security.runtime_privileges')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(/DELETE on invoices/);
  });

  it('detects a tenant table that stopped forcing row-level security', async () => {
    await damage(`ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY`);
    const report = await verify();
    expect(statusOf(report, 'security.force_rls')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(/audit_events/);
  });

  it('detects a missing table the runtime needs', async () => {
    await damage(`DROP TABLE member_invitations`);
    const report = await verify();
    expect(statusOf(report, 'schema.required_objects')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(/missing table: member_invitations/);
  });

  it('does not let one broken check poison the checks that follow it', async () => {
    // `member_invitations` is dropped above, so the privilege check throws. Every
    // later check must still evaluate against real data rather than reporting
    // "current transaction is aborted" — a misleading failure that hides the
    // true violation.
    const report = await verify();
    expect(failures(report).join('\n')).not.toMatch(/transaction is aborted/);
    expect(statusOf(report, 'security.runtime_privileges')).toBe('FAIL');
  });

  it('detects a database that is not migrated to what this build expects', async () => {
    await damage(
      `DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
    );
    const report = await verify();
    expect(statusOf(report, 'schema.migration_state')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(/49/);
  });

  it('detects an invoice whose total no longer equals its lines', async () => {
    // The guard trigger refuses direct total writes by design, which is exactly
    // what a restore performed with triggers disabled would lose — so the
    // trigger is disabled here to simulate that restore.
    await damage(`ALTER TABLE invoices DISABLE TRIGGER USER`);
    await withScopedDb(
      { kind: 'tenant', organizationId: seeded.orgId, userId: seeded.aliceId },
      async (_db, scoped) => {
        const rows = (await scoped.unsafe(
          `UPDATE invoices SET total_kobo = total_kobo + 1 WHERE id = '${seeded.invPaidId}' RETURNING id`,
        )) as unknown as Array<Record<string, unknown>>;
        // Guards against the classic silent no-op: FORCEd RLS means an unscoped
        // write changes nothing and the damage test would pass vacuously.
        expect(rows.length).toBe(1);
      },
      { client: owner },
    );
    const report = await verify();
    expect(statusOf(report, 'financial.invoice_totals')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(/total \d+ <> lines \d+/);
  });

  it('detects a ledger row pointing at a parent that is not there', async () => {
    const constraints = await owner<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'payment_allocations'::regclass
         AND confrelid = 'payments'::regclass
    `;
    expect(constraints.length).toBeGreaterThan(0);
    for (const { conname } of constraints) {
      await damage(`ALTER TABLE payment_allocations DROP CONSTRAINT ${conname}`);
    }
    await damage(`ALTER TABLE payment_allocations DISABLE TRIGGER USER`);
    await withScopedDb(
      { kind: 'tenant', organizationId: seeded.orgId, userId: seeded.aliceId },
      async (_db, scoped) => {
        const rows = (await scoped.unsafe(
          `INSERT INTO payment_allocations
             (id, organization_id, payment_id, invoice_id, amount_kobo, status, created_at, updated_at)
           VALUES
             (gen_random_uuid(), '${seeded.orgId}', '${randomUUID()}', '${seeded.invPaidId}', 100, 'ACTIVE', now(), now())
           RETURNING id`,
        )) as unknown as Array<Record<string, unknown>>;
        expect(rows.length).toBe(1);
      },
      { client: owner },
    );
    const report = await verify();
    expect(statusOf(report, 'financial.orphaned_rows')).toBe('FAIL');
    expect(failures(report).join('\n')).toMatch(
      /payment_allocations .*: dangling payment or invoice/,
    );
  });

  it('still reports NOT VERIFIED in the printed block, with every violation listed', async () => {
    const report = await verify();
    const printed = formatReport(report);
    expect(printed).toContain('NOT VERIFIED');
    expect(printed).not.toContain('[PASS] security.runtime_privileges');
    for (const failure of failures(report)) {
      expect(printed).toContain(failure);
    }
  });
});
