/**
 * H-8 — platform support mode.
 *
 * WHAT SUPPORT MODE IS
 *
 * A platform administrator may look inside a single organization to help its
 * users. Looking is all that support mode can do: it is a *read window*, not an
 * elevated tenant session.
 *
 * TWO INDEPENDENT GATES
 *
 *   1. Identity (this file + lib/platform/route.ts). The support cookie is an
 *      HMAC-signed claim `<orgId>.<nonce>.<expiresAtSec>.<sig>` bound to the
 *      authenticated user id, signed with the session secret under its own
 *      domain prefix (`scolaira.support\0`). The domain prefix means a support
 *      cookie can never be replayed as a session cookie or an active-org cookie
 *      and vice versa. A forged cookie fails signature verification, and a
 *      support cookie copied to another account fails the user-id binding.
 *
 *   2. Database authorization (frozen M4/M6 layer, unchanged). Every platform
 *      read runs through `withPlatformContext()`, i.e. `auth_scope_platform_local`,
 *      which mints `app.platform_token` from the database for that backend. The
 *      cookie above confers no database power at all: a support cookie held by a
 *      user who is not in fact a platform administrator reads nothing, because
 *      `auth_is_platform_admin_authorized()` refuses the context.
 *
 * WHY THE COOKIE IS NOT THE READ-ONLY GATE
 *
 * Platform context is deliberately read-write at the RLS layer (the platform
 * branch of `organizations_tenant_isolation` is FOR ALL). Read-only is therefore
 * enforced where it can be tested and cannot be bypassed: the capability gate in
 * `withPlatformRoute`, which refuses every capability that is not a read while a
 * support cookie is present, and the absence of any mutation route under
 * `/api/platform/*`. The H-8 boundary test proves both, including a direct call
 * through the real wrapper with a mutating capability.
 *
 * AUDIT EVIDENCE IS REQUIRED, NOT BEST EFFORT
 *
 * Every entry writes a `platform.support.enter` row into the target
 * organization's audit trail *before* the cookie is issued, and every exit
 * writes `platform.support.exit`. Unlike `writeAudit()` (which logs and
 * continues), a failed support-audit write aborts the entry: support mode
 * without evidence does not exist. The failure path is proven in
 * tests/auth/h8-platform-boundary.test.ts by injecting a failing writer.
 */
import 'server-only';

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { cookieStore } from '@/lib/auth';
import { SESSION_SECRETS, COOKIE_PATH, COOKIE_SAMESITE, IS_PRODUCTION } from '@/lib/auth/config';
import { withPlatformContext } from '@/lib/db/tenant';
import { auditEvents } from '@/lib/db/schema/platform';
import { organizations } from '@/lib/db/schema/tenancy';
import type { UUID } from '@/lib/db/repo/_context';

export const SUPPORT_COOKIE_NAME = 'sc_support';

/** A support window is short-lived by design; re-entry is cheap and audited. */
export const SUPPORT_TTL_MS = 30 * 60 * 1000;

/**
 * Domain separation. A support cookie signed under a different prefix than the
 * session / active-org cookies cannot be interpreted as one of those, even
 * though all three use the same secret material.
 */
const SUPPORT_PREFIX = Buffer.from('scolaira.support\0', 'utf-8');

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payload: Buffer): Buffer {
  const key = SESSION_SECRETS[0];
  if (!key) throw new Error('Platform misconfiguration: no SESSION_SECRET set');
  return crypto
    .createHmac('sha256', key as crypto.BinaryLike)
    .update(payload)
    .digest();
}

