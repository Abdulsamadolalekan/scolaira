/**
 * H-4 — Registration Transactionality & Auth Lifecycle Integrity.
 *
 * Companion to `docs/readiness/H4_SCOPE_MAP.md`. Every finding below was
 * MEASURED before it was fixed, against the frozen H-2 tree; this suite is the
 * permanent regression proof for each fix.
 *
 * Failure injection: the injectors live in `beforeAll` on a COMMITTED owner
 * connection (DDL inside a per-test transaction deadlocks against the harness'
 * open transaction) and are keyed on markers only this file uses
 * (`203.0.113.250` / `H4LEAK-`), so no other suite can be affected.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { POST as resetConfirmPost } from '@/app/api/auth/reset-confirm/route';
import { POST as resetRequestPost } from '@/app/api/auth/reset-request/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as changePasswordPost } from '@/app/api/auth/change-password/route';
import { getSql } from '@/lib/db';
import { __setCookieStoreForTest, getSession, switchOrganization, requestPasswordReset } from '@/lib/auth';
import { verifyActiveOrgCookie } from '@/lib/auth/cookies';
import { ACTIVE_ORG_COOKIE_NAME, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '@/lib/auth/config';
import { CookieJar, call } from './support';

const OWNER_URL = process.env.DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';

const PASSWORD = 'Str0ng!Passw0rd-For-Test';
/** Sessions insert fails for exactly this client address. */
const FAULT_IP = '203.0.113.250';
/** password_resets consumption fails for exactly this user-agent marker. */
const LEAK_UA = 'H4LEAK-probe';

const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

let owner: postgres.Sql;

/** Enter pre-auth system scope and run a read; the GUCs are cleared by handlers. */
async function sysQuery<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const sql = getSql();
  await sql`SELECT auth_test_system_context(NULL, NULL)`;
  const rows = await sql.unsafe<T[]>(query, params as never[]);
  return rows as T[];
}

async function registerViaRoute(
  jar: CookieJar,
  overrides: Record<string, string> = {},
  headers: HeadersInit = {},
) {
  const slug = uniq('h4-school');
  const email = `${uniq('h4')}@example.com`;
  const body = {
    email,
    password: PASSWORD,
    firstName: 'H4',
    lastName: 'Subject',
    organizationName: 'H4 Test School',
    organizationSlug: slug,
    ...overrides,
  };
  const res = await call(registerPost, jar, { method: 'POST', path: '/api/auth/register', body, headers });
  return { ...res, body, email, slug };
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, idle_timeout: 2 });
  // Auto-login failure: the session insert raises for one marker address.
  await owner.unsafe(`
    CREATE OR REPLACE FUNCTION h4_fault_sessions() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.ip_address = '${FAULT_IP}' THEN
        RAISE EXCEPTION 'H4-FAULT-MARKER: session insert refused';
      END IF;
      RETURN NEW;
    END $$;`);
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_fault_sessions ON sessions`);
  await owner.unsafe(`
    CREATE TRIGGER h4_fault_sessions BEFORE INSERT ON sessions
    FOR EACH ROW EXECUTE FUNCTION h4_fault_sessions()`);
  // Reset-consume failure: the family invalidation raises for one UA marker.
  await owner.unsafe(`
    CREATE OR REPLACE FUNCTION h4_fault_resets() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL
         AND OLD.request_user_agent LIKE '${LEAK_UA}%' THEN
        RAISE EXCEPTION 'H4-LEAK-MARKER: consume refused by password_resets_internal_idx';
      END IF;
      RETURN NEW;
    END $$;`);
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_fault_resets ON password_resets`);
  await owner.unsafe(`
    CREATE TRIGGER h4_fault_resets BEFORE UPDATE ON password_resets
    FOR EACH ROW EXECUTE FUNCTION h4_fault_resets()`);
});

afterAll(async () => {
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_fault_sessions ON sessions`);
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_fault_resets ON password_resets`);
  await owner.unsafe(`DROP FUNCTION IF EXISTS h4_fault_sessions()`);
  await owner.unsafe(`DROP FUNCTION IF EXISTS h4_fault_resets()`);
  await owner.end({ timeout: 2 });
});

