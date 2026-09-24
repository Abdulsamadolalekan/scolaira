/**
 * H-4 INDEPENDENT RE-AUDIT — adversarial pass over the fixed surface.
 *
 * Written as an attempt to BREAK the H-4 remediations rather than to re-run
 * their happy paths:
 *
 *  A. atomicity attacked from a different injection point (last insert),
 *  B. conflict labels attacked with user-chosen values that impersonate a column,
 *  C. reset-family ordering attacked through the expiry path,
 *  D. CSRF refused when the token belongs to another session,
 *  E. the active-org preference attacked by tampering / non-ACTIVE membership,
 *  F. the rate-limit identity attacked by prepending hops,
 *  G. session-revocation contract pinned around a password change.
 *
 * Injector: one BEFORE INSERT trigger on `password_credentials`, armed through
 * a GUC this file sets and clears itself; it is dropped in `afterAll`.
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
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as changePasswordPost } from '@/app/api/auth/change-password/route';
import { getSql } from '@/lib/db';
import {
  __setCookieStoreForTest,
  getSession,
  switchOrganization,
  requestPasswordReset,
} from '@/lib/auth';
import { verifyActiveOrgCookie } from '@/lib/auth/cookies';
import { ACTIVE_ORG_COOKIE_NAME, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '@/lib/auth/config';
import { CookieJar, call } from './support';

const OWNER_URL = process.env.DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';

const PASSWORD = 'Str0ng!Passw0rd-For-Test';
const FAULT_GUC = 'app.h4_audit_fault';

const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

let owner: postgres.Sql;

async function sysQuery<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const sql = getSql();
  await sql`SELECT auth_test_system_context(NULL, NULL)`;
  return (await sql.unsafe<T[]>(query, params as never[])) as T[];
}

async function setFaultGuc(value: string): Promise<void> {
  const sql = getSql();
  await sql.unsafe(`SELECT set_config('${FAULT_GUC}', '${value}', false)`);
}

async function registerViaRoute(jar: CookieJar, overrides: Record<string, string> = {}) {
  const slug = uniq('h4a-school');
  const email = `${uniq('h4a')}@example.com`;
  const res = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: PASSWORD,
      firstName: 'H4',
      lastName: 'Audit',
      organizationName: 'H4 Audit School',
      organizationSlug: slug,
      ...overrides,
    },
  });
  return { ...res, email, slug };
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, idle_timeout: 2 });
  // Arms only when this suite sets the GUC: the LAST provisioning insert fails.
  await owner.unsafe(`
    CREATE OR REPLACE FUNCTION h4_audit_fault_credentials() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('${FAULT_GUC}', true) = '1' THEN
        RAISE EXCEPTION 'H4-AUDIT-FAULT: credential insert refused';
      END IF;
      RETURN NEW;
    END $$;`);
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_audit_fault_credentials ON password_credentials`);
  await owner.unsafe(`
    CREATE TRIGGER h4_audit_fault_credentials BEFORE INSERT ON password_credentials
    FOR EACH ROW EXECUTE FUNCTION h4_audit_fault_credentials()`);
});

afterAll(async () => {
  await owner.unsafe(`DROP TRIGGER IF EXISTS h4_audit_fault_credentials ON password_credentials`);
  await owner.unsafe(`DROP FUNCTION IF EXISTS h4_audit_fault_credentials()`);
  await owner.end({ timeout: 2 });
});

beforeEach(async () => {
  await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
});

describe('H-4 re-audit A — atomicity from a different injection point', () => {
  it('a failure on the LAST provisioning insert still rolls back user, school and membership', async () => {
    await setFaultGuc('1');
    let failed: Awaited<ReturnType<typeof registerViaRoute>>;
    try {
      failed = await registerViaRoute(new CookieJar());
    } finally {
      await setFaultGuc('0');
    }
    expect(failed.status).toBe(500);
    expect(failed.data.error.code).toBe('INTERNAL');
    expect(JSON.stringify(failed.data)).not.toMatch(/H4-AUDIT-FAULT/);

    const counts = await sysQuery<{ users: number; orgs: number; members: number }>(`
      SELECT
        (SELECT count(*)::int FROM users WHERE email = $1) AS users,
        (SELECT count(*)::int FROM organizations WHERE slug = $2) AS orgs,
        (SELECT count(*)::int FROM organization_members om
           JOIN users u ON u.id = om.user_id WHERE u.email = $1) AS members`,
      [failed.email, failed.slug],
    );
    expect(counts[0]).toEqual({ users: 0, orgs: 0, members: 0 });

    // Same email + slug are still free: the failure left no reservation.
    const retry = await registerViaRoute(new CookieJar(), {
      email: failed.email,
      organizationSlug: failed.slug,
    });
    expect(retry.status).toBe(201);
  });
});

describe('H-4 re-audit B — conflict labels cannot be impersonated by user values', () => {
  it('a duplicate email whose address contains "slug" is still EMAIL_TAKEN', async () => {
    const jar = new CookieJar();
    const first = await registerViaRoute(jar);
    expect(first.status).toBe(201);
    const trickyEmail = `slug-${uniq('trap')}@example.com`;
    const seeded = await registerViaRoute(new CookieJar(), { email: trickyEmail });
    expect(seeded.status).toBe(201);

    const duplicate = await registerViaRoute(new CookieJar(), { email: trickyEmail });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error.code).toBe('EMAIL_TAKEN');
  });

  it('a duplicate school address whose slug contains "email" is still SLUG_TAKEN', async () => {
    const first = await registerViaRoute(new CookieJar());
    expect(first.status).toBe(201);
    const trickySlug = `email-${uniq('trap')}`.toLowerCase();
    const seeded = await registerViaRoute(new CookieJar(), { organizationSlug: trickySlug });
    expect(seeded.status).toBe(201);

    const duplicate = await registerViaRoute(new CookieJar(), { organizationSlug: trickySlug });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error.code).toBe('SLUG_TAKEN');
  });
});

describe('H-4 re-audit C — reset family ordering', () => {
  it('an EXPIRED token is refused without retiring the live sibling', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);

    const expired = await requestPasswordReset(reg.email, { ip: '203.0.113.9', userAgent: 'h4-expired' });
    const live = await requestPasswordReset(reg.email, { ip: '203.0.113.10', userAgent: 'h4-live' });
    expect(expired.token && live.token).toBeTruthy();

    // Expire the first token directly (owner-side), leaving the second live.
    const sql = getSql();
    await sql`SELECT auth_test_system_context(NULL, NULL)`;
    await sql`UPDATE password_resets SET expires_at = now() - interval '5 minutes'
               WHERE user_id = (SELECT id FROM users WHERE email = ${reg.email})`;

    // Re-issue the live one AFTER the mass expiry above.
    const live2 = await requestPasswordReset(reg.email, { ip: '203.0.113.11', userAgent: 'h4-live2' });
    expect(live2.token).toBeTruthy();

    const expiredAttempt = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: expired.token, password: 'Expired-Token-Pass!' },
    });
    // Either RESET_EXPIRED, or RESET_INVALID if the row was swept as consumed —
    // never a success, never a 500.
    expect([400]).toContain(expiredAttempt.status);
    expect(['RESET_EXPIRED', 'RESET_INVALID']).toContain(expiredAttempt.data.error.code);

    // An expired/failed attempt must not have consumed the live sibling.
    const liveAttempt = await call(resetConfirmPost, new CookieJar(), {
      method: 'POST',
      path: '/api/auth/reset-confirm',
      body: { token: live2.token, password: 'Live-Token-Pass-Now!' },
    });
    expect(liveAttempt.status).toBe(200);
  });
});

describe('H-4 re-audit D — CSRF is bound to the session it protects', () => {
  it('another session’s CSRF token cannot log this session out', async () => {
    const jarA = new CookieJar();
    const regA = await registerViaRoute(jarA);
    expect(regA.status).toBe(201);
    const jarB = new CookieJar();
    const regB = await registerViaRoute(jarB);
    expect(regB.status).toBe(201);

    const foreignToken = jarB.get(CSRF_COOKIE_NAME)!;
    expect(foreignToken).toBeTruthy();

    const attempt = await call(logoutPost, jarA, {
      method: 'POST',
      path: '/api/auth/logout',
      headers: { 'x-csrf-token': foreignToken },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.data.error.code).toBe('CSRF_INVALID');
    // Session A is untouched.
    expect(jarA.get(SESSION_COOKIE_NAME)).toBeTruthy();
    expect((await call(meGet, jarA, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
  });
});

describe('H-4 re-audit E — the active-org preference is not authority', () => {
  it('a tampered/unsigned cookie is ignored, and a non-ACTIVE membership cannot be switched to', async () => {
    const jar = new CookieJar();
    const reg = await registerViaRoute(jar);
    expect(reg.status).toBe(201);
    const userId = (await sysQuery<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [reg.email]))[0]!.id;
    const activeOrg = (await sysQuery<{ organization_id: string }>(
      `SELECT organization_id FROM organization_members WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    ))[0]!.organization_id;

    const invitedOrg = randomUUID();
    await sysQuery(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'H4 Invited School', $2)`, [
      invitedOrg,
      uniq('h4-invited'),
    ]);
    await sysQuery(
      `INSERT INTO organization_members (organization_id, user_id, role, status)
       VALUES ($1, $2, 'STAFF', 'INVITED')`,
      [invitedOrg, userId],
    );

    // (1) An unsigned cookie value (the pre-H-4 switch wrote exactly this) is
    // not honoured.
    expect(verifyActiveOrgCookie(activeOrg, userId)).toBeNull();
    jar.setFromSetCookie(`${ACTIVE_ORG_COOKIE_NAME}=${invitedOrg}; Path=/`);
    const store = {
      get: (name: string) => {
        const v = jar.get(name);
        return v !== undefined ? { name, value: v } : undefined;
      },
      set: (opts: { name: string; value: string } & Record<string, unknown>) => {
        jar.setFromSetCookie(`${opts.name}=${opts.value}; Path=/`);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    };
    __setCookieStoreForTest(store);
    try {
      const session = await getSession(store);
      expect(session).toBeTruthy();
      expect(session!.activeOrganizationId).toBe(activeOrg);

      // (2) Switching to a non-ACTIVE membership is refused.
      await expect(switchOrganization(session!, invitedOrg as never)).rejects.toThrow(/not a member/i);

      // (3) ...and the refusal left no forged preference behind.
      const value = jar.get(ACTIVE_ORG_COOKIE_NAME);
      expect(verifyActiveOrgCookie(value, userId)).toBeNull();
      expect((await getSession(store))!.activeOrganizationId).toBe(activeOrg);
    } finally {
      __setCookieStoreForTest(null);
    }
  });
});

describe('H-4 re-audit F — rate-limit identity cannot be shifted by prepending hops', () => {
  it('with one declared trusted proxy, prepended fake addresses keep the same bucket', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    try {
      await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        // Rightmost entry is the proxy's own observation and stays constant;
        // a client that prepends anything must not rotate its bucket.
        const res = await call(registerPost, new CookieJar(), {
          method: 'POST',
          path: '/api/auth/register',
          headers: { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.77` },
          body: {
            email: `${uniq('h4a-ff')}@example.com`,
            password: PASSWORD,
            firstName: 'H4',
            lastName: 'Forwarded',
            organizationName: 'H4 Forwarded School',
            organizationSlug: uniq('h4a-ff-school'),
          },
        });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 201).length).toBe(5);
      expect(statuses.filter((s) => s === 429).length).toBe(2);

      // Junk values are not keys either.
      await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
      process.env.TRUSTED_PROXY_HOPS = '2';
      const junk = await call(registerPost, new CookieJar(), {
        method: 'POST',
        path: '/api/auth/register',
        headers: { 'x-forwarded-for': '203.0.113.5' },
        body: {
          email: `${uniq('h4a-junk')}@example.com`,
          password: PASSWORD,
          firstName: 'H4',
          lastName: 'Junk',
          organizationName: 'H4 Junk School',
          organizationSlug: uniq('h4a-junk-school'),
        },
      });
      // Two declared hops but only one entry → the leftmost entry is used
      // (never a crash, never an unbounded bucket).
      expect([201, 429]).toContain(junk.status);
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });
});

describe('H-4 re-audit G — session revocation contract around a password change', () => {
  it('changing the password revokes other sessions but keeps the current one', async () => {
    const jarA = new CookieJar();
    const reg = await registerViaRoute(jarA);
    expect(reg.status).toBe(201);

    // A second live session for the same account.
    const jarB = new CookieJar();
    const loginB = await call(loginPost, jarB, {
      method: 'POST',
      path: '/api/auth/login',
      body: { email: reg.email, password: PASSWORD },
    });
    expect(loginB.status).toBe(200);
    expect((await call(meGet, jarB, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);

    const changed = await call(changePasswordPost, jarA, {
      method: 'POST',
      path: '/api/auth/change-password',
      body: { currentPassword: PASSWORD, newPassword: 'R0tated-Password-Keep!' },
      csrf: true,
    });
    expect(changed.status).toBe(200);

    expect((await call(meGet, jarA, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
    expect((await call(meGet, jarB, { method: 'GET', path: '/api/auth/me' })).status).toBe(401);
  });
});
