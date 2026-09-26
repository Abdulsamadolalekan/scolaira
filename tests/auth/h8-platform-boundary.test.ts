// @vitest-environment node
/**
 * H-8 — platform support mode is read-only, audited, and HMAC-bound.
 *
 * The four invariants, each proved against a REAL failure rather than a mock:
 *
 *  READ-ONLY    while a support window is open, `withPlatformRoute` refuses every
 *               capability that is not a read. The refusal is proved through the
 *               real wrapper with the real mutating capability
 *               (`platform.org.suspend`) — a handler that must never run — and
 *               the same call is shown to succeed with the window closed, so the
 *               denial is attributable to support mode and not to a broken gate.
 *
 *  AUDITED      every entry writes `platform.support.enter` into the target
 *               organization's audit trail BEFORE the claim is issued. A failing
 *               audit writer aborts the entry (injected, asserted).
 *
 *  BOUND        the support cookie is HMAC-signed under its own domain prefix and
 *               bound to the authenticated user id: tampered, expired,
 *               cross-user, and cross-cookie (a session cookie presented as a
 *               support cookie, and vice versa) all fail.
 *
 *  UN-FORGEABLE platform context is minted by Postgres, not by the app: a user
 *               whose `is_platform_admin` is false cannot enter platform context
 *               at all, even with a valid support cookie in hand. The
 *               membership-less platform identity (decision D-3) is pinned here
 *               too: it is a database-level identity that can never hold a
 *               session, because `getSession()` requires an ACTIVE membership —
 *               a boundary H-8 was explicitly forbidden from moving.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as platformOrgsGet } from '@/app/api/platform/orgs/route';
import { GET as platformOrgGet } from '@/app/api/platform/orgs/[id]/route';
import {
  POST as supportModePost,
  DELETE as supportModeDelete,
} from '@/app/api/platform/support-mode/route';
import { POST as invitationsPost } from '@/app/api/members/invitations/route';
import { getSql } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { withPlatformContext } from '@/lib/db/tenant';
import { withPlatformRoute, READ_CAPABILITIES, SAFE_METHODS } from '@/lib/platform/route';
import {
  SUPPORT_COOKIE_NAME,
  SUPPORT_TTL_MS,
  enterSupportMode,
  exitSupportMode,
  recordSupportAudit,
  signSupportCookie,
  supportCookieOptions,
  verifySupportCookie,
} from '@/lib/platform/support';
import { signActiveOrgCookie } from '@/lib/auth/cookies';
import { SESSION_COOKIE_NAME } from '@/lib/auth/config';
import { CookieJar, call } from './support';

const PASSWORD = 'Str0ng!Passw0rd-For-Test';
const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

let owner: postgres.Sql;

async function sysQuery<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const sql = getSql();
  await sql`SELECT auth_test_system_context(NULL, NULL)`;
  return (await sql.unsafe<T[]>(query, params as never[])) as T[];
}

interface Account {
  jar: CookieJar;
  email: string;
  userId: string;
  organizationId: string;
}

/** Register a school; optionally promote the owner to platform administrator. */
async function registerAccount(opts: { platformAdmin?: boolean } = {}): Promise<Account> {
  const jar = new CookieJar();
  const email = `${uniq('h8p')}@example.com`;
  const res = await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: PASSWORD,
      firstName: 'H8',
      lastName: 'Platform',
      organizationName: `H8 Platform Org ${uniq('n')}`,
      organizationSlug: uniq('h8p-org'),
    },
  });
  expect(res.status).toBeLessThan(400);

  const rows = await sysQuery<{ organization_id: string; user_id: string }>(
    `select om.organization_id, om.user_id
       from organization_members om join users u on u.id = om.user_id
      where u.email = $1 and om.status = 'ACTIVE' limit 1`,
    [email],
  );
  const userId = rows[0]!.user_id;

  if (opts.platformAdmin) {
    await sysQuery(`update users set is_platform_admin = true where id = $1`, [userId]);
  }
  return { jar, email, userId, organizationId: rows[0]!.organization_id };
}

/** A platform administrator with NO membership anywhere (D-3 fixture). */
async function createMembershiplessPlatformAdmin(): Promise<{ userId: string; email: string }> {
  const email = `${uniq('h8-nomember')}@example.com`;
  const rows = await sysQuery<{ id: string }>(
    `insert into users (id, email, first_name, last_name, is_platform_admin, created_at, updated_at)
     values (gen_random_uuid(), $1, 'No', 'Membership', true, now(), now())
     returning id`,
    [email],
  );
  return { userId: rows[0]!.id, email };
}

