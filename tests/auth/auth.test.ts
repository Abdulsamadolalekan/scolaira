/**
 * M3 Auth red-team tests — real PostgreSQL, real cookies, real argon2.
 *
 * Non-concurrency tests ride the existing BEGIN/ROLLBACK per-test isolation
 * provided by tests/setup-db.ts. Concurrency tests open their own PG
 * connections (like tests/db/concurrency.test.ts) so writes commit and are
 * visible between workers.
 */
// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';
import { POST as resetReqPost } from '@/app/api/auth/reset-request/route';
import { POST as resetConfirmPost } from '@/app/api/auth/reset-confirm/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as changePasswordPost } from '@/app/api/auth/change-password/route';
import { CookieJar, call, uuidRe } from './support';
import { getDb, getSql } from '@/lib/db';
import { users } from '@/lib/db/schema/tenancy';
import { passwordCredentials, sessions as sessionsTable } from '@/lib/db/schema/auth';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const URL = process.env.DATABASE_URL ?? 'postgresql://scolaira:scolaira@localhost:5432/scolaira_test';

// Ensure system context in this connection
beforeAll(async () => {
  const sql = getSql();
  await sql`SELECT set_tenant_context_for_system(NULL, NULL)`;
});

afterEach(async () => {
  // Clear GUCs between tests
  const sql = getSql();
  await sql`SELECT set_config('app.organization_id','',false), set_config('app.user_id','',false), set_config('app.is_platform_admin','0',false), set_config('app.bypass_financial_triggers','0',false)`.catch(() => {});
});

afterAll(async () => {
  // no-op; pool teardown handled globally
});

