/**
 * SCOLAIRA authentication — server-side trust boundary.
 *
 * This is the ONE authoritative module for authenticated identity (M3 §4).
 * All protected handlers/actions MUST obtain identity via this module:
 * never via direct cookie parsing, never via client-submitted org headers,
 * never by trusting a URL param.
 *
 * Identity chain (§4):
 *   REQUEST
 *     → verify signed HttpOnly session cookie (HMAC-SHA256)
 *     → sha256(raw session id) → lookup sessions JOIN users
 *     → verify not revoked, not expired, within absolute max age
 *     → load ACTIVE organization_members for the user
 *     → resolve active organization
 *     → SET GUCs app.organization_id / app.user_id (M2 tenant boundary)
 *     → return { user, memberships, activeOrganizationId, sessionId }
 *     → caller MUST invoke clearContext() (withAuth does it automatically)
 *
 * Security properties:
 *   - server-only (cannot be bundled client-side)
 *   - Session ids 32-byte CSPRNG; DB stores sha256(id) hex at rest
 *   - Cookie: HttpOnly + Secure (prod) + SameSite=Lax + signed
 *   - Passwords: argon2id (OWASP 2024 params); never logged
 *   - Rate limits via Postgres `auth_rate_limit_hit()`
 *   - CSRF double-submit for unsafe methods
 *   - Generic error messages to resist enumeration (timing-equalized)
 *   - Session rotated on login/privilege change; revoked on password reset
 */
import 'server-only';

import crypto from 'node:crypto';
import argon2 from 'argon2';
import { eq, and } from 'drizzle-orm';
import { getSql } from '../db';
import type { Database } from '../db';
import { withSystemScope, withTenant } from '../db/tenant';
import { users, organizations, organizationMembers } from '../db/schema/tenancy';
import {
  sessions as sessionsTable,
  passwordCredentials,
  passwordResets,
} from '../db/schema/auth';
import {
  verifySessionCookie,
  signSessionCookie,
  generateSessionIds,
  hashSessionId,
  hashResetToken,
  generateUrlToken,
  signCsrfToken,
  verifyCsrfToken as verifyCsrfTokenInternal,
  normalizeEmail,
  sessionCookieOptions,
  csrfCookieOptions,
  verifyActiveOrgCookie,
} from './cookies';
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  ACTIVE_ORG_COOKIE_NAME,
  SESSION_TTL_MS,
  SESSION_ABSOLUTE_MAX_MS,
  PASSWORD_RESET_TTL_MS,
  ARGON2_OPTIONS,
  RATE_LIMITS,
} from './config';
import type { UUID, TenantCtx } from '../db/repo/_context';

// Re-exports for route handlers.
export { verifySessionCookie } from './cookies';
export { cookieStore };

type CookiesLike = {
  get(name: string): { value: string } | undefined;
  set(options: { name: string; value: string } & Record<string, unknown>): void;
  delete(name: string): void;
};

/** Cookie store used throughout the auth module. In production we read it from
 *  Next's `cookies()` async store; tests can inject a compatible store. */
let _injectedCookies: CookiesLike | null = null;

/** Inject a cookie store for testing (DO NOT use in production routes).
 *  Throws unconditionally if NODE_ENV === 'production' to prevent any
 *  production code path from swapping the cookie store. */
export function __setCookieStoreForTest(store: CookiesLike | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setCookieStoreForTest is disabled in production');
  }
  _injectedCookies = store;
}

async function cookieStore(): Promise<CookiesLike> {
  if (_injectedCookies) return _injectedCookies;
  const { cookies: nc } = await import('next/headers');
  return await nc();
}

/** Internal helper to read the raw session cookie value (used by CSRF checks
 *  that need the raw session id to HMAC-verify the CSRF token). Exposed only
 *  for route handlers within this codebase — do NOT call from client code. */