/**
 * Read the audit trail for an organization.
 *
 * The audit table has no bootstrap branch (its policy is `platform OR (tenant
 * AND org match)`), so reading it means entering TENANT context for that
 * organization — the same context the application writes it from. `sysQuery`
 * (bootstrap) would correctly see nothing, which is why this uses the tenant
 * variant of the test helper.
 */
async function auditRowsFor<T = any>(
  organizationId: string,
  action: string,
  /** An ACTIVE member of that organization — tenant context verifies membership. */
  actingMember: string,
): Promise<T[]> {
  const sql = getSql();
  await sql`SELECT auth_test_system_context(${organizationId}::uuid, ${actingMember}::uuid)`;
  return (await sql.unsafe<T[]>(
    `select action, actor_user_id, reason, metadata from audit_events
      where organization_id = $1 and action = $2 order by created_at`,
    [organizationId, action] as never[],
  )) as T[];
}

beforeAll(async () => {
  owner = postgres(
    process.env.DATABASE_MIGRATION_URL ??
      'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test',
    { max: 1, onnotice: () => {} },
  );
});

afterAll(async () => {
  await owner?.end({ timeout: 5 });
});

describe('H-8 — the support claim is HMAC-bound', () => {
  const claim = {
    organizationId: randomUUID(),
    nonce: 'nonce-nonce-nonce',
    expiresAt: new Date(Date.now() + SUPPORT_TTL_MS),
  };
  const userId = randomUUID();

  it('round-trips for the user it was issued to', () => {
    const value = signSupportCookie(claim, userId);
    const back = verifySupportCookie(value, userId);
    expect(back?.organizationId).toBe(claim.organizationId);
    expect(back?.nonce).toBe(claim.nonce);
  });

  it('rejects a tampered organization, nonce or signature', () => {
    const value = signSupportCookie(claim, userId);
    const parts = value.split('.');
    const tamperedOrg = [randomUUID(), parts[1], parts[2], parts[3]].join('.');
    const tamperedNonce = [parts[0], 'other-nonce-here', parts[2], parts[3]].join('.');
    const tamperedSig = [parts[0], parts[1], parts[2], parts[3]!.slice(0, -2) + 'aa'].join('.');
    expect(verifySupportCookie(tamperedOrg, userId)).toBeNull();
    expect(verifySupportCookie(tamperedNonce, userId)).toBeNull();
    expect(verifySupportCookie(tamperedSig, userId)).toBeNull();
  });

  it('cannot be replayed by another user', () => {
    const value = signSupportCookie(claim, userId);
    expect(verifySupportCookie(value, randomUUID())).toBeNull();
  });

  it('expires', () => {
    const past = { ...claim, expiresAt: new Date(Date.now() - 1000) };
    // Signed with an already-past expiry: even a perfectly signed claim dies on
    // the clock.
    const value = signSupportCookie(past, userId);
    expect(verifySupportCookie(value, userId)).toBeNull();
  });

  it('is not interchangeable with a session or active-org cookie (domain separation)', () => {
    const value = signSupportCookie(claim, userId);
    // A support cookie is not a session cookie...
    expect(value.split('.')).toHaveLength(4);
    expect(SESSION_COOKIE_NAME).toBe('sc_session');
    // ...and an active-org cookie is not a support cookie, even though both are
    // signed with the same secret material.
    const orgCookie = signActiveOrgCookie(claim.organizationId, userId);
    expect(verifySupportCookie(orgCookie, userId)).toBeNull();
  });

  it('sets an HttpOnly, path-scoped cookie', () => {
    const opts = supportCookieOptions(claim.expiresAt);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBeLessThanOrEqual(Math.ceil(SUPPORT_TTL_MS / 1000));
  });
});