function verify(payload: Buffer, expected: Buffer): boolean {
  for (const key of SESSION_SECRETS) {
    const sig = crypto
      .createHmac('sha256', key as crypto.BinaryLike)
      .update(payload)
      .digest();
    if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

export interface SupportClaim {
  organizationId: UUID;
  nonce: string;
  expiresAt: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sign a support claim. `nonce` correlates the cookie with its audit rows. */
export function signSupportCookie(claim: SupportClaim, userId: UUID): string {
  const expiresAtSec = Math.floor(claim.expiresAt.getTime() / 1000);
  const data = `${claim.organizationId}.${claim.nonce}.${expiresAtSec}.${userId}`;
  const sig = sign(Buffer.concat([SUPPORT_PREFIX, Buffer.from(data, 'utf-8')]));
  return `${claim.organizationId}.${claim.nonce}.${expiresAtSec}.${base64url(sig)}`;
}

/**
 * Verify a support cookie against the *authenticated* user id and the clock.
 * Returns the claim, or null for anything malformed, mis-signed, expired, or
 * bound to a different user.
 */
export function verifySupportCookie(
  value: string | undefined | null,
  userId: UUID,
  now: Date = new Date(),
): SupportClaim | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const organizationId = parts[0] ?? '';
  const nonce = parts[1] ?? '';
  const expiresAtRaw = parts[2] ?? '';
  const sigB64 = parts[3] ?? '';
  if (!UUID_RE.test(organizationId)) return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return null;
  const expiresAtSec = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAtSec) || expiresAtSec <= 0) return null;
  if (expiresAtSec * 1000 <= now.getTime()) return null;
  let sig: Buffer;
  try {
    sig = unbase64url(sigB64);
  } catch {
    return null;
  }
  if (sig.length !== 32) return null;
  const data = `${organizationId}.${nonce}.${expiresAtRaw}.${userId}`;
  if (!verify(Buffer.concat([SUPPORT_PREFIX, Buffer.from(data, 'utf-8')]), sig)) return null;
  return { organizationId, nonce, expiresAt: new Date(expiresAtSec * 1000) };
}

export interface SupportCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge: number;
  expires: Date;
}

export function supportCookieOptions(expiresAt: Date): SupportCookieOptions {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: COOKIE_SAMESITE,
    path: COOKIE_PATH,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    expires: expiresAt,
  };
}

/**
 * Read and verify the support claim for the current request, if any.
 *
 * Goes through the auth module's cookie-store abstraction rather than
 * `next/headers` directly, so a server component, a route handler and the test
 * harness all read exactly the same store (the same reason
 * `/api/auth/select-organization` does it this way).
 */
export async function readSupportClaim(userId: UUID, now?: Date): Promise<SupportClaim | null> {
  const store = await cookieStore();
  return verifySupportCookie(store.get(SUPPORT_COOKIE_NAME)?.value, userId, now);
}

// ---------------------------------------------------------------------------
// Audit evidence
// ---------------------------------------------------------------------------

export type SupportAuditAction = 'platform.support.enter' | 'platform.support.exit';

/**
 * Write one immutable support-audit row for `organizationId`.
 *
 * Runs in platform context (the only context that may address an arbitrary
 * organization) and deliberately **propagates** failures: the caller must treat
 * "no evidence" as "no support mode".
 */
export async function recordSupportAudit(
  actorUserId: UUID,
  organizationId: UUID,
  action: SupportAuditAction,
  meta: { nonce: string; reason?: string | null; target?: string | null } = { nonce: '' },
): Promise<void> {
  await withPlatformContext(actorUserId, async (db) => {
    await db.insert(auditEvents).values({
      organizationId,
      actorType: 'USER',
      actorUserId,
      action,
      entityType: 'organization',
      entityId: organizationId,
      reason: meta.reason ?? null,
      metadata: {
        supportNonce: meta.nonce,
        target: meta.target ?? null,
        mode: 'READ_ONLY',
      },
      createdAt: new Date(),
    } as unknown as typeof auditEvents.$inferInsert);
  });
}

// ---------------------------------------------------------------------------
// Entry / exit
// ---------------------------------------------------------------------------

export interface SupportOrgSummary {
  id: UUID;
  name: string;
  status: string;
}