export async function getRawSessionCookieValue(): Promise<string | undefined> {
  const c = await cookieStore();
  return c.get(SESSION_COOKIE_NAME)?.value;
}

export interface AuthUser {
  id: UUID;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isPlatformAdmin: boolean;
}

export type AuthRole = 'OWNER' | 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF';

export interface AuthMembership {
  id: UUID;
  organizationId: UUID;
  role: AuthRole;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
}

export interface AuthSession {
  user: AuthUser;
  memberships: AuthMembership[];
  activeOrganizationId: UUID;
  /** Role of the ACTIVE resolved membership in the active organization. */
  activeRole: AuthRole;
  sessionId: UUID;
  /** True only when this session was created via enterPlatformSupport. */
  isPlatformSession: boolean;
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'AuthError';
  }
}

// ---------------------- Rate limit ----------------------

async function rateLimit(
  key: string,
  policy: { max: number; windowMs: number },
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const sql = getSql();
  const interval = `${Math.round(policy.windowMs)} milliseconds`;
  const rows = await sql<
    { allowed: boolean; remaining: number; retry_after_seconds: number }[]
  >`SELECT allowed, remaining, retry_after_seconds
       FROM auth_rate_limit_hit(${key}, ${policy.max}, ${interval}::interval)`;
  return {
    allowed: Boolean(rows[0]!.allowed),
    remaining: Number(rows[0]!.remaining),
    retryAfter: Number(rows[0]!.retry_after_seconds),
  };
}

// ---------------------- Context helpers ----------------------
//
// R1 (C-1): this module no longer writes authorization context at session
// scope. Every flow below runs inside a SCOPE (`withSystemScope` /
// `withTenant`, see lib/db/scope.ts), which
//
//   - applies pre-authentication SYSTEM context (bootstrap visibility over
//     identity tables only) or validated TENANT context with
//     transaction-local semantics on the connection that will run the
//     queries;
//   - makes Postgres itself revert that context at the end of the scope's
//     transaction;
//   - clears every identity-bearing variable on both layers and reads them
//     back to prove the connection is neutral, failing closed otherwise.
//
// Removing the old session-scoped `set_tenant_context(...)` / `auth_enter_
// system_context()` calls is what closes the pre-R1 window in which an
// identity established for one request stayed readable on the pooled
// connection for whoever used it next.

/**
 * Reset GUCs to neutral on the current connection.
 *
 * Kept for callers that already invoke it in a `finally` block; under R1 it is
 * belt-and-braces, because scope teardown has already cleared and verified the
 * same variables.
 */
export async function clearContext(): Promise<void> {
  const sql = getSql();
  await sql`SELECT clear_app_context()`.catch(() => {});
}

// ---------------------- Session read (the trust gate) ----------------------