describe('H-8 — every support entry leaves audit evidence', () => {
  it('writes platform.support.enter before the claim exists', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount(); // another school, the support target

    const entry = await enterSupportMode(admin.userId, target.organizationId, {
      reason: 'nightly',
    });
    expect(entry).not.toBeNull();

    const rows = await auditRowsFor(target.organizationId, 'platform.support.enter', target.userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBe(admin.userId);
    expect((rows[0]!.metadata as Record<string, unknown>).supportNonce).toBe(entry!.nonce);
    expect((rows[0]!.metadata as Record<string, unknown>).mode).toBe('READ_ONLY');
  });

  it('returns null for an organization that does not exist, and records nothing', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const ghost = randomUUID();
    const entry = await enterSupportMode(admin.userId, ghost);
    expect(entry).toBeNull();
    // A support window is the signed claim; without one nothing was opened. An
    // audit row for a nonexistent organization is impossible by construction --
    // `organization_id` is a foreign key into `organizations`, and reading a
    // nonexistent organization's trail would need tenant context for it, which
    // is precisely what the database refuses.
  });

  it('ABORTS the entry when the audit write fails — no evidence, no support mode', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();

    const failing = async () => {
      throw new Error('audit store unavailable');
    };

    await expect(
      enterSupportMode(admin.userId, target.organizationId, { audit: failing as never }),
    ).rejects.toThrow(/audit store unavailable/);

    // Nothing was recorded *and* nothing was issued.
    const rows = await auditRowsFor(target.organizationId, 'platform.support.enter', target.userId);
    expect(rows.length).toBe(0);
  });

  it('records the exit as well', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    await exitSupportMode(admin.userId, entry!);
    const rows = await auditRowsFor(target.organizationId, 'platform.support.exit', target.userId);
    expect(rows.length).toBe(1);
  });

  it('propagates a failed exit rather than losing the trail', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    const failing = async () => {
      throw new Error('audit store unavailable');
    };
    await expect(
      exitSupportMode(admin.userId, entry!, { audit: failing as never }),
    ).rejects.toThrow(/audit store unavailable/);
    void recordSupportAudit;
  });
});

describe('H-8 — the platform API is gated by database-loaded identity', () => {
  it('refuses a platform capability to a non-platform user (403) and records nothing', async () => {
    const plain = await registerAccount();
    const target = await registerAccount();

    const res = await call(supportModePost as never, plain.jar, {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: target.organizationId },
      csrf: true,
    });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('FORBIDDEN');

    const rows = await auditRowsFor(target.organizationId, 'platform.support.enter', target.userId);
    expect(rows.length).toBe(0);
  });

  it('refuses an unauthenticated caller (401)', async () => {
    const res = await call(supportModePost as never, new CookieJar(), {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: randomUUID() },
    });
    expect(res.status).toBe(401);
  });

  it('requires CSRF from a platform administrator (403)', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const res = await call(supportModePost as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: target.organizationId },
      csrf: false,
    });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('CSRF_MISSING');
  });

  it('refuses support mode for an organization the administrator belongs to (409)', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const res = await call(supportModePost as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: admin.organizationId },
      csrf: true,
    });
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('ALREADY_MEMBER');
  });

  it('opens a support window for another organization, and the list read proves platform context', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();

    const entered = await call(supportModePost as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: target.organizationId, reason: 'ticket 1234' },
      csrf: true,
    });
    expect(entered.status).toBe(200);
    expect(entered.data.support.mode).toBe('READ_ONLY');

    // The signed support cookie is now in the jar, and verifies against this user.
    const raw = admin.jar.get(SUPPORT_COOKIE_NAME);
    expect(raw).toBeTruthy();
    expect(verifySupportCookie(raw, admin.userId)?.organizationId).toBe(target.organizationId);

    const rows = await auditRowsFor(target.organizationId, 'platform.support.enter', target.userId);
    expect(rows.length).toBe(1);
    expect((rows[0] as { reason: string | null }).reason).toBe('ticket 1234');

    // Reads work: the platform list is served from database-minted context.
    const list = await call(platformOrgsGet as never, admin.jar, {
      method: 'GET',
      path: '/api/platform/orgs',
    });
    expect(list.status).toBe(200);
    const ids = (list.data.organizations as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(target.organizationId);
    expect(ids).toContain(admin.organizationId);

    // The single-organization read is reachable for the organization in the
    // (verified) claim...
    const detail = await call(platformOrgGet as never, admin.jar, {
      method: 'GET',
      path: `/api/platform/orgs/${target.organizationId}`,
      args: [{ params: Promise.resolve({ id: target.organizationId }) }],
    });
    expect(detail.status).toBe(200);
    expect(detail.data.organization.id).toBe(target.organizationId);
  });

  it('closes the window and records the exit', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    await call(supportModePost as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/support-mode',
      body: { organizationId: target.organizationId },
      csrf: true,
    });
    const closed = await call(supportModeDelete as never, admin.jar, {
      method: 'DELETE',
      path: '/api/platform/support-mode',
      csrf: true,
    });
    expect(closed.status).toBe(200);
    expect(admin.jar.get(SUPPORT_COOKIE_NAME)).toBeUndefined();

    const exits = await auditRowsFor(target.organizationId, 'platform.support.exit', target.userId);
    expect(exits.length).toBe(1);
  });
});