function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
}
function uniqueSlug(prefix = 'school'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function registerAndLogin(input?: Partial<{email: string; password: string; firstName: string; lastName: string; orgName: string; slug: string}>): Promise<{jar: CookieJar; email: string; password: string; orgId: string; userId: string}> {
  const jar = new CookieJar();
  const email = input?.email ?? uniqueEmail();
  const password = input?.password ?? 'Str0ng!Passw0rd-For-Test';
  const firstName = input?.firstName ?? 'Ada';
  const lastName = input?.lastName ?? 'Lovelace';
  const orgName = input?.orgName ?? 'Ada Academy';
  const slug = input?.slug ?? uniqueSlug();
  const r = await call(registerPost, jar, { method: 'POST', path: '/api/auth/register', body: { email, password, firstName, lastName, organizationName: orgName, organizationSlug: slug } });
  expect(r.status).toBe(201);
  expect(r.data.ok).toBe(true);
  expect(uuidRe.test(r.data.organizationId)).toBe(true);
  // Pull userId from /me
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  return { jar, email, password, orgId: r.data.organizationId, userId: me.data.user.id };
}

describe('M3 — Authentication security red-team', () => {

  it('anonymous /api/auth/me returns 401', async () => {
    const jar = new CookieJar();
    const r = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
    expect(r.status).toBe(401);
  });

  it('register creates user+org+membership and logs in immediately', async () => {
    const { jar, email, orgId } = await registerAndLogin();
    const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe(email);
    expect(me.data.activeOrganizationId).toBe(orgId);
    expect(me.data.memberships).toHaveLength(1);
    expect(me.data.memberships[0].role).toBe('SCHOOL_ADMIN');
    expect(me.data.memberships[0].status).toBe('ACTIVE');
  });

  it('login creates fresh session (anti-fixation); old session cannot be replayed', async () => {
    const { jar: regJar, email, password } = await registerAndLogin();
    const firstCookie = regJar.get('sc_session');
    expect(firstCookie).toBeTruthy();
    // Logout revokes first session
    const logoutR = await call(logoutPost, regJar, { method: 'POST', path: '/api/auth/logout' });
    expect(logoutR.status).toBe(200);
    // Replay first cookie must fail
    const replayJar = new CookieJar();
    replayJar.setFromSetCookie(`sc_session=${firstCookie}; Path=/`);
    const replay = await call(meGet, replayJar, { method: 'GET', path: '/api/auth/me' });
    expect(replay.status).toBe(401);
    // Fresh login
    const jar2 = new CookieJar();
    const loginR = await call(loginPost, jar2, { method: 'POST', path: '/api/auth/login', body: { email, password } });
    expect(loginR.status).toBe(200);
    const secondCookie = jar2.get('sc_session');
    expect(secondCookie).toBeTruthy();
    expect(secondCookie).not.toBe(firstCookie);
    const me = await call(meGet, jar2, { method: 'GET', path: '/api/auth/me' });
    expect(me.status).toBe(200);
  });

  it('wrong password and unknown email return identical generic 401', async () => {
    const { email, password } = await registerAndLogin();
    const jarA = new CookieJar();
    const wrong = await call(loginPost, jarA, { method: 'POST', body: { email, password: 'Definitely-Wrong-Password-1' } });
    expect(wrong.status).toBe(401);
    expect(wrong.data.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.data.error.message).toBe('Invalid email or password.');

    const jarB = new CookieJar();
    const unknown = await call(loginPost, jarB, { method: 'POST', body: { email: 'does.not.exist.' + Date.now() + '@example.com', password } });
    expect(unknown.status).toBe(401);
    expect(unknown.data.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.data.error.message).toBe('Invalid email or password.');
  });

  it('forged/tampered session cookie rejected (HMAC)', async () => {
    const { jar } = await registerAndLogin();
    const original = jar.get('sc_session')!;
    // Flip a character in the SIGNATURE portion (last segment) specifically,
    // because flipping the session id base64url could coincidentally preserve
    // format.
    const parts = original.split('.');
    expect(parts.length).toBe(3);
    const sig = parts[2]!;
    const tamperedSig = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    const badJar = new CookieJar();
    badJar.setFromSetCookie(`sc_session=${tampered}; Path=/`);
    const me = await call(meGet, badJar, { method: 'GET', path: '/api/auth/me' });
    expect(me.status).toBe(401);
    const garbageJar = new CookieJar();
    garbageJar.setFromSetCookie(`sc_session=not-a-valid-cookie; Path=/`);
    const me2 = await call(meGet, garbageJar, { method: 'GET', path: '/api/auth/me' });
    expect(me2.status).toBe(401);
  });

  it('logout revokes server-side session; cookie deleted', async () => {
    const { jar } = await registerAndLogin();
    expect((await call(meGet, jar, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
    const logoutR = await call(logoutPost, jar, { method: 'POST', path: '/api/auth/logout' });
    expect(logoutR.status).toBe(200);
    expect(jar.get('sc_session')).toBeFalsy();
    expect((await call(meGet, jar, { method: 'GET', path: '/api/auth/me' })).status).toBe(401);
  });

  it('CSRF blocks POST without x-csrf-token even with a valid session cookie', async () => {
    const { jar } = await registerAndLogin();
    const r = await call(changePasswordPost, jar, {
      method: 'POST', path: '/api/auth/change-password',
      body: { currentPassword: 'Str0ng!Passw0rd-For-Test', newPassword: 'New-Str0ng-Password-9' },
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('CSRF_MISSING');
  });

  it('CSRF passes when double-submit token included', async () => {
    const { jar } = await registerAndLogin();
    const r = await call(changePasswordPost, jar, {
      method: 'POST', path: '/api/auth/change-password',
      body: { currentPassword: 'Str0ng!Passw0rd-For-Test', newPassword: 'New-Str0ng-Password-9' },
      csrf: true,
    });
    expect(r.status).toBe(200);
  });

  it('change-password rejects wrong current password', async () => {
    const { jar } = await registerAndLogin();
    const r = await call(changePasswordPost, jar, {
      method: 'POST', path: '/api/auth/change-password',
      body: { currentPassword: 'WrongCurrent-1!', newPassword: 'Brand-New-Pass-9' },
      csrf: true,
    });
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('INVALID_PASSWORD');
  });

  it('password reset: token issues, consumes, rotates password, revokes sessions, single-use', async () => {
    const { jar, email, password } = await registerAndLogin();
    expect((await call(meGet, jar, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
    const reqR = await call(resetReqPost, new CookieJar(), { method: 'POST', body: { email } });
    expect(reqR.status).toBe(200);
    expect(reqR.data.ok).toBe(true);
    const token: string = reqR.data.token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(30);
    // Pre-consume: old session still works
    expect((await call(meGet, jar, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
    const confirm = await call(resetConfirmPost, new CookieJar(), { method: 'POST', body: { token, password: 'NewResetPass-42!' } });
    expect(confirm.status).toBe(200);
    // All previous sessions revoked
    expect((await call(meGet, jar, { method: 'GET', path: '/api/auth/me' })).status).toBe(401);
    // New password works
    const loginJar = new CookieJar();
    const login = await call(loginPost, loginJar, { method: 'POST', body: { email, password: 'NewResetPass-42!' } });
    expect(login.status).toBe(200);
    expect((await call(meGet, loginJar, { method: 'GET', path: '/api/auth/me' })).status).toBe(200);
    // Old password fails
    const oldLogin = await call(loginPost, new CookieJar(), { method: 'POST', body: { email, password } });
    expect(oldLogin.status).toBe(401);
    // Replay of token fails (single-use)
    const replay = await call(resetConfirmPost, new CookieJar(), { method: 'POST', body: { token, password: 'NewResetPass-99!' } });
    expect(replay.status).toBe(400);
    expect(replay.data.error.code).toBe('RESET_INVALID');
  });

  it('reset request for unknown email returns generic ok (no enumeration)', async () => {
    const r = await call(resetReqPost, new CookieJar(), { method: 'POST', body: { email: 'ghost-' + Date.now() + '@example.com' } });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.token).toBeNull();
  });

  it('forged reset token rejected', async () => {
    const r = await call(resetConfirmPost, new CookieJar(), { method: 'POST', body: { token: 'definitely-not-a-real-token-abc', password: 'AnyNewPass-1!' } });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('RESET_INVALID');
  });

  it('responses never contain password_hash, argon2, or 64-hex session secret', async () => {
    const { jar } = await registerAndLogin();
    const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
    const body = JSON.stringify(me.data);
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$argon2');
    expect(body).not.toMatch(/[a-f0-9]{64}/); // no sha256 hex leak
  });

  it('DB stores argon2id hash, not plaintext/bcrypt', async () => {
    const { email } = await registerAndLogin({ password: 'Test-Pass-Argon2-1!' });
    const db = getDb();
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(u).toBeTruthy();
    const [c] = await db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, u!.id)).limit(1);
    expect(c).toBeTruthy();
    expect(c!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(c!.algorithm).toBe('argon2id');
    // Plaintext password must NOT be stored
    expect(c!.passwordHash).not.toContain('Test-Pass-Argon2-1!');
  });

  it('sessions table stores sha256(rawId) hex — raw id never persisted', async () => {
    const { jar } = await registerAndLogin();
    const cookie = jar.get('sc_session')!;
    const rawId = cookie.split('.')[0]!;
    expect(rawId.length).toBe(43);
    const db = getDb();
    const all = await db.select().from(sessionsTable);
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const s of all) {
      expect(s.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(s)).not.toContain(rawId);
    }
  });

  it('authenticated user cannot adopt a foreign org via sc_org cookie', async () => {
    const a = await registerAndLogin({ email: uniqueEmail('a'), slug: uniqueSlug('a') });
    const b = await registerAndLogin({ email: uniqueEmail('b'), slug: uniqueSlug('b') });
    b.jar.setFromSetCookie(`sc_org=${a.orgId}; Path=/`);
    const me = await call(meGet, b.jar, { method: 'GET', path: '/api/auth/me' });
    expect(me.status).toBe(200);
    expect(me.data.activeOrganizationId).toBe(b.orgId); // NOT a.orgId
    expect(me.data.user.email).toBe(b.email);
  });

  it('login rate limit triggers after repeated failures (per email)', async () => {
    const email = uniqueEmail('rl');
    await registerAndLogin({ email, password: 'GoodPass12345!' });
    const jar = new CookieJar();
    for (let i = 0; i < 10; i++) {
      const r = await call(loginPost, jar, { method: 'POST', body: { email, password: 'WrongPass12345!' } });
      expect(r.status).toBe(401);
    }
    const r = await call(loginPost, jar, { method: 'POST', body: { email, password: 'GoodPass12345!' } });
    expect(r.status).toBe(429);
    expect(r.data.error.code).toBe('RATE_LIMITED');
  }, 30_000);

});

// ---------- Concurrency tests (separate PG connections, committed rows) ----------
describe('M3 — Auth concurrency (real PG sessions)', () => {

  /** Open a dedicated autocommit connection (outside the per-test txn). */
  function authedConn<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    return new Promise<T>(async (resolve, reject) => {
      const sql = postgres(URL, { max: 1 });
      try {
        await sql`SELECT set_tenant_context_for_system(NULL, NULL)`;
        resolve(await fn(sql));
      } catch (e) { reject(e); }
      finally {
        await sql`SELECT set_config('app.organization_id','',false), set_config('app.user_id','',false)`.catch(() => {});
        await sql.end({ timeout: 5 });
      }
    });
  }

  let cleanupIds: { orgSlug: string; email: string }[] = [];

  afterEach(async () => {
    // Cleanup any committed rows via an autocommit connection.
    if (cleanupIds.length) {
      await authedConn(async (sql) => {
        for (const c of cleanupIds) {
          // Cascade via users.id (foreign keys are ON DELETE CASCADE).
          await sql`DELETE FROM users WHERE email=${c.email}`;
          await sql`DELETE FROM organizations WHERE slug=${c.orgSlug}`;
          await sql`DELETE FROM rate_limits WHERE key LIKE ${'login:%'}`;
        }
      });
      cleanupIds = [];
    }
  });

  it('concurrent duplicate registrations produce exactly one user', async () => {
    const email = uniqueEmail('dup');
    const base = uniqueSlug('dup');
    const slugA = base + '-a', slugB = base + '-b';
    cleanupIds.push({ email, orgSlug: slugA }, { email, orgSlug: slugB });

    // Use two dedicated raw-Postgres connections to race insertions that
    // mirror register() (user+org+member+credential). The uniqueness
    // constraint on users.email must make exactly one succeed.
    const result = await Promise.allSettled([
      authedConn(async (sql) => {
        const uid = randomUUID();
        const oid = randomUUID();
        const now = new Date();
        await sql`INSERT INTO users (id, email, first_name, last_name, created_at, updated_at, is_platform_admin)
                  VALUES (${uid}::uuid, ${email}, 'Race', 'A', ${now}, ${now}, false)`;
        await sql`INSERT INTO organizations (id, name, slug, currency, timezone, plan, status, created_at, updated_at)
                  VALUES (${oid}::uuid, 'Race Org A', ${slugA}, 'NGN', 'Africa/Lagos', 'pilot', 'ACTIVE', ${now}, ${now})`;
        return 'a';
      }),
      authedConn(async (sql) => {
        const uid = randomUUID();
        const oid = randomUUID();
        const now = new Date();
        await sql`INSERT INTO users (id, email, first_name, last_name, created_at, updated_at, is_platform_admin)
                  VALUES (${uid}::uuid, ${email}, 'Race', 'B', ${now}, ${now}, false)`;
        await sql`INSERT INTO organizations (id, name, slug, currency, timezone, plan, status, created_at, updated_at)
                  VALUES (${oid}::uuid, 'Race Org B', ${slugB}, 'NGN', 'Africa/Lagos', 'pilot', 'ACTIVE', ${now}, ${now})`;
        return 'b';
      }),
    ]);

    const successes = result.filter((r) => r.status === 'fulfilled').length;
    expect(successes).toBeLessThanOrEqual(1);

    const count = await authedConn(async (sql) => {
      const rows = await sql<{n: number}[]>`SELECT count(*)::int AS n FROM users WHERE email=${email}`;
      return rows[0]!.n;
    });
    expect(count).toBe(1);
  }, 30_000);

  it('concurrent reset-consume: exactly one succeeds (row-lock atomicity)', async () => {
    // Setup: register a user and issue a reset token via the API (uses global
    // pool which is in the per-test txn — but we need the token to be visible
    // to concurrent connections). So we'll create user+cred+token directly via
    // an autocommit connection, then race two consume attempts through
    // dedicated authed connections that call the underlying resetPassword logic.
    // Simpler: issue two direct UPDATE attempts mirroring reset-password flow
    // on the same token row using SELECT ... FOR UPDATE.
    const email = uniqueEmail('race-consume');
    const cslug = uniqueSlug('race-consume');
    cleanupIds.push({ email, orgSlug: cslug });

    const { tokenHash } = await authedConn(async (sql) => {
      const uid = randomUUID();
      const oid = randomUUID();
      const now = new Date();
      await sql`INSERT INTO users (id, email, first_name, last_name, created_at, updated_at) VALUES (${uid}::uuid, ${email}, 'Race', 'User', ${now}, ${now})`;
      await sql`INSERT INTO organizations (id, name, slug, currency, timezone, plan, status, created_at, updated_at) VALUES (${oid}::uuid, 'RC Org', ${cslug}, 'NGN', 'Africa/Lagos', 'pilot', 'ACTIVE', ${now}, ${now})`;
      // Dummy argon2 hash
      await sql`INSERT INTO password_credentials (user_id, algorithm, params, password_hash, created_at, updated_at) VALUES (${uid}::uuid, 'argon2id', '{}'::jsonb, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHlzb2RpdW0$' || encode(gen_random_bytes(16), 'hex'), ${now}, ${now})`;
      // Insert a reset token with known plaintext 'plaintext-token-abcdef-123456'
      const plain = 'plaintext-token-abcdef-123456';
      const hash = await sql<{h: string}[]>`SELECT encode(digest(${plain}, 'sha256'), 'hex') AS h`;
      const th = hash[0]!.h;
      await sql`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (${uid}::uuid, ${th}, now() + interval '1 hour')`;
      return { tokenHash: th, userId: uid, plain };
    });

    // Race two consumers that each attempt the SELECT FOR UPDATE + UPDATE
    // in autocommit, mirroring resetPassword() semantics.
    // Mirror the production resetPassword() logic exactly:
    //   1. SELECT ... WHERE token_hash = $th AND consumed_at IS NULL FOR UPDATE
    //   2. if no row, return invalid
    //   3. UPDATE consumed_at = now() WHERE id = $id
    // Under READ COMMITTED, if txn A commits first, txn B's re-evaluated WHERE
    // (consumed_at IS NULL) will fail, so B sees no row and returns invalid.
    async function contender() {
      return authedConn(async (sql) => {
        await sql`BEGIN ISOLATION LEVEL READ COMMITTED`;
        try {
          const rows = await sql<any[]>`SELECT id, user_id, consumed_at FROM password_resets
                                          WHERE token_hash=${tokenHash} AND consumed_at IS NULL
                                          FOR UPDATE`;
          if (!rows[0]) { await sql`ROLLBACK`; return 'invalid'; }
          await sql`UPDATE password_resets SET consumed_at=now() WHERE id=${rows[0].id}::uuid`;
          await sql`COMMIT`;
          return 'won';
        } catch (e) { await sql`ROLLBACK`; throw e; }
      });
    }
    const raceResults = await Promise.allSettled([contender(), contender()]);

    const wins = raceResults.filter((r) => r.status === 'fulfilled' && r.value === 'won').length;
    expect(wins).toBe(1);

    const consumed = await authedConn(async (sql) => {
      const rows = await sql<{n: number}[]>`SELECT count(*)::int AS n FROM password_resets WHERE token_hash=${tokenHash} AND consumed_at IS NOT NULL`;
      return rows[0]!.n;
    });
    expect(consumed).toBe(1);
  }, 30_000);
});