/** Read session from request cookies. Returns null if unauthenticated. */
export async function getSession(cookiesInst?: CookiesLike): Promise<AuthSession | null> {
  const c = cookiesInst ?? await cookieStore();
  const raw = c.get(SESSION_COOKIE_NAME)?.value;
  const cookie = verifySessionCookie(raw);
  if (!cookie) return null;

  const tokenHashHex = hashSessionId(cookie.sessionId).toString('hex');

  // The trust gate runs in pre-authentication SYSTEM scope: bootstrap
  // visibility over identity tables (sessions, users, organization_members),
  // applied transaction-locally on the connection that performs these reads.
  // Nothing this scope establishes survives it.
  return withSystemScope(async (db) => {
  const rows = await db
    .select({ session: sessionsTable, user: users })
    .from(sessionsTable)
    .innerJoin(users, eq(users.id, sessionsTable.userId))
    .where(eq(sessionsTable.tokenHash, tokenHashHex as any))
    .limit(1);

  if (!rows.length) {
    return null;
  }
  const { session, user } = rows[0]!;

  if (session.revokedAt || !session.expiresAt || session.expiresAt.getTime() < Date.now()) {
    return null;
  }
  if (session.createdAt && Date.now() - session.createdAt.getTime() > SESSION_ABSOLUTE_MAX_MS) {
    return null;
  }

  // Load ACTIVE memberships.
  const memberships = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, user.id),
        eq(organizationMembers.status, 'ACTIVE'),
      ),
    );

  if (!memberships.length) {
    return null;
  }

  // Resolve active organization: signed sc_active_org cookie if the user has
  // an ACTIVE membership for it; else fall back to session.lastSeenOrgId; else
  // first ACTIVE membership. We never trust an unsigned client value.
  const cookieVal = c.get(ACTIVE_ORG_COOKIE_NAME)?.value;
  const requestedOrg = verifyActiveOrgCookie(cookieVal, user.id);
  let member: typeof memberships[number] | undefined;
  if (requestedOrg) {
    member = memberships.find((m) => m.organizationId === requestedOrg && m.status === 'ACTIVE');
  }
  if (!member && session.lastSeenOrgId) {
    member = memberships.find((m) => m.organizationId === session.lastSeenOrgId && m.status === 'ACTIVE');
  }
  if (!member) {
    member = memberships[0]!;
  }

  // Touch last_seen and last_seen_org_id. Awaited (errors still swallowed)
  // because it must happen inside this scope: an update left running outside
  // the scope's transaction could outlive the connection that ran the reads.
  await db
    .update(sessionsTable)
    .set({ lastSeenAt: new Date(), lastSeenOrgId: member.organizationId })
    .where(eq(sessionsTable.id, session.id))
    .catch(() => {});

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    memberships: memberships.map((m) => ({
      id: m.id as UUID,
      organizationId: m.organizationId,
      role: m.role as AuthRole,
      status: m.status as AuthMembership['status'],
    })),
    activeOrganizationId: member.organizationId,
    activeRole: member.role as AuthRole,
    sessionId: session.id,
    isPlatformSession: session.isPlatformSession ?? false,
  };
  });
}

/** Execute a handler with authenticated context; always clears GUCs. */
export async function withAuth<T>(
  fn: (session: AuthSession, ctx: TenantCtx) => Promise<T>,
  opts: { required: true },
): Promise<T>;
export async function withAuth<T>(
  fn: (session: AuthSession, ctx: TenantCtx) => Promise<T>,
  opts?: { required?: boolean },
): Promise<T | null>;
export async function withAuth<T>(
  fn: (session: AuthSession, ctx: TenantCtx) => Promise<T>,
  opts: { required?: boolean } = {},
): Promise<T | null> {
  const session = await getSession();
  if (!session) {
    if (opts.required) throw new AuthError('UNAUTHENTICATED', 'Authentication required', 401);
    return null;
  }
  const ctx: TenantCtx = {
    organizationId: session.activeOrganizationId,
    userId: session.user.id,
  };
  // Tenant context is established by the scope and reverted by Postgres when
  // the scope's transaction ends; the `finally { clearContext() }` dance is no
  // longer what provides the guarantee.
  return withTenant(
    { organizationId: session.activeOrganizationId, userId: session.user.id },
    async () => fn(session, ctx),
  );
}

// ---------------------- CSRF ----------------------

export async function requireCsrf(request: Request, rawSessionId: string): Promise<void> {
  const c = await cookieStore();
  const csrfCookieFull = c.get(CSRF_COOKIE_NAME)?.value;
  const csrfHeader = request.headers.get('x-csrf-token');
  if (!csrfCookieFull || !csrfHeader) {
    throw new AuthError('CSRF_MISSING', 'CSRF token missing', 403);
  }
  // csrf cookie format: <csrfToken>.<sig>
  const dot = csrfCookieFull.indexOf('.');
  if (dot < 0) throw new AuthError('CSRF_INVALID', 'CSRF token invalid', 403);
  const csrfToken = csrfCookieFull.slice(0, dot);
  if (!verifyCsrfTokenInternal(csrfHeader, csrfToken, rawSessionId)) {
    throw new AuthError('CSRF_INVALID', 'CSRF token invalid', 403);
  }
}