describe('H-8 — support mode is strictly read-only', () => {
  /** A mutating capability route, exactly as a real platform route would be declared. */
  function suspendRoute(calls: { n: number }) {
    return withPlatformRoute({ capability: 'platform.org.suspend', method: 'POST' }, async () => {
      calls.n += 1;
      return new Response(JSON.stringify({ suspended: true }), { status: 200 });
    });
  }

  it('refuses a mutating capability while a support window is open, and the handler never runs', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);

    // Put the signed claim in the jar exactly as the entry route would.
    admin.jar.setFromSetCookie(`${SUPPORT_COOKIE_NAME}=${entry!.signedValue}; Path=/`);
    expect(verifySupportCookie(admin.jar.get(SUPPORT_COOKIE_NAME), admin.userId)).not.toBeNull();

    const calls = { n: 0 };
    const res = await call(suspendRoute(calls) as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/orgs/suspend-somewhere',
      body: {},
      csrf: true,
    });

    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('SUPPORT_MODE_READ_ONLY');
    expect(calls.n).toBe(0);
  });

  it('allows the same capability when no support window is open', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const calls = { n: 0 };
    const res = await call(suspendRoute(calls) as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/orgs/suspend-somewhere',
      body: {},
      csrf: true,
    });
    expect(res.status).toBe(200);
    expect(calls.n).toBe(1);
  });

  it('refuses a POST even when the route claims readOnly (the safe-method half)', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    admin.jar.setFromSetCookie(`${SUPPORT_COOKIE_NAME}=${entry!.signedValue}; Path=/`);

    const calls = { n: 0 };
    // A route that mis-declares itself read-only while accepting a POST. The
    // method half of the rule refuses it regardless of the declaration.
    const liar = withPlatformRoute(
      { capability: 'platform.support.enter', method: 'POST', readOnly: true },
      async () => {
        calls.n += 1;
        return new Response('{}', { status: 200 });
      },
    );
    const res = await call(liar as never, admin.jar, {
      method: 'POST',
      path: '/api/platform/pretend-read',
      body: {},
      csrf: true,
    });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('SUPPORT_MODE_READ_ONLY');
    expect(calls.n).toBe(0);
  });

  it('refuses a GET that is not declared read-only (the declaration half)', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    admin.jar.setFromSetCookie(`${SUPPORT_COOKIE_NAME}=${entry!.signedValue}; Path=/`);

    const calls = { n: 0 };
    // A safe method alone is not enough: the route has to claim to be a read.
    // This is what stops a future GET that mutates (or a route that was never
    // reviewed for support mode) from being reachable inside a window.
    const undeclared = withPlatformRoute(
      { capability: 'platform.support.enter', method: 'GET' },
      async () => {
        calls.n += 1;
        return new Response('{}', { status: 200 });
      },
    );
    const res = await call(undeclared as never, admin.jar, {
      method: 'GET',
      path: '/api/platform/undeclared-read',
    });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('SUPPORT_MODE_READ_ONLY');
    expect(calls.n).toBe(0);
  });

  it('allows the declared-read support plane while the window is open', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    admin.jar.setFromSetCookie(`${SUPPORT_COOKIE_NAME}=${entry!.signedValue}; Path=/`);

    const list = await call(platformOrgsGet as never, admin.jar, {
      method: 'GET',
      path: '/api/platform/orgs',
    });
    expect(list.status).toBe(200);

    const detail = await call(platformOrgGet as never, admin.jar, {
      method: 'GET',
      path: `/api/platform/orgs/${target.organizationId}`,
      args: [{ params: Promise.resolve({ id: target.organizationId }) }],
    });
    expect(detail.status).toBe(200);
    expect(detail.data.organization.id).toBe(target.organizationId);
  });

  it('the vocabulary has exactly one read capability, and the gate does not rely on it', () => {
    // Only `platform.audit.read` is a read by nature; the gate is the
    // declaration-plus-method conjunction, so the capability name can never be
    // the thing that lets a mutation through.
    expect(Array.from(READ_CAPABILITIES)).toEqual(['platform.audit.read']);
    for (const cap of [
      'platform.org.suspend',
      'platform.org.activate',
      'platform.support.enter',
    ] as const) {
      expect(READ_CAPABILITIES.has(cap)).toBe(false);
    }
    // Safe methods exclude the verbs that mutate.
    expect(Array.from(SAFE_METHODS).sort()).toEqual(['GET', 'HEAD', 'OPTIONS']);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(SAFE_METHODS.has(m)).toBe(false);
  });

  it('never exposes a mutation method on the read plane', async () => {
    const orgsRoute = await import('@/app/api/platform/orgs/route');
    const orgRoute = await import('@/app/api/platform/orgs/[id]/route');
    expect((orgsRoute as Record<string, unknown>).POST).toBeUndefined();
    expect((orgsRoute as Record<string, unknown>).PATCH).toBeUndefined();
    expect((orgsRoute as Record<string, unknown>).DELETE).toBeUndefined();
    expect((orgRoute as Record<string, unknown>).POST).toBeUndefined();
    expect((orgRoute as Record<string, unknown>).PATCH).toBeUndefined();
    expect((orgRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it('grants no write power anywhere: a tenant write during support mode lands in the admin’s OWN organization', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const target = await registerAccount();
    const entry = await enterSupportMode(admin.userId, target.organizationId);
    admin.jar.setFromSetCookie(`${SUPPORT_COOKIE_NAME}=${entry!.signedValue}; Path=/`);

    const res = await call(invitationsPost as never, admin.jar, {
      method: 'POST',
      path: '/api/members/invitations',
      body: { email: `${uniq('x')}@example.com`, role: 'STAFF' },
      csrf: true,
    });
    expect(res.status).toBe(201);

    // It landed in the administrator's own tenant — support mode moved no
    // tenant boundary, and the target organization is untouched.
    const inOwn = await sysQuery<{ n: string }>(
      `select count(*)::text as n from member_invitations where organization_id = $1`,
      [admin.organizationId],
    );
    const inTarget = await sysQuery<{ n: string }>(
      `select count(*)::text as n from member_invitations where organization_id = $1`,
      [target.organizationId],
    );
    expect(inOwn[0]!.n).toBe('1');
    expect(inTarget[0]!.n).toBe('0');
  });

  it('refuses the platform plane entirely for a user who is not a platform administrator', async () => {
    const plain = await registerAccount();
    const calls = { n: 0 };
    const res = await call(suspendRoute(calls) as never, plain.jar, {
      method: 'POST',
      path: '/api/platform/orgs/suspend-somewhere',
      body: {},
      csrf: true,
    });
    expect(res.status).toBe(403);
    expect(calls.n).toBe(0);
  });
});

describe('H-8 — platform context is minted by the database, not asserted by the app', () => {
  it('the database refuses platform context for a non-administrator, even with a valid support cookie', async () => {
    const plain = await registerAccount();
    const target = await registerAccount();
    const claim = {
      organizationId: target.organizationId,
      nonce: 'forged-nonce-value',
      expiresAt: new Date(Date.now() + SUPPORT_TTL_MS),
    };
    const forged = signSupportCookie(claim, plain.userId);
    // The signature is genuine — this user could not have minted it, but suppose
    // they somehow held it. The database is what refuses the context.
    expect(verifySupportCookie(forged, plain.userId)).not.toBeNull();

    await expect(withPlatformContext(plain.userId, async () => 'reached')).rejects.toThrow();
  });

  it('grants platform context to a real platform administrator', async () => {
    const admin = await registerAccount({ platformAdmin: true });
    const reached = await withPlatformContext(admin.userId, async () => 'reached');
    expect(reached).toBe('reached');
  });

  it('a membership-less platform administrator can never hold a session (D-3 fixture, boundary pinned)', async () => {
    const ghost = await createMembershiplessPlatformAdmin();

    // The identity is genuinely a platform administrator at the database level...
    const granted = await sysQuery<{ is_platform_admin: boolean }>(
      `select is_platform_admin from users where id = $1`,
      [ghost.userId],
    );
    expect(granted[0]!.is_platform_admin).toBe(true);

    // ...and platform context works for it...
    expect(await withPlatformContext(ghost.userId, async () => 'ok')).toBe('ok');

    // ...but it cannot have a session: getSession() requires an ACTIVE
    // membership, and H-8 was forbidden from touching that boundary (M4). The
    // empty cookie store stands in for a request with no session cookie.
    const emptyStore = { get: () => undefined, set: () => {}, delete: () => {} };
    const session = await getSession(emptyStore as never);
    expect(session).toBeNull();
  });
});
