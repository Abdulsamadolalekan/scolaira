/**
 * Cookie / signed-token utilities.
 *
 * The session cookie contains: <sessionId>.<expiresAtSeconds>.<hmac>
 *   - sessionId: 32-byte crypto-random value (url-safe base64url, 43 chars).
 *   - expiresAtSeconds: decimal unix-seconds at which this cookie's claim
 *     expires (outer bound before DB lookup).
 *   - hmac: HMAC-SHA256(SESSION_SECRET, "scolaira.session\0" + data) in base64url.
 *
 * The DB stores sha256(sessionId), never the raw id. If the cookie is
 * stolen, an attacker can impersonate — that's the nature of bearer tokens —
 * but the HMAC prevents forgery without the server secret, and the DB
 * hash-at-rest prevents replay from a DB dump.
 *
 * The cookie is HttpOnly + Secure (in production) + SameSite=Lax + Path=/ .
 * CSRF for state-changing requests uses a separate readable cookie + a header.
 */
import 'server-only';
import crypto from 'node:crypto';
import { SESSION_SECRETS, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, COOKIE_PATH, IS_PRODUCTION, COOKIE_SAMESITE } from './config';
import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';

const SESSION_PREFIX = Buffer.from('scolaira.session\0', 'utf-8');
const CSRF_PREFIX = Buffer.from('scolaira.csrf\0', 'utf-8');

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signWithPrimary(payload: Buffer): Buffer {
  const key = SESSION_SECRETS[0];
  if (!key) throw new Error('Auth misconfiguration: no SESSION_SECRET set');
  return crypto.createHmac('sha256', key as crypto.BinaryLike).update(payload).digest();
}

function verifyHmac(payload: Buffer, expected: Buffer): boolean {
  for (const key of SESSION_SECRETS) {
    const sig = crypto.createHmac('sha256', key as crypto.BinaryLike).update(payload).digest();
    if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

export interface SessionCookiePayload {
  sessionId: string;    // raw session id (32-byte value, base64url) — send to DB to hash
  expiresAt: Date;      // outer expiry claim
  csrfToken: string;    // base64url CSRF token
}

/** Generate a fresh 32-byte session id. Returns { rawId, dbHash, csrfToken }. */
export function generateSessionIds(): { rawId: string; dbHash: Buffer; csrfToken: string } {
  const raw = crypto.randomBytes(32);
  const csrf = crypto.randomBytes(32);
  const rawId = base64url(raw);
  const dbHash = crypto.createHash('sha256').update(raw).digest();
  return { rawId, dbHash, csrfToken: base64url(csrf) };
}

/** Produce a signed cookie value + CSRF value for Set-Cookie. */
export function signSessionCookie(p: SessionCookiePayload): { sessionCookieValue: string; csrfCookieValue: string } {
  const expSec = Math.floor(p.expiresAt.getTime() / 1000).toString();
  const data = Buffer.from(`${p.sessionId}.${expSec}`, 'utf-8');
  const payload = Buffer.concat([SESSION_PREFIX, data]);
  const sig = signWithPrimary(payload);
  return {
    sessionCookieValue: `${p.sessionId}.${expSec}.${base64url(sig)}`,
    csrfCookieValue: p.csrfToken,
  };
}

/** Verify and parse a session cookie value. Returns null on invalid/forged/expired. */
export function verifySessionCookie(value: string | undefined): { sessionId: string; expiresAt: Date } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const sessionId = parts[0];
  const expSecStr = parts[1];
  const sigB64 = parts[2];
  if (!sessionId || !expSecStr || !sigB64) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
  const expSec = parseInt(expSecStr, 10);
  if (!Number.isFinite(expSec) || expSec <= 0) return null;
  let sig: Buffer;
  try { sig = unbase64url(sigB64); } catch { return null; }
  if (sig.length !== 32) return null;
  const data = Buffer.from(`${sessionId}.${expSec}`, 'utf-8');
  const payload = Buffer.concat([SESSION_PREFIX, data]);
  if (!verifyHmac(payload, sig)) return null;
  const expiresAt = new Date(expSec * 1000);
  if (expiresAt.getTime() < Date.now()) return null;
  return { sessionId, expiresAt };
}

/** CSRF double-submit: HMAC the session id with a separate prefix so CSRF can be
 *  verified without DB lookups, but only when presented with a matching cookie. */
export function signCsrfToken(csrfToken: string, sessionId: string): string {
  const payload = Buffer.concat([CSRF_PREFIX, Buffer.from(sessionId + '.' + csrfToken, 'utf-8')]);
  return base64url(signWithPrimary(payload));
}

export function verifyCsrfToken(headerToken: string | null | undefined, cookieCsrf: string | null | undefined, sessionId: string): boolean {
  if (!headerToken || !cookieCsrf) return false;
  if (headerToken.length < 40 || cookieCsrf.length !== 43) return false;
  // headerToken = <csrfValue>.<sig>
  const dot = headerToken.lastIndexOf('.');
  if (dot < 0) return false;
  const val = headerToken.slice(0, dot);
  if (val !== cookieCsrf) return false;
  let sig: Buffer;
  try { sig = unbase64url(headerToken.slice(dot + 1)); } catch { return false; }
  if (sig.length !== 32) return false;
  const payload = Buffer.concat([CSRF_PREFIX, Buffer.from(sessionId + '.' + val, 'utf-8')]);
  return verifyHmac(payload, sig);
}

/** Build cookie options for Set-Cookie. (We use a helper rather than raw
 *  ResponseCookie to keep surface area explicit.) */
export function sessionCookieOptions(expiresAt: Date): ResponseCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: '', // set by caller
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: COOKIE_SAMESITE,
    path: COOKIE_PATH,
    expires: expiresAt,
  };
}

export function csrfCookieOptions(expiresAt: Date): ResponseCookie {
  return {
    name: CSRF_COOKIE_NAME,
    value: '',
    httpOnly: false, // readable by JS for double-submit
    secure: IS_PRODUCTION,
    sameSite: COOKIE_SAMESITE,
    path: COOKIE_PATH,
    expires: expiresAt,
  };
}

/** Normalize email (trim + lowercase + NFKC) for lookups/uniqueness. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase().normalize('NFKC');
}

/** Hash a raw session id for DB lookup / storage. */
export function hashSessionId(rawId: string): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(rawId, 'utf-8')).digest();
}

/** Hash a reset token for DB storage. */
export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(Buffer.from(token, 'utf-8')).digest('hex');
}

/** Generate a cryptographically random URL-safe token (for reset/session). */
export function generateUrlToken(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

export const __test = { base64url, unbase64url }; // exported only for test harness
