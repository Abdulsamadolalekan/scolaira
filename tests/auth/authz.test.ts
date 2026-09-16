/**
 * M4 — Authorization / multi-tenancy red-team tests.
 *
 * Tests prove the authorization layer enforces role boundaries, OWNER
 * invariants, tenant isolation, and CSRF. Each it() block runs after
 * beforeAll has set up all four roles in one org plus a foreign org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { organizationMembers } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';

function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}
function uniqueSlug(prefix = 'school'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`.toLowerCase().replace(/_/g, '-');
}
function uniquePassword(): string {
  return 'Pass-' + Math.random().toString(36).slice(2, 10) + '-A1!';
}

type Actor = { jar: InstanceType<typeof CookieJar>; userId: string; orgId: string; memberId: string; role: string; email: string; password: string };

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function registerOwner(opts: { email?: string; slug?: string; firstName?: string } = {}): Promise<Actor> {
  const email = opts.email ?? uniqueEmail('own');
  const password = uniquePassword();
  const slug = opts.slug ?? uniqueSlug('o');
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST', path: '/api/auth/register',
    body: { email, password, firstName: opts.firstName ?? 'Owner', lastName: 'Person', organizationName: 'School of ' + slug, organizationSlug: slug },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const member = (me.data.memberships as any[]).find((m) => m.organizationId === me.data.activeOrganizationId);
  return {
    jar, email, password,
    orgId: me.data.activeOrganizationId,
    userId: me.data.user.id,
    memberId: member.id,
    role: me.data.activeRole,
  };
}

/**
 * Add an actor into the owner's org with the given role. We register the
 * user normally (so password hashing / session plumbing works) which creates
 * their own starter org as OWNER, then add a second membership into the
 * target org via system context, then switch their session over.
 */
