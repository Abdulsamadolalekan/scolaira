// DB-level regression tests for tenant isolation (M4 gate).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSql, closeDb } from '@/lib/db';

const SCHOOL_A = '11111111-1111-4111-8111-111111111111' as const;
const SCHOOL_B = '22222222-2222-4222-8222-222222222222' as const;
const ALICE    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as const;
const BOB      = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as const;
const PLAT     = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as const;

function row<T extends {}>(rows: T[]): T {
  if (!rows || rows.length === 0) throw new Error('expected non-empty result');
  return rows[0]!;
}

describe('DB boundary regression (M4)', () => {
  const sql = getSql();

  beforeAll(async () => {
    await sql`RESET ROLE`;
    await sql`SELECT auth_enter_system_context()`;
    await sql`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;
    await sql`INSERT INTO organizations (id, name, slug) VALUES
      (${SCHOOL_A}::uuid, 'School A', 'sa-'||md5(random()::text)),
      (${SCHOOL_B}::uuid, 'School B', 'sb-'||md5(random()::text)) ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO users (id, email, first_name, last_name, is_platform_admin) VALUES
      (${ALICE}::uuid, 'alice-'||md5(random()::text)||'@x.com','Alice','A',false),
      (${BOB}::uuid,   'bob-'||md5(random()::text)||'@x.com','Bob','B',false),
      (${PLAT}::uuid,  'plat-'||md5(random()::text)||'@x.com','Plat','X',true) ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at) VALUES
      (${SCHOOL_A}::uuid, ${ALICE}::uuid, 'OWNER','ACTIVE',now(),now(),now()),
      (${SCHOOL_B}::uuid, ${BOB}::uuid,   'OWNER','ACTIVE',now(),now(),now()) ON CONFLICT DO NOTHING`;
    await sql`SELECT clear_app_context()`;
    await sql`SET ROLE scolaira_app`;
    await sql`SELECT clear_app_context()`;
  });
  afterAll(async () => {
    await sql`SELECT clear_app_context()`.catch(() => {});
    await sql`RESET ROLE`.catch(() => {});
    await closeDb().catch(() => {});
  });

  it('scolaira_app is NOT superuser, NOT BYPASSRLS, NOT CREATEROLE', async () => {
    const r = await sql<{s:boolean;b:boolean;cr:boolean;cd:boolean}[]>`
      SELECT rolsuper AS s, rolbypassrls AS b, rolcreaterole AS cr, rolcreatedb AS cd
      FROM pg_roles WHERE rolname = current_user`;
    expect(row(r).s).toBe(false);
    expect(row(r).b).toBe(false);
    expect(row(r).cr).toBe(false);
    expect(row(r).cd).toBe(false);
  });

  it('scolaira_app has no EXECUTE on set_tenant_context_for_system', async () => {
    const r = await sql<{ok:boolean}[]>`
      SELECT has_function_privilege(current_user, 'set_tenant_context_for_system(uuid,uuid)', 'EXECUTE') AS ok`;
    expect(row(r).ok).toBe(false);
  });

  it('cold connection sees zero tenant rows', async () => {
    await sql`SELECT clear_app_context()`;
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organizations`).n).toBe(0);
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organization_members`).n).toBe(0);
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM users`).n).toBe(0);
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM invoices`).n).toBe(0);
  });

  it('forging app.is_platform_admin=1 via set_config yields no rows', async () => {
    await sql`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organizations`).n).toBe(0);
    await sql`SELECT clear_app_context()`;
  });

  it('forging platform_admin_id to a non-admin UUID yields no rows', async () => {
    await sql`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id',${ALICE},false)`;
    expect(row(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organizations`).n).toBe(0);
    await sql`SELECT clear_app_context()`;
  });

  it('enter_platform_context rejects non-admin users', async () => {
    await expect(sql`SELECT enter_platform_context(${ALICE}::uuid)`).rejects.toThrow();
    await sql`SELECT clear_app_context()`.catch(() => {});
  });

  it('set_tenant_context rejects non-member users', async () => {
    await expect(sql`SELECT set_tenant_context(${SCHOOL_A}::uuid, ${BOB}::uuid)`).rejects.toThrow();
    await sql`SELECT clear_app_context()`.catch(() => {});
  });

  it('valid tenant (Alice @ School A) cannot see School B rows', async () => {
    await sql`SELECT set_tenant_context(${SCHOOL_A}::uuid, ${ALICE}::uuid)`;
    const orgs = await sql<{id:string}[]>`SELECT id::text FROM organizations`;
    const bob  = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM users WHERE id = ${BOB}::uuid`;
    await sql`SELECT clear_app_context()`;
    expect(orgs.map(r => r.id)).toEqual([SCHOOL_A]);
    expect(row(bob).n).toBe(0);
  });

  it('bootstrap mode exposes auth tables but NOT tenant financials', async () => {
    await sql`SELECT auth_enter_system_context()`;
    const users = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM users`;
    const orgs  = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organizations`;
    const inv   = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM invoices`;
    const pay   = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM payments`;
    await sql`SELECT clear_app_context()`;
    expect(row(users).n).toBeGreaterThanOrEqual(3);
    expect(row(orgs).n).toBeGreaterThanOrEqual(2);
    expect(row(inv).n).toBe(0);
    expect(row(pay).n).toBe(0);
  });

  it('enter_platform_context(valid admin) enables platform-wide read', async () => {
    await sql`SELECT enter_platform_context(${PLAT}::uuid)`;
    const orgs = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organizations`;
    const mem  = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM organization_members`;
    const usr  = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM users`;
    await sql`SELECT clear_app_context()`;
    expect(row(orgs).n).toBeGreaterThanOrEqual(2);
    expect(row(mem).n).toBeGreaterThanOrEqual(2);
    expect(row(usr).n).toBeGreaterThanOrEqual(3);
  });
});