// ---------------------- Cookie writing ----------------------

async function writeSessionCookies(
  c: CookiesLike,
  rawSessionId: string,
  csrfToken: string,
  expiresAt: Date,
): Promise<void> {
  const signed = signSessionCookie({ sessionId: rawSessionId, expiresAt, csrfToken });
  const csrfSigned = `${csrfToken}.${signCsrfToken(csrfToken, rawSessionId)}`;
  c.set({
    ...sessionCookieOptions(expiresAt),
    name: SESSION_COOKIE_NAME,
    value: signed.sessionCookieValue,
  });
  c.set({
    ...csrfCookieOptions(expiresAt),
    name: CSRF_COOKIE_NAME,
    value: csrfSigned,
  });
}

function clearSessionCookies(c: CookiesLike): void {
  c.delete(SESSION_COOKIE_NAME);
  c.delete(CSRF_COOKIE_NAME);
  c.delete(ACTIVE_ORG_COOKIE_NAME);
}

// ---------------------- Session lifecycle ----------------------

async function insertSession(
  db: Database,
  userId: UUID,
  rawId: string,
  csrfToken: string,
  userAgent?: string | null,
  ip?: string | null,
): Promise<{ sessionId: UUID; expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const sessionId = crypto.randomUUID() as UUID;
  await db.insert(sessionsTable).values({
    id: sessionId,
    tokenHash: hashSessionId(rawId).toString('hex'),
    userId,
    csrfToken,
    userAgent: userAgent ?? null,
    ipAddress: ip ?? null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  } as any);
  return { sessionId, expiresAt };
}

async function createSessionForUser(
  userId: UUID,
  c: CookiesLike,
  meta?: { userAgent?: string | null; ip?: string | null },
): Promise<void> {
  // Session rows and the user's last_login_at are written in pre-auth SYSTEM
  // scope, transaction-locally, on one connection.
  await withSystemScope(async (db) => {
    const { rawId, csrfToken } = generateSessionIds();
    const { expiresAt } = await insertSession(
      db,
      userId,
      rawId,
      csrfToken,
      meta?.userAgent,
      meta?.ip,
    );
    // Note: insertSession already hashes rawId; the rawId here is the
    // plaintext to embed in the cookie only.
    await writeSessionCookies(c, rawId, csrfToken, expiresAt);

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  });
  // No tenant context is established here: callers either read the session
  // back through getSession() (which scopes its own reads) or run inside
  // withTenant().
}

/** Log out: revoke session in DB + clear cookies. */
export async function logout(): Promise<void> {
  const c = await cookieStore();
  const raw = c.get(SESSION_COOKIE_NAME)?.value;
  const parsed = verifySessionCookie(raw);
  if (parsed) {
    await withSystemScope(async (db) => {
      await db
        .update(sessionsTable)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(
          eq(
            sessionsTable.tokenHash,
            hashSessionId(parsed.sessionId).toString('hex') as any,
          ),
        );
    });
  }
  clearSessionCookies(c);
}

// ---------------------- Registration ----------------------

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
  organizationSlug: string;
}

