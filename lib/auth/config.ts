/**
 * Authentication configuration (server-only).
 *
 * Single source of truth for session/cookie/security constants.
 * Every value has a documented rationale in docs/auth/AUTHENTICATION_ARCHITECTURE.md.
 */
import 'server-only';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 32) {
    throw new Error(
      `Auth misconfiguration: ${name} must be set to at least 32 bytes. ` +
        `Generate with: openssl rand -base64 48`,
    );
  }
  return v;
}

/**
 * Session secret(s) for HMAC-SHA256 signing of the session cookie.
 * The ACTIVE secret is the first entry (used to sign new cookies). Subsequent
 * entries are "previous" secrets accepted during verification to enable
 * zero-downtime key rotation.
 */
export const SESSION_SECRETS: Buffer[] = (() => {
  const primary = requireEnv('SCOLAIRA_SESSION_SECRET');
  // Optional additional secrets for rotation, separated by commas.
  const extra = (process.env.SCOLAIRA_SESSION_SECRET_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...extra].map((s) => Buffer.from(s, 'utf-8'));
})();

/** Cookie name for the session id. */
export const SESSION_COOKIE_NAME = 'sc_session';

/** Cookie name for CSRF double-submit token. */
export const CSRF_COOKIE_NAME = 'sc_csrf';

/**
 * Cookie name for the active-organization selection.
 *
 * This cookie is SIGNED (HMAC-SHA256) with the session secret so it cannot be
 * forged to switch the user into an org they don't belong to, but it is NOT
 * HttpOnly (we set it from JS when the user switches orgs). The server
 * re-validates membership on every request regardless of what this cookie
 * says — it is a preference, not an authority source.
 */
export const ACTIVE_ORG_COOKIE_NAME = 'sc_org';

/** Session lifetime: 12 hours since last_seen (sliding). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Hard session upper bound: 30 days since creation, regardless of activity. */
export const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Password reset token lifetime: 1 hour. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Argon2id parameters — OWASP 2024 recommended minimum for Argon2id. */
export const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Rate-limit windows. */
export const RATE_LIMITS = {
  login: { max: 10, windowMs: 15 * 60 * 1000 },     // 10 attempts / 15 min per key
  register: { max: 5, windowMs: 60 * 60 * 1000 },    // 5 registrations / hour per key
  resetRequest: { max: 3, windowMs: 15 * 60 * 1000 },
  resetConsume: { max: 5, windowMs: 15 * 60 * 1000 },
} as const;

/** Is this a production deployment (controls Secure cookie attribute)? */
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Canonical app URL for cookie domain/Path (always /). */
export const COOKIE_PATH = '/';

/** SameSite policy. Strict would break cross-flow; Lax gives us CSRF resistance
 *  for unsafe methods (we also layer CSRF token on mutations). */
export const COOKIE_SAMESITE: 'strict' | 'lax' | 'none' = 'lax';