async function addMember(owner: Actor, role: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF', label: string): Promise<Actor> {
  const email = uniqueEmail(label);
  const password = uniquePassword();
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST', path: '/api/auth/register',
    body: { email, password, firstName: label, lastName: 'User', organizationName: label + ' solo', organizationSlug: uniqueSlug(label) },
  });
  if (reg.status !== 201) throw new Error(`register ${label} failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const userId = me.data.user.id;

  await withSystemContext(null, null, async (sdb) => {
    await sdb.insert(organizationMembers).values({
      id: uuid(),
      organizationId: owner.orgId,
      userId,
      role,
      status: 'ACTIVE',
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  });

  const sel = await callRoute('POST', '/api/auth/select-organization', jar, { organizationId: owner.orgId });
  if (sel.status !== 200) throw new Error(`select org ${label} failed: ${sel.status} ${JSON.stringify(sel.data)}`);
  const after = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  expect(after.data.activeOrganizationId).toBe(owner.orgId);
  expect(after.data.activeRole).toBe(role);
  const member = (after.data.memberships as any[]).find((m) => m.organizationId === owner.orgId);
  return { jar, email, password, userId, orgId: owner.orgId, memberId: member.id, role };
}

/**
 * Call a route handler by path. Paths like /api/members/:id/suspend are
 * dispatched to the appropriate dynamic module. The jar is updated from
 * Set-Cookie via support.call (which sets up the __setCookieStoreForTest
 * injection).
 */
async function callRoute(method: string, path: string, jar: InstanceType<typeof CookieJar>, body?: unknown) {
  const segs = path.split('/').filter(Boolean);
  let modPath = 'app/' + segs.join('/') + '/route';
  let params: any = undefined;
  // Detect /api/members/:id and /api/members/:id/(suspend|reactivate)
  const memIdx = segs.indexOf('members');
  if (memIdx >= 0) {
    const after = segs.slice(memIdx + 1);
    if (after.length >= 1 && after[0] !== 'route') {
      const id = after[0];
      const sub = after[1];
      if (sub === 'suspend' || sub === 'reactivate') {
        modPath = `app/api/members/[id]/${sub}/route`;
      } else {
        modPath = 'app/api/members/[id]/route';
      }
      params = { id };
    }
  }

  const mod: any = await import(/* @vite-ignore */ `@/${modPath}`);
  // ESM default interop — route handlers may be on mod.default or direct.
  const exports = mod?.default ?? mod;
  const handler: Function = exports[method];
  if (typeof handler !== 'function') {
    throw new Error(`no ${method} handler in ${modPath} (keys=${Object.keys(exports).join(',')})`);
  }

  const init: any = {
    method, path, body,
    csrf: !['GET', 'HEAD', 'OPTIONS'].includes(method),
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
  };
  // Wrap to inject Next dynamic-route params.
  const wrapped = async (req: Request) =>
    params ? handler(req, { params: Promise.resolve(params) }) : handler(req);
  return call(wrapped as any, jar, init);
}

describe('M4 — Authorization red-team', () => {
  let owner: Actor;
  let admin: Actor;
  let finance: Actor;
  let staff: Actor;
  let foreign: Actor;

  beforeAll(async () => {
    // Wipe rate_limits/login_attempts before the batch setup (many
    // registers happen on the same test "IP"). Uses SECURITY DEFINER
    // helper because the app role has no direct DELETE on rate_limits.
    const sql = getSql();
    await sql`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerOwner({ firstName: 'Owner' });
    admin = await addMember(owner, 'SCHOOL_ADMIN', 'adm');
    finance = await addMember(owner, 'FINANCE_OFFICER', 'fin');
    staff = await addMember(owner, 'STAFF', 'stf');
    foreign = await registerOwner({ firstName: 'Foreign' });
  }, 60000);

  afterAll(async () => { await closeDb(); });

  // ---------- anonymous ----------
  it('anonymous GET /api/org/settings is 401', async () => {
    const r = await callRoute('GET', '/api/org/settings', new CookieJar());
    expect(r.status).toBe(401);
  });

  it('anonymous GET /api/members is 401', async () => {
    const r = await callRoute('GET', '/api/members', new CookieJar());
    expect(r.status).toBe(401);
  });

  it('anonymous GET /api/invoices is 401', async () => {
    const r = await callRoute('GET', '/api/invoices', new CookieJar());
    expect(r.status).toBe(401);
  });

  // ---------- org settings ----------
  it('OWNER can read org settings', async () => {
    const r = await callRoute('GET', '/api/org/settings', owner.jar);
    expect(r.status).toBe(200);
  });
  it('SCHOOL_ADMIN can read org settings', async () => {
    const r = await callRoute('GET', '/api/org/settings', admin.jar);
    expect(r.status).toBe(200);
  });
  it('FINANCE_OFFICER can read org settings', async () => {
    const r = await callRoute('GET', '/api/org/settings', finance.jar);
    expect(r.status).toBe(200);
  });
  it('STAFF cannot read org settings', async () => {
    const r = await callRoute('GET', '/api/org/settings', staff.jar);
    expect(r.status).toBe(403);
  });

  it('OWNER can update org settings', async () => {
    const r = await callRoute('PATCH', '/api/org/settings', owner.jar, { name: 'Owner Updated School' });
    expect(r.status).toBe(200);
  });
  it('SCHOOL_ADMIN can update org settings', async () => {
    const r = await callRoute('PATCH', '/api/org/settings', admin.jar, { name: 'Admin Updated School' });
    expect(r.status).toBe(200);
  });
  it('FINANCE_OFFICER cannot update org settings', async () => {
    const r = await callRoute('PATCH', '/api/org/settings', finance.jar, { name: 'nope' });
    expect(r.status).toBe(403);
  });
  it('STAFF cannot update org settings', async () => {
    const r = await callRoute('PATCH', '/api/org/settings', staff.jar, { name: 'nope' });
    expect(r.status).toBe(403);
  });

  // ---------- members ----------
  it('STAFF cannot list members', async () => {
    const r = await callRoute('GET', '/api/members', staff.jar);
    expect(r.status).toBe(403);
  });
  it('FINANCE_OFFICER can list members', async () => {
    const r = await callRoute('GET', '/api/members', finance.jar);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.members)).toBe(true);
  });
  it('SCHOOL_ADMIN can list members', async () => {
    const r = await callRoute('GET', '/api/members', admin.jar);
    expect(r.status).toBe(200);
  });
  it('FINANCE_OFFICER cannot invite members', async () => {
    const email = uniqueEmail('nofin');
    const r = await callRoute('POST', '/api/members', finance.jar, { email, role: 'STAFF' });
    expect(r.status).toBe(403);
  });
  it('SCHOOL_ADMIN can invite members (non-existent user returns 404, not 401/403)', async () => {
    // We haven't built user-exists precondition yet; invite for non-existent
    // user returns 404 (see Members.inviteMember). Important: it must NOT
    // return 401/403 — SCHOOL_ADMIN has permission to invite.
    const r = await callRoute('POST', '/api/members', admin.jar, { email: uniqueEmail('inv'), role: 'STAFF' });
    expect(r.status).toBe(404);
  });

  // ---------- invoices ----------
  it('STAFF cannot list invoices', async () => {
    const r = await callRoute('GET', '/api/invoices', staff.jar);
    expect(r.status).toBe(403);
  });
  it('FINANCE_OFFICER can list invoices', async () => {
    const r = await callRoute('GET', '/api/invoices', finance.jar);
    expect(r.status).toBe(200);
  });
  it('SCHOOL_ADMIN can list invoices', async () => {
    const r = await callRoute('GET', '/api/invoices', admin.jar);
    expect(r.status).toBe(200);
  });

  // ---------- OWNER invariants ----------
  it('SCHOOL_ADMIN cannot transfer ownership', async () => {
    const r = await callRoute('POST', '/api/org/transfer-owner', admin.jar, { targetMemberId: admin.memberId });
    expect(r.status).toBe(403);
  });
  it('SCHOOL_ADMIN cannot suspend OWNER', async () => {
    const r = await callRoute('POST', `/api/members/${owner.memberId}/suspend`, admin.jar);
    
    expect(r.status).toBe(403);
  });
  it('SCHOOL_ADMIN cannot revoke OWNER', async () => {
    const r = await callRoute('DELETE', `/api/members/${owner.memberId}`, admin.jar);
    
    expect(r.status).toBe(403);
  });
  it('cannot transfer ownership to non-member / foreign user', async () => {
    const r = await callRoute('POST', '/api/org/transfer-owner', owner.jar, { targetMemberId: foreign.memberId });
    // Either BAD_REQUEST (uuid exists but isn't in this org) or NOT_FOUND
    // (member id unknown in this org) is acceptable; must NOT be 200.
    expect([400, 403, 404]).toContain(r.status);
  });

  it('OWNER can transfer ownership to admin and back; exactly one owner remains at all times', async () => {
    const fwd = await callRoute('POST', '/api/org/transfer-owner', owner.jar, { targetMemberId: admin.memberId });
    
    expect(fwd.status).toBe(200);
    // After fwd, owner.jar's role changes to SCHOOL_ADMIN; re-read.
    await call(meGet, owner.jar, { method: 'GET', path: '/api/auth/me' });
    await call(meGet, admin.jar, { method: 'GET', path: '/api/auth/me' });
    const sql = getSql();
    // Enter system context so RLS doesn't hide rows from us for the
    // invariant check.
    await sql`SELECT auth_enter_system_context()`;
    const cnt = await sql<{n: string}[]>`SELECT count(*)::text AS n FROM organization_members WHERE organization_id = ${owner.orgId} AND role = 'OWNER' AND status = 'ACTIVE'`;
    await sql`SELECT clear_app_context()`.catch(()=>{});
    expect(cnt[0]!.n).toBe('1');
    // Find the (now SCHOOL_ADMIN) owner's member id from admin's perspective
    // by listing members as admin.
    const list = await callRoute('GET', '/api/members', admin.jar);
    expect(list.status).toBe(200);
    const ownerMember = (list.data.members as any[]).find((m: any) => m.userId === owner.userId);
    expect(ownerMember).toBeTruthy();
    const back = await callRoute('POST', '/api/org/transfer-owner', admin.jar, { targetMemberId: ownerMember.id });
    expect(back.status).toBe(200);
    const ownerMe2 = await call(meGet, owner.jar, { method: 'GET', path: '/api/auth/me' });
    expect(ownerMe2.data.activeRole).toBe('OWNER');
  });

  // ---------- tenant isolation ----------
  it('foreign-org owner sees zero invoices (does not leak our data)', async () => {
    const r = await callRoute('GET', '/api/invoices', foreign.jar);
    expect(r.status).toBe(200);
    expect(r.data.invoices).toHaveLength(0);
  });
  it('select-organization to foreign org is rejected', async () => {
    const r = await callRoute('POST', '/api/auth/select-organization', staff.jar, { organizationId: foreign.orgId });
    expect(r.status).toBe(403);
  });
  it('foreign org member list shows only own members', async () => {
    const r = await callRoute('GET', '/api/members', foreign.jar);
    expect(r.status).toBe(200);
    // Foreign org has only OWNER (no cross-leak).
    const emails = (r.data.members as any[]).map((m) => m.email);
    expect(emails).toContain(foreign.email);
    expect(emails).not.toContain(owner.email);
    expect(emails).not.toContain(admin.email);
  });

  // ---------- registration creates OWNER ----------
  it('register creates the founding user as OWNER', async () => {
    const me = await call(meGet, owner.jar, { method: 'GET', path: '/api/auth/me' });
    expect(me.data.activeRole).toBe('OWNER');
  });

  // ---------- DB invariant (partial unique index) ----------
  it('database enforces at-most-one-ACTIVE-OWNER (partial unique index)', async () => {
    // Direct SQL: with is_platform_admin=0 + organization_id set so the
    // set_org_from_context trigger accepts the INSERT. A second ACTIVE OWNER
    // must be rejected by the partial unique index (SQLSTATE 23505).
    const sql = getSql();
    const newId = uuid();
    let caughtCode: string | undefined;
    try {
      // Use set_tenant_context (not raw GUC set_config) — raw GUC forgery is
      // now rejected by the tenant-token HMAC, returning 42501 before the
      // unique index fires. Valid membership context is required to reach
      // the at-most-one-ACTIVE-OWNER invariant.
      await sql`SELECT set_tenant_context(${owner.orgId}::uuid, ${owner.userId}::uuid)`;
      await sql.unsafe(
        `INSERT INTO organization_members
           (id, organization_id, user_id, role, status, joined_at, invited_at, created_at, updated_at)
         VALUES
           ($1, $2, $3, 'OWNER'::membership_role, 'ACTIVE', NULL, NULL, now(), now())`,
        [newId, owner.orgId, staff.userId],
      );
    } catch (e: any) {
      caughtCode = e.code;
    } finally {
      await sql`SELECT clear_app_context()`.catch(() => {});
    }
    expect(caughtCode).toBe('23505');
  });
});