beforeEach(async () => {
  await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
});

describe('H-4 — registration transactionality', () => {
  it('F1: duplicate email is a 409 EMAIL_TAKEN (cause-chain unwrap, not a 500)', async () => {
    const jar = new CookieJar();
    const first = await registerViaRoute(jar);
    expect(first.status).toBe(201);

    // Same email, new slug.
    const second = await registerViaRoute(new CookieJar(), {
      email: first.email,
      organizationSlug: uniq('h4-school'),
    });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe('EMAIL_TAKEN');
    expect(String(second.data.error.message)).toMatch(/email/i);
    // The refusal must not leak the constraint name or SQLSTATE.
    expect(JSON.stringify(second.data)).not.toMatch(/23505|_unique|_idx|constraint/i);

    // Nothing was provisioned for the rejected attempt.
    const rows = await sysQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      [second.email],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('F2: duplicate school slug is a 409 SLUG_TAKEN with no partial account', async () => {
    const jar = new CookieJar();
    const first = await registerViaRoute(jar);
    expect(first.status).toBe(201);

    const email2 = `${uniq('h4')}@example.com`;
    const second = await registerViaRoute(new CookieJar(), {
      email: email2,
      organizationSlug: first.slug,
    });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe('SLUG_TAKEN');
    expect(JSON.stringify(second.data)).not.toMatch(/23505|_unique|_idx|constraint/i);

    // The rejected email was NOT consumed: a retry with a free slug succeeds.
    const third = await registerViaRoute(new CookieJar(), {
      email: email2,
      organizationSlug: uniq('h4-school'),
    });
    expect(third.status).toBe(201);
  });

  it('F3 (core): a failed auto-login rolls back the whole registration (no orphan account)', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    try {
      const jar = new CookieJar();
      const failed = await registerViaRoute(
        jar,
        {},
        { 'x-forwarded-for': FAULT_IP },
      );
      expect(failed.status).toBe(500);
      expect(failed.data.error.code).toBe('INTERNAL');
      // No session cookie is published for a rolled-back unit of work.
      expect(jar.get(SESSION_COOKIE_NAME)).toBeFalsy();
      expect(jar.get(CSRF_COOKIE_NAME)).toBeFalsy();

      // NOTHING survives: user, school, membership, credential, session.
      const counts = await sysQuery<{
        users: number; orgs: number; members: number; creds: number; sessions: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM users WHERE email = $1) AS users,
          (SELECT count(*)::int FROM organizations WHERE slug = $2) AS orgs,
          (SELECT count(*)::int FROM organization_members om
             JOIN users u ON u.id = om.user_id WHERE u.email = $1) AS members,
          (SELECT count(*)::int FROM password_credentials pc
             JOIN users u ON u.id = pc.user_id WHERE u.email = $1) AS creds,
          (SELECT count(*)::int FROM sessions s
             JOIN users u ON u.id = s.user_id WHERE u.email = $1) AS sessions`,
        [failed.email, failed.slug],
      );
      expect(counts[0]).toEqual({ users: 0, orgs: 0, members: 0, creds: 0, sessions: 0 });

      // The email and slug are free again — the retry succeeds end to end.
      const retry = await registerViaRoute(new CookieJar(), {
        email: failed.email,
        organizationSlug: failed.slug,
      });
      expect(retry.status).toBe(201);
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });

  it('F4: registration is idempotent-in-effect — a retried signup cannot create a second account', async () => {
    const jar = new CookieJar();
    const first = await registerViaRoute(jar);
    expect(first.status).toBe(201);
    const rows = await sysQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      [first.email],
    );
    expect(rows[0]!.n).toBe(1);

    const replay = await registerViaRoute(new CookieJar(), {
      email: first.email,
      organizationSlug: first.slug,
    });
    expect(replay.status).toBe(409);
    expect(['EMAIL_TAKEN', 'SLUG_TAKEN']).toContain(replay.data.error.code);
    const after = await sysQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      [first.email],
    );
    expect(after[0]!.n).toBe(1);
  });
});

describe('H-4 — password reset lifecycle', () => {
  it('F5: consuming one token retires every outstanding token for that user', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);

    // Two independent reset requests (two live tokens).
    const a = await requestPasswordReset(reg.email, { ip: '198.51.100.7', userAgent: 'h4-a' });
    const b = await requestPasswordReset(reg.email, { ip: '198.51.100.8', userAgent: 'h4-b' });
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);

    const consumed = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: a.token, password: 'Br4nd-New-Password!' },
    });
    expect(consumed.status).toBe(200);

    // The sibling token is dead.
    const sibling = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: b.token, password: 'An0ther-New-Password!' },
    });
    expect(sibling.status).toBe(400);
    expect(sibling.data.error.code).toBe('RESET_INVALID');

    // The new password works and the old one does not.
    const good = await call(loginPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/login',
      body: { email: reg.email, password: 'Br4nd-New-Password!' },
    });
    expect(good.status).toBe(200);
    const stale = await call(loginPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/login',
      body: { email: reg.email, password: PASSWORD },
    });
    expect(stale.status).toBe(401);
  });

  it('F5b: an authenticated password change retires outstanding reset tokens', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);

    const pending = await requestPasswordReset(reg.email, { ip: '198.51.100.9', userAgent: 'h4-c' });
    expect(pending.token).toBeTruthy();

    const changed = await call(changePasswordPost, jar, {
      method: 'POST',
      path: '/api/auth/change-password',
      body: { currentPassword: PASSWORD, newPassword: 'Ch4nged-Password-Now!' },
      csrf: true,
    });
    expect(changed.status).toBe(200);

    const stale = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: pending.token, password: 'An0ther-New-Password!' },
    });
    expect(stale.status).toBe(400);
    expect(stale.data.error.code).toBe('RESET_INVALID');
  });

  it('F6: double consumption of the same token is refused (regression pin)', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    const t = await requestPasswordReset(reg.email, { ip: '198.51.100.10', userAgent: 'h4-d' });
    const first = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: t.token, password: 'First-Consume-Pass!' },
    });
    expect(first.status).toBe(200);
    const second = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: t.token, password: 'Second-Consume-Pass!' },
    });
    expect(second.status).toBe(400);
    expect(second.data.error.code).toBe('RESET_INVALID');
  });

  it('F8: a reset-consume failure never echoes internal error text', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    // Request the token through the ROUTE so the marker user-agent reaches the row.
    process.env.SCOLAIRA_DEV_ECHO_RESET_TOKEN = '1';
    const req = await call(resetRequestPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-request',
      body: { email: reg.email },
      headers: { 'user-agent': LEAK_UA },
    });
    delete process.env.SCOLAIRA_DEV_ECHO_RESET_TOKEN;
    expect(req.status).toBe(200);
    const token = req.data?.token;
    expect(token).toBeTruthy();

    const res = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token, password: 'Fault-Injected-Pass!' },
    });
    expect(res.status).toBe(500);
    expect(res.data.error.code).toBe('INTERNAL');
    const serialized = JSON.stringify(res.data);
    expect(serialized).not.toMatch(/H4-LEAK-MARKER/);
    expect(serialized).not.toMatch(/password_resets/);
    expect(serialized).not.toMatch(/duplicate key|constraint|SQLSTATE|pg_/i);
  });
});

describe('H-4 — session & logout lifecycle', () => {
  it('F7: logout requires CSRF; the no-JS form field works; header still works', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);

    // (a) No token at all → refused, and the session survives.
    const naked = await call(logoutPost, jar, { method: 'POST', path: '/api/auth/logout' });
    expect(naked.status).toBe(403);
    expect(naked.data.error.code).toBe('CSRF_MISSING');
    expect(jar.get(SESSION_COOKIE_NAME)).toBeTruthy();

    // (b) Wrong token → refused.
    const forged = await call(logoutPost, jar, {
      method: 'POST',
      path: '/api/auth/logout',
      headers: { 'x-csrf-token': 'not-the-token.deadbeef' },
    });
    expect(forged.status).toBe(403);
    expect(forged.data.error.code).toBe('CSRF_INVALID');

    // (c) The app-shell form path: `_csrf` field + Accept: text/html → 303.
    const csrfCookieValue = jar.get(CSRF_COOKIE_NAME)!;
    const form = await call(logoutPost, jar, {
      method: 'POST',
      path: '/api/auth/logout',
      formBody: { _csrf: csrfCookieValue },
      headers: { accept: 'text/html' },
    });
    expect(form.status).toBe(303);
    expect(jar.get(SESSION_COOKIE_NAME)).toBeFalsy();

    // (d) Header path still works for fetch callers.
    const jar2 = new CookieJar();
    const reg2 = await registerViaRoute(jar2);
    expect(reg2.status).toBe(201);
    const hdr = await call(logoutPost, jar2, {
      method: 'POST',
      path: '/api/auth/logout',
      csrf: true,
    });
    expect(hdr.status).toBe(200);
    expect((await call(meGet, jar2, { method: 'GET', path: '/api/auth/me' })).status).toBe(401);
  });

  it('F10: switchOrganization writes a verifiable active-org cookie', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);
    const userId = reg.data.organizationId
      ? (await sysQuery<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [reg.email]))[0]!.id
      : null;
    expect(userId).toBeTruthy();

    // Second organization + ACTIVE membership for the same user.
    const org2 = randomUUID();
    await sysQuery(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'H4 Second School', $2)`,
      [org2, uniq('h4-second')],
    );
    await sysQuery(
      `INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'SCHOOL_ADMIN', 'ACTIVE', now())`,
      [org2, userId],
    );

    const store = {
      get(name: string) {
        const v = jar.get(name);
        return v !== undefined ? { name, value: v } : undefined;
      },
      set(opts: { name: string; value: string } & Record<string, unknown>) {
        jar.setFromSetCookie(`${opts.name}=${opts.value}; Path=/`);
      },
      delete(name: string) {
        jar.delete(name);
      },
    };
    __setCookieStoreForTest(store);
    try {
      const session = await getSession(store);
      expect(session).toBeTruthy();
      const before = session!.activeOrganizationId;

      const switched = await switchOrganization(session!, org2 as never);
      expect(switched.activeOrganizationId).toBe(org2);

      const cookieValue = jar.get(ACTIVE_ORG_COOKIE_NAME);
      expect(cookieValue).toBeTruthy();
      expect(verifyActiveOrgCookie(cookieValue, session!.user.id)).toBe(org2);

      // The switched preference is actually honoured by the trust gate.
      const reread = await getSession(store);
      expect(reread!.activeOrganizationId).toBe(org2);
      expect(reread!.activeOrganizationId).not.toBe(before);

      // A non-member organization is refused outright.
      await expect(switchOrganization(session!, randomUUID() as never)).rejects.toThrow(/not a member/i);
    } finally {
      __setCookieStoreForTest(null);
    }
  });
});

describe('H-4 — rate-limit identity (spoofed x-forwarded-for)', () => {
  it('F9: spoofed headers cannot mint fresh buckets when no proxy is declared', async () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await registerViaRoute(new CookieJar(), {}, { 'x-forwarded-for': `203.0.113.${100 + i}` });
      statuses.push(res.status);
    }
    const accepted = statuses.filter((s) => s === 201).length;
    const refused = statuses.filter((s) => s === 429).length;
    // 5/hour is the configured register policy; every spoofed header used to
    // land in its own bucket, so all 7 were accepted.
    expect(accepted).toBe(5);
    expect(refused).toBe(2);

    // The refusal is actionable and names the retry window.
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    const next = await registerViaRoute(new CookieJar(), {}, { 'x-forwarded-for': '203.0.113.200' });
    expect(next.status).toBe(201);
  });

  it('F9b: with a declared single proxy hop, the proxy-provided address is honoured', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    try {
      await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const res = await registerViaRoute(new CookieJar(), {}, { 'x-forwarded-for': `198.51.100.${10 + i}` });
        statuses.push(res.status);
      }
      expect(statuses.every((s) => s === 201)).toBe(true);
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });
});