export async function register(
  input: RegisterInput,
  meta?: { ip?: string; userAgent?: string },
): Promise<{ userId: UUID; organizationId: UUID }> {
  const email = normalizeEmail(input.email);
  const rl = await rateLimit(`register:ip:${meta?.ip ?? 'unknown'}`, RATE_LIMITS.register);
  if (!rl.allowed)
    throw new AuthError(
      'RATE_LIMITED',
      `Too many registrations. Retry in ${rl.retryAfter}s.`,
      429,
    );

  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
  const userId = crypto.randomUUID() as UUID;
  const orgId = crypto.randomUUID() as UUID;
  const now = new Date();

  await withSystemScope(async (db) => {
  try {
    await db.insert(users).values({
      id: userId,
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      createdAt: now,
      updatedAt: now,
    } as any);
    await db.insert(organizations).values({
      id: orgId,
      name: input.organizationName,
      slug: input.organizationSlug,
      createdAt: now,
      updatedAt: now,
    } as any);
    await db.insert(organizationMembers).values({
      organizationId: orgId,
      userId,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);
    await db.insert(passwordCredentials).values({
      userId,
      algorithm: 'argon2id',
      params: ARGON2_OPTIONS as unknown as Record<string, unknown>,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    } as any);
  } catch (e: any) {
    if (e?.code === '23505') {
      const msg: string = e?.message ?? '';
      if (msg.includes('email'))
        throw new AuthError(
          'EMAIL_TAKEN',
          'An account with this email already exists.',
          409,
        );
      if (msg.includes('slug'))
        throw new AuthError('SLUG_TAKEN', 'School slug already taken.', 409);
    }
    throw e;
  }
  });

  // Auto-login after registration.
  const c = await cookieStore();
  await createSessionForUser(userId, c, {
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  return { userId, organizationId: orgId };
}

// ---------------------- Login ----------------------

export async function login(input: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const c = await cookieStore();

  const emailKey = `login:email:${email}`;
  const ipKey = `login:ip:${input.ip ?? 'unknown'}`;
  const [rlEmail, rlIp] = await Promise.all([
    rateLimit(emailKey, RATE_LIMITS.login),
    rateLimit(ipKey, RATE_LIMITS.login),
  ]);
  if (!rlEmail.allowed)
    throw new AuthError(
      'RATE_LIMITED',
      `Too many login attempts. Retry in ${rlEmail.retryAfter}s.`,
      429,
    );
  if (!rlIp.allowed)
    throw new AuthError(
      'RATE_LIMITED',
      `Too many login attempts. Retry in ${rlIp.retryAfter}s.`,
      429,
    );

  // Credential verification, login-attempt accounting and session creation all
  // happen inside one SYSTEM scope, on one connection, transaction-locally.
  await withSystemScope(async (db) => {
  const sql = getSql();

  const row = await db
    .select({ user: users, cred: passwordCredentials })
    .from(users)
    .innerJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);

  let ok = false;
  let userId: UUID | null = null;
  if (row[0]) {
    userId = row[0].user.id;
    try {
      ok = await argon2.verify(row[0].cred.passwordHash, input.password);
    } catch {
      ok = false;
    }
  } else {
    const dummyHash = await argon2.hash('timing-dummy-placeholder', ARGON2_OPTIONS);
    await argon2.verify(dummyHash, 'timing-dummy-wrong').catch(() => {});
  }

  await sql`SELECT auth_record_login_attempt(${email}, ${input.ip ?? null}, ${ok})`.catch(() => {});

  if (!ok) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
  }

  await createSessionForUser(userId!, c, {
    ip: input.ip,
    userAgent: input.userAgent,
  });
  });
}

// ---------------------- Password reset ----------------------

export async function requestPasswordReset(
  email: string,
  meta?: { ip?: string; userAgent?: string },
): Promise<{ token: string | null; userId: UUID | null }> {
  const emailNorm = normalizeEmail(email);
  const rl = await rateLimit(`reset:email:${emailNorm}`, RATE_LIMITS.resetRequest);
  if (!rl.allowed)
    throw new AuthError('RATE_LIMITED', 'Too many reset requests.', 429);

  return withSystemScope(async (db) => {
  const row = await db
    .select()
    .from(users)
    .where(eq(users.email, emailNorm))
    .limit(1);

  if (!row[0]) {
    // Do NOT reveal whether email exists; return a dummy structure.
    return { token: null, userId: null };
  }

  const token = generateUrlToken(32);
  const tokenHash = hashResetToken(token);
  await db.insert(passwordResets).values({
    userId: row[0].id,
    tokenHash,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    requestIp: meta?.ip ?? null,
    requestUserAgent: meta?.userAgent ?? null,
  });

  return { token, userId: row[0].id };
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashResetToken(token);
  const rl = await rateLimit(
    `reset-consume:${tokenHash.slice(0, 16)}`,
    RATE_LIMITS.resetConsume,
  );
  if (!rl.allowed)
    throw new AuthError('RATE_LIMITED', 'Too many reset attempts.', 429);

  await withSystemScope(async (db) => {
  const sql = getSql();

  // SELECT ... FOR UPDATE via raw SQL (prevents double-consume races).
  const rows = await sql<any[]>`
    SELECT id, user_id, expires_at, consumed_at
      FROM password_resets
     WHERE token_hash = ${tokenHash}
     FOR UPDATE`;

  if (!rows[0] || rows[0].consumed_at) {
    throw new AuthError(
      'RESET_INVALID',
      'Reset token is invalid or already used.',
      400,
    );
  }
  const expiresAt = new Date(rows[0].expires_at);
  if (expiresAt.getTime() < Date.now()) {
    throw new AuthError('RESET_EXPIRED', 'Reset token has expired.', 400);
  }
  const resetUserId: UUID = rows[0].user_id;
  const resetId: UUID = rows[0].id;

  const newHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
  await db
    .update(passwordCredentials)
    .set({ passwordHash: newHash, updatedAt: new Date() } as any)
    .where(eq(passwordCredentials.userId, resetUserId));
  await sql`UPDATE password_resets SET consumed_at = now() WHERE id = ${resetId}::uuid`;
  // Revoke all sessions (password reset = security event).
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date(), revokedReason: 'password_reset' })
    .where(eq(sessionsTable.userId, resetUserId));
  });
}

// ---------------------- Authenticated account actions ----------------------

export async function changePassword(
  session: AuthSession,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return withTenant(
    { organizationId: session.activeOrganizationId, userId: session.user.id },
    async (db) => {
  const cred = await db
    .select()
    .from(passwordCredentials)
    .where(eq(passwordCredentials.userId, session.user.id))
    .limit(1);
  if (!cred[0]) throw new AuthError('NO_CREDENTIAL', 'No password credential on file.', 400);
  const ok = await argon2.verify(cred[0].passwordHash, currentPassword);
  if (!ok) {
    throw new AuthError('INVALID_PASSWORD', 'Current password is incorrect.', 401);
  }
  const newHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
  await db
    .update(passwordCredentials)
    .set({ passwordHash: newHash, updatedAt: new Date() } as any)
    .where(eq(passwordCredentials.userId, session.user.id));
  // Revoke other sessions (keep current).
  const sql = getSql();
  await sql`
    UPDATE sessions
       SET revoked_at = now(), revoked_reason = 'password_change'
     WHERE user_id = ${session.user.id}::uuid
       AND id <> ${session.sessionId}::uuid
  `;
    },
  );
}

/** Switch active organization. Validates membership before switching. */
export async function switchOrganization(
  session: AuthSession,
  targetOrgId: UUID,
): Promise<AuthSession> {
  const member = session.memberships.find(
    (m) => m.organizationId === targetOrgId && m.status === 'ACTIVE',
  );
  if (!member) {
    throw new AuthError('NOT_MEMBER', 'You are not a member of that organization.', 403);
  }
  const c = await cookieStore();
  const exp = new Date(Date.now() + SESSION_TTL_MS);
  c.set({
    name: 'sc_org',
    value: targetOrgId,
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: exp,
  });
  // No context is established here: the refreshed session read below runs in
  // its own SYSTEM scope, and request handlers establish tenant scope through
  // withTenant()/withAuthorizedRoute().
  // Re-read session to get fresh membership/active org.
  const refreshed = await getSession(c);
  if (!refreshed) throw new AuthError('SESSION_LOST', 'Session invalid after switch', 401);
  return refreshed;
}