/** The organization a support claim points at, read in platform context. */
export async function loadSupportOrg(
  actorUserId: UUID,
  organizationId: UUID,
): Promise<SupportOrgSummary | null> {
  return withPlatformContext(actorUserId, async (db) => {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface SupportEntry extends SupportClaim {
  organization: SupportOrgSummary;
  signedValue: string;
}

export interface EnterSupportOptions {
  /** Test seam: proves that a failed audit write aborts the entry. */
  audit?: typeof recordSupportAudit;
  now?: Date;
}

/**
 * Enter support mode for `organizationId`.
 *
 * Order matters: the organization must exist (404), the audit row is written,
 * and only then is the signed claim produced. A caller that never receives the
 * value is not in support mode, so the audit row can never be orphaned from a
 * usable session, and a usable session can never exist without an audit row.
 */
export async function enterSupportMode(
  actorUserId: UUID,
  organizationId: UUID,
  options: EnterSupportOptions & { reason?: string | null } = {},
): Promise<SupportEntry | null> {
  const audit = options.audit ?? recordSupportAudit;
  const org = await loadSupportOrg(actorUserId, organizationId);
  if (!org) return null;

  const nonce = base64url(crypto.randomBytes(16));
  const expiresAt = new Date((options.now ?? new Date()).getTime() + SUPPORT_TTL_MS);

  await audit(actorUserId, organizationId, 'platform.support.enter', {
    nonce,
    reason: options.reason ?? null,
  });

  return {
    organizationId,
    nonce,
    expiresAt,
    organization: org,
    signedValue: signSupportCookie({ organizationId, nonce, expiresAt }, actorUserId),
  };
}

export interface ExitSupportOptions {
  audit?: typeof recordSupportAudit;
}

/**
 * Leave support mode. The exit row is written before the cookie is cleared; if
 * evidence cannot be written the caller keeps the (still read-only) claim rather
 * than losing the trail.
 */
export async function exitSupportMode(
  actorUserId: UUID,
  claim: SupportClaim,
  options: ExitSupportOptions = {},
): Promise<void> {
  const audit = options.audit ?? recordSupportAudit;
  await audit(actorUserId, claim.organizationId, 'platform.support.exit', {
    nonce: claim.nonce,
  });
}

// ---------------------------------------------------------------------------
// Read plane
// ---------------------------------------------------------------------------

export interface SupportOrgDetail extends SupportOrgSummary {
  memberCount: number;
  studentCount: number;
  lastAuditAt: Date | null;
}

/**
 * Read the support surface for `organizationId`. Only ever called from
 * `withPlatformRoute` with a READ capability, so a support session cannot reach
 * a mutation through this plane.
 */
export async function loadSupportOrgDetail(
  actorUserId: UUID,
  organizationId: UUID,
): Promise<SupportOrgDetail | null> {
  return withPlatformContext(actorUserId, async (db) => {
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const org = orgRows[0];
    if (!org) return null;

    const counts = (await db.execute(sql`
      select
        (select count(*) from organization_members where organization_id = ${organizationId}) as members,
        (select count(*) from students where organization_id = ${organizationId}) as students
    `)) as unknown as Array<{ members: number; students: number }>;
    const row = counts[0];

    const auditRows = await db
      .select({ createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId))
      .orderBy(auditEvents.createdAt)
      .limit(1);

    return {
      ...org,
      memberCount: Number(row?.members ?? 0),
      studentCount: Number(row?.students ?? 0),
      lastAuditAt: auditRows[0]?.createdAt ?? null,
    };
  });
}

/** List organizations visible to a platform administrator (platform context). */
export async function listPlatformOrgs(actorUserId: UUID): Promise<SupportOrgSummary[]> {
  return withPlatformContext(actorUserId, async (db) => {
    return db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .orderBy(organizations.name);
  });
}

/**
 * True when this user holds an *active* membership in `organizationId`.
 *
 * A platform administrator normally belongs to exactly one organization. That
 * membership is what the ordinary tenant routes resolve; support mode is the
 * deliberate exception and is the only path that reaches another tenant.
 */
export async function hasActiveMembership(
  actorUserId: UUID,
  organizationId: UUID,
): Promise<boolean> {
  return withPlatformContext(actorUserId, async (db) => {
    const rows = (await db.execute(sql`
      select exists (
        select 1 from organization_members
         where organization_id = ${organizationId}
           and user_id = ${actorUserId}
           and status = 'ACTIVE'
      ) as present
    `)) as unknown as Array<{ present: boolean }>;
    return Boolean(rows[0]?.present);
  });
}

/** Guard used by the support plane: the target must not be the viewer's own tenant. */
export async function assertNotOwnTenant(
  actorUserId: UUID,
  organizationId: UUID,
): Promise<boolean> {
  return !(await hasActiveMembership(actorUserId, organizationId));
}
