/**
 * M4 regression: the runtime principal `scolaira_app` MUST NOT be able to
 * elevate into unrestricted platform context, either directly (via a raw
 * SECURITY DEFINER call) or by manipulating GUCs.
 *
 * These tests connect directly as `scolaira_app` using a raw postgres
 * client (bypassing the application's onconnect hook) so we are testing
 * the database's own authority boundary, not application code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// H-6: the configured databases, verbatim — never rewritten to a fixed name.
// A suite that reads one database and seeds another proves nothing about either.
const APP_URL =
  process.env.DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';
const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';

// Two seeded tenants, inserted as owner with system context.
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const PLATFORM_USER = '99999999-9999-9999-9999-999999999999';

describe('M4 DB-level tenant isolation (scolaira_app cannot escape)', () => {
  let owner: postgres.Sql;
  let app: postgres.Sql;

  beforeAll(async () => {
    owner = (postgres as any)(OWNER_URL, {
      max: 1,
      onconnect: async (c: any) => {
        await c.simple(`SET search_path=pg_catalog,public`);
      },
    });
    app = (postgres as any)(APP_URL, {
      max: 1,
      onconnect: async (c: any) => {
        // Reset role/GUCs exactly like production onconnect — no SUPERUSER,
        // no bootstrap flag, no platform flag.
        await c.simple(`SET search_path=pg_catalog,public;`);
      },
    });

    // Seed two tenants as owner via bootstrap + platform flag (the only
    // legitimate way to insert cross-tenant metadata; set_tenant_context_for_system(NULL,NULL)
    // sets is_platform_admin but leaves platform_admin_id empty, which fails
    // the platform-authorization validator now).
    await owner`SELECT auth_enter_system_context()`;
    await owner`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;
    await owner`
      INSERT INTO organizations (id, name, slug) VALUES
        (${ORG_A}::uuid, 'School A', 'school-a-rl'),
        (${ORG_B}::uuid, 'School B', 'school-b-rl')
      ON CONFLICT (id) DO NOTHING`;
    await owner`
      INSERT INTO users (id, email, first_name, last_name, is_platform_admin) VALUES
        (${USER_A}::uuid, 'a-rl@a.com','Alice','A', false),
        (${USER_B}::uuid, 'b-rl@b.com','Bob','B', false),
        (${PLATFORM_USER}::uuid, 'plat-rl@x.com','Plat','A', true)
      ON CONFLICT (id) DO NOTHING`;
    await owner`
      INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at) VALUES
        (${ORG_A}::uuid, ${USER_A}::uuid, 'OWNER'::membership_role, 'ACTIVE', now(), now(), now()),
        (${ORG_B}::uuid, ${USER_B}::uuid, 'OWNER'::membership_role, 'ACTIVE', now(), now(), now())
      ON CONFLICT DO NOTHING`;
    await owner`SELECT clear_app_context()`;
  });

  afterAll(async () => {
    await app.end({ timeout: 5 });
    await owner.end({ timeout: 5 });
  });

  it('scolaira_app has NOSUPERUSER, NOBYPASSRLS, NOINHERIT, NOCREATEROLE, NOCREATEDB', async () => {
    const r = await app<{ rs: string; rb: string; ri: string; rcr: string; rcd: string }[]>`
      SELECT rolsuper::text rs, rolbypassrls::text rb, rolinherit::text ri,
             rolcreaterole::text rcr, rolcreatedb::text rcd
        FROM pg_roles WHERE rolname=current_user`;
    expect(r[0]!.rs).toBe('false');
    expect(r[0]!.rb).toBe('false');
    expect(r[0]!.ri).toBe('false');
    expect(r[0]!.rcr).toBe('false');
    expect(r[0]!.rcd).toBe('false');
    expect(await app`SELECT current_user`.then((r) => r[0]!.current_user)).toBe('scolaira_app');
  });

  it('cold connection returns 0 rows from all tenant tables (default-deny)', async () => {
    const orgs = await app<{ n: string }[]>`SELECT count(*)::text n FROM organizations`;
    const mems = await app<{ n: string }[]>`SELECT count(*)::text n FROM organization_members`;
    const usrs = await app<{ n: string }[]>`SELECT count(*)::text n FROM users`;
    expect(orgs[0]!.n).toBe('0');
    expect(mems[0]!.n).toBe('0');
    expect(usrs[0]!.n).toBe('0');
  });

  it('direct call to set_tenant_context_for_system(NULL,NULL) is denied to scolaira_app', async () => {
    let code: string | undefined;
    try {
      await app`SELECT set_tenant_context_for_system(NULL,NULL)`;
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBeDefined();
    // 42501 = permission denied; insufficient_privilege = our own guard.
    expect(['42501', 'insufficient_privilege']).toContain(code);
  });

  it('set_config can be called, but even with is_platform_admin=1 set directly (without a valid platform user_id), RLS denies access to cross-tenant data', async () => {
    // An attacker who obtains SQL injection may set is_platform_admin='1'
    // via set_config, but our tightened policies additionally require a
    // real platform user id.
    await app`
      SELECT set_config('app.is_platform_admin','1',false),
             set_config('app.organization_id','',false),
             set_config('app.user_id','',false)`;
    try {
      const orgs = await app<{ n: string }[]>`SELECT count(*)::text n FROM organizations`;
      // Empty user_id: platform EXISTS clause fails, so count must be 0.
      expect(orgs[0]!.n).toBe('0');
    } finally {
      await app`SELECT clear_app_context()`.catch(() => {});
    }
  });

  it('forging user_id to a non-platform-admin user does NOT unlock platform access', async () => {
    await app`
      SELECT set_config('app.is_platform_admin','1',false),
             set_config('app.user_id',${USER_A},false),
             set_config('app.organization_id','',false)`;
    try {
      const orgs = await app<{ n: string }[]>`SELECT count(*)::text n FROM organizations`;
      expect(orgs[0]!.n).toBe('0');
      const mems = await app<{ n: string }[]>`SELECT count(*)::text n FROM organization_members`;
      expect(mems[0]!.n).toBe('0');
    } finally {
      await app`SELECT clear_app_context()`.catch(() => {});
    }
  });

  it('valid tenant context scoped to A returns ONLY A rows', async () => {
    await app`SELECT set_tenant_context(${ORG_A}::uuid, ${USER_A}::uuid)`;
    try {
      const orgs = await app<{ id: string }[]>`SELECT id::text FROM organizations`;
      const mems = await app<
        { org: string }[]
      >`SELECT organization_id::text org FROM organization_members`;
      expect(orgs.map((r) => r.id)).toEqual([ORG_A]);
      for (const m of mems) expect(m.org).toBe(ORG_A);
      // No writes to B allowed.
      let writeDenied: string | undefined;
      try {
        await app.unsafe(
          `INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at)
           VALUES ($1, $2, 'STAFF'::membership_role, 'ACTIVE', now(), now(), now())`,
          [ORG_B, USER_A],
        );
      } catch (e: any) {
        writeDenied = e?.code;
      }
      // Acceptable deny signals:
      //   42501 = RLS WITH CHECK rejected the forged org,
      //   23503 = foreign-key violation (if FK is checked before policy),
      //   23505 = unique violation (trigger overwrote organization_id to
      //           caller's tenant and the membership already exists there).
      // All three mean the write did NOT land in School B.
      expect(['42501', '23503', '23505']).toContain(writeDenied);
    } finally {
      await app`SELECT clear_app_context()`.catch(() => {});
    }
  });

  it('auth_enter_system_context() grants access ONLY to auth tables (sessions/users/password credentials/password resets/organizations/organization_members), NOT to financial/student tables', async () => {
    await app`SELECT auth_enter_system_context()`;
    try {
      // Auth tables should be accessible via bootstrap branch.
      await app`SELECT count(*) FROM users`;
      await app`SELECT count(*) FROM organizations`;
      await app`SELECT count(*) FROM organization_members`;
      // Financial / student / tenant-content tables must remain default-denied.
      const tables = [
        'invoices',
        'invoice_lines',
        'payments',
        'payment_allocations',
        'receipts',
        'reversals',
        'payment_links',
        'students',
        'fee_definitions',
        'classes',
      ];
      for (const t of tables) {
        const r = (await app.unsafe(`SELECT count(*)::text n FROM ${t}`)) as Array<{ n: string }>;
        expect(r[0]!.n, `table ${t} must default-deny in bootstrap mode`).toBe('0');
      }
    } finally {
      await app`SELECT clear_app_context()`.catch(() => {});
    }
  });

  it('enter_platform_context() with a non-platform user is rejected', async () => {
    let code: string | undefined;
    try {
      await app`SELECT enter_platform_context(${USER_A}::uuid)`;
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBeDefined();
    expect(['42501', 'insufficient_privilege']).toContain(code);
    // After rejection, GUCs must be cleared.
    const r = await app<{ pa: string }[]>`SELECT current_setting('app.is_platform_admin',true) pa`;
    expect(['0', '', null]).toContain(r[0]!.pa as any);
  });

  it('set_tenant_context to a foreign tenant (user not a member) is rejected', async () => {
    let code: string | undefined;
    try {
      await app`SELECT set_tenant_context(${ORG_B}::uuid, ${USER_A}::uuid)`;
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBeDefined();
    expect(['42501', 'insufficient_privilege']).toContain(code);
  });
});
