# SCOLAIRA Authentication Architecture (M3)

> M2 established financial truth. M3 establishes identity truth.
> A financial system cannot be trusted if it does not know who is touching it.

This document describes the authentication, session, and identity-trust design
implemented in M3. It is written for engineers who will maintain, audit, or
extend the system — not as a marketing document.

---

## 1. Principles

1. **One source of truth.** Users, `organization_members`, `withTenant()`,
   and RLS from M2 remain the identity/tenant boundary. M3 does not introduce
   a second user table, a parallel session store, or another membership model.
2. **Server-only trust boundary.** Every decision about identity, membership,
   and tenant context is made server-side in Node.js. The client never tells
   the server who the user is or which organization they belong to.
3. **No production-weakening for tests.** No magic headers, no dev bypasses,
   no hardcoded admins, no localStorage identity flags. Tests exercise the
   same code path production uses (cookies + HMAC + Postgres lookups).
4. **Mature cryptography.** argon2id for passwords (OWASP 2024 params),
   SHA-256 for credential-at-rest hashing, HMAC-SHA256 for cookie integrity,
   CSPRNG for all tokens. We do not invent crypto.
5. **Credentials at rest are hashed.** The database stores only sha256(session id)
   and argon2id(password). Raw session ids, reset tokens, and passwords never
   touch persistent storage.
6. **Generic failures.** Login and reset endpoints do not distinguish between
   "unknown email" and "wrong password" in their response. Timing is equalized
   with a dummy argon2 verification for unknown emails.
7. **Defense in depth.** CSRF double-submit tokens, HttpOnly/Secure/SameSite
   cookies, rate limits, row-level security, session expiry, and per-request
   GUC clearing all combine so a single failure does not compromise the trust
   boundary.

---

## 2. Identity Chain

Every authenticated request follows this exact chain:

```
REQUEST
  ↓
read signed HttpOnly session cookie (HMAC-SHA256 verification)
  ↓
sha256(raw session id) → SELECT sessions JOIN users
  ↓
verify not revoked / not expired / within absolute max age
  ↓
load ACTIVE organization_members for the user
  ↓
resolve active organization (sc_org cookie validated against memberships)
  ↓
SET app.organization_id / app.user_id / app.is_platform_admin GUCs
   via set_tenant_context() — re-verifies membership in PL/pgSQL (M2)
  ↓
return AuthSession { user, memberships, activeOrganizationId, sessionId }
  ↓
handler executes authorized operation (passing TenantCtx to repos)
  ↓
clearContext() resets GUCs in finally
```

Key invariants:

- A **client-supplied organization ID is never trusted**. The `sc_org` cookie
  is only accepted if the authenticated user has an ACTIVE membership for that
  organization; otherwise the server falls back to the first active membership.
- A **client-supplied role is never trusted**. Roles are read from
  `organization_members`; they are not read from headers, cookies, or JWTs.
- **Tenant context is set exactly once** per request, through
  `set_tenant_context()`, which is the same PL/pgSQL function M2 introduced.
  That function also re-verifies membership server-side, providing a
  second-line defense against application bugs.
- GUCs are **cleared in a `finally` block** so a crashed/aborted request
  cannot leak tenant context into a subsequent request on a pooled connection.

---

## 3. Components

| Path                                          | Purpose |
|-----------------------------------------------|---------|
| `lib/auth/config.ts`                          | Single source of constants: session TTL, argon2 params, rate limits, cookie flags. Reads `SCOLAIRA_SESSION_SECRET` (min 32 bytes). |
| `lib/auth/cookies.ts`                         | HMAC-SHA256 cookie signing/verification, base64url codec, CSRF token signing, email normalization, sha256 hashing helpers. |
| `lib/auth/index.ts`                           | **Authoritative module.** `getSession()`, `withAuth()`, `register()`, `login()`, `logout()`, `requestPasswordReset()`, `resetPassword()`, `changePassword()`, `requireCsrf()`, `switchOrganization()`, `clearContext()`. |
| `lib/db/migrations/0003_auth.sql`             | Schema: `password_credentials`, `password_resets`, hardened `sessions`, `rate_limits`, `login_attempts`; RLS policies; SECURITY DEFINER `auth_rate_limit_hit()`; grants to `scolaira_app`. |
| `lib/db/schema/auth.ts`                       | Drizzle schema matching the migration exactly. |
| `app/api/auth/*/route.ts`                     | Public HTTP endpoints for register/login/logout/reset/me/change-password. |
| `middleware.ts`                                | Edge coarse routing: cookie-presence redirect for protected pages / 401 for protected APIs. NOT the trust boundary. |
| `app/(auth)/*`                                 | Login / register / reset UI pages (Deep Forest/Gold/Ivory). |
| `tests/auth/auth.test.ts`                     | Red-team tests (19 security assertions). |

---

## 4. Passwords

- **Algorithm:** argon2id.
- **Parameters** (OWASP 2024 recommended minimum):
  - `m = 19 MiB` (`memoryCost: 19456`)
  - `t = 2` iterations
  - `p = 1` parallelism
- **Storage:** PHC-encoded string in `password_credentials.password_hash`.
  The column `algorithm` records the algorithm; `params` (jsonb) records the
  parameters so we can transparently rotate to stronger params on next login.
- **Never stored/logged/returned:** plaintext passwords, password hashes,
  candidate passwords, or password strength markers in audit or logs.
- **Verification:** done in Node with the `argon2` npm package. The DB role
  does have SELECT on `password_hash` (necessary because we run as the schema
  owner in this deployment); the SECURITY DEFINER `auth_verify_password()`
  function is present as a defense-in-depth for future role-segmented deploys.

### Account enumeration resistance

For an unknown email, `login()` performs a dummy `argon2.hash(...)+argon2.verify(...)`
against a synthetic hash so the response time is comparable to a known-email,
wrong-password attempt. The API always returns HTTP 401 with the identical
error code `INVALID_CREDENTIALS` and identical message `"Invalid email or password."`.
`requestPasswordReset()` returns HTTP 200 with `{ ok: true }` whether or not
the email exists; only when the email is found is a token created.
The development/preview environment echoes the reset token in the response so
end-to-end testing can complete without email; **production must not do this**
(see §10 Limitations).

---

## 5. Sessions

Sessions are credentials. They are treated with the same care as passwords.

### Identifier

- **Raw session id:** 32 bytes of CSPRNG (`crypto.randomBytes(32)`), encoded as
  43 characters of url-safe base64url. This value is exposed exactly once —
  inside the `Set-Cookie` header at session creation — and never persisted.
- **At rest:** `sha256(raw session id)` is stored as 64 hex characters in
  `sessions.token_hash`. A database compromise yields only hashed tokens,
  which are useless to an attacker without brute-forcing the 256-bit space.

### Lifetime

- **Sliding inactivity TTL:** 12 hours since `last_seen_at`.
- **Absolute maximum TTL:** 30 days since `created_at`, regardless of
  activity. This limits blast radius if a cookie is stolen.
- **On each authenticated request:** `last_seen_at` is updated
  (fire-and-forget; does not add latency).

### Revocation

Sessions are revoked (cannot be used again):

- on explicit logout (`revoked_reason = 'logout'`)
- on password reset (`password_reset`) — all sessions revoked
- on password change (`password_change`) — all sessions EXCEPT the current
  one (which is why CSRF re-verification is required before password change)

### Rotation

- A **fresh session is issued on every successful login** to prevent session
  fixation attacks. A pre-login cookie (if an attacker plants one) cannot
  grant post-login access.
- Password change retains the current session (so the user isn't logged out
  mid-flow) but revokes all others.

### Cookie

| Attribute        | Value                                  | Reason |
|------------------|----------------------------------------|--------|
| Name             | `sc_session`                           | Not suggestive of framework. |
| Value            | `<rawId>.<expSec>.<HMAC-SHA256>`       | Verifiable integrity without DB round-trip for obvious forgeries. |
| HttpOnly         | `true`                                 | Not readable from JavaScript (mitigates XSS exfiltration). |
| Secure           | `true` in production                   | Sent only over HTTPS. |
| SameSite         | `Lax`                                  | Cross-site POSTs do not carry the cookie (CSRF defense layer 1). |
| Path             | `/`                                    | App-scope. |
| Expires / Max-Age| Set to sliding TTL                     | Cookie expiry matches DB expiry. |

The HMAC uses `SCOLAIRA_SESSION_SECRET` (≥32 bytes, generated via
`openssl rand -base64 48`). Multiple secrets are supported (oldest accepted
for verification, first used for signing) to enable **zero-downtime key
rotation** by placing the old key in `SCOLAIRA_SESSION_SECRET_PREVIOUS`.

### CSRF defense

Double-submit cookie pattern:

- A second cookie `sc_csrf` is readable by JavaScript and contains
  `<csrfToken>.<HMAC(csrfToken, sessionId)>`.
- State-changing requests (POST/PUT/DELETE) must include an `X-CSRF-Token`
  header whose value equals the `sc_csrf` cookie.
- The server verifies (a) the header value matches the cookie value, and
  (b) the HMAC over `<sessionId>.<csrfToken>` is valid using the same
  `SESSION_SECRET`.
- Because the CSRF token is HMAC-bound to the session id, an attacker who
  plants a cross-site form cannot produce a valid header.

Combined with SameSite=Lax cookies, this defeats CSRF for both traditional
form posts and XHR/fetch mutations.

---

## 6. Password Recovery

- **Token:** 32 bytes CSPRNG, base64url encoded.
- **At rest:** `sha256(token)` stored as 64 hex characters in
  `password_resets.token_hash`. The plaintext token is returned exactly once
  (currently to the HTTP caller in development; production must email it).
- **Expiry:** 1 hour after `requested_at`.
- **Single use:** `consumed_at` is set on consumption; subsequent attempts
  return `RESET_INVALID`.
- **Atomicity:** Consumption uses `SELECT ... FOR UPDATE` against the reset
  row, then checks `consumed_at IS NULL` before updating. Two concurrent
  attempts against the same token: one wins, the other sees `consumed_at IS NOT NULL`
  and returns invalid (tested in `tests/auth/auth.test.ts`).
- **Session consequences:** all existing sessions for the user are revoked
  immediately on successful reset.
- **Rate limits:** per normalized-email sliding window (3 requests / 15 min).
- **Enumeration resistance:** identical response whether email exists or not.

---

## 7. Rate Limiting

Implemented in-Postgres via `auth_rate_limit_hit(key, max, window)`
(SECURITY DEFINER):

| Endpoint             | Key prefix           | Limit           |
|----------------------|----------------------|-----------------|
| login                | `login:email:<e>` / `login:ip:<ip>` | 10 / 15 minutes |
| register             | `register:ip:<ip>`   | 5 / hour        |
| reset request        | `reset:email:<e>`    | 3 / 15 minutes  |
| reset consume        | `reset-consume:<hash-prefix>` | 5 / 15 minutes |

Honest scope: these limits **reduce** brute-force and credential-stuffing
noise, but they do NOT solve denial-of-service. Volumetric attacks,
distributed credential stuffing, and layer-3/4 attacks must be handled by
upstream WAF/CDN/infra (Cloudflare, AWS Shield, etc.), which are M4+ concerns.

---

## 8. Multi-Organization Support

Identity is not tied to a single organization:

```
user
 ├── organization_members (role=SCHOOL_ADMIN, status=ACTIVE) → school A
 └── organization_members (role=TEACHER,       status=ACTIVE) → school B
```

- `getSession()` loads **all ACTIVE memberships** for the authenticated user.
- The active organization is selected by:
  1. `sc_org` cookie value IF the user has an ACTIVE membership there, else
  2. the first ACTIVE membership (deterministic).
- `switchOrganization(session, orgId)` is an authenticated server action
  that validates membership and re-sets the `sc_org` cookie; the next
  `getSession()` call re-resolves the active org and GUCs.
- Fabricating an `sc_org` value for an organization the user doesn't belong
  to is rejected server-side (tested explicitly: test
  "authenticated user cannot adopt a foreign org via sc_org cookie").

---

## 9. Tenant Context Handoff (M2 Bridge)

After authentication resolves a user, role, and organization, the auth
module calls M2's `set_tenant_context(orgId, userId)` which:

1. Verifies an ACTIVE membership row exists for `(user_id, organization_id)`
   (defense in depth if application-layer resolution has a bug).
2. Sets `app.organization_id`, `app.user_id`, `app.is_platform_admin` GUCs.
3. Enables RLS enforcement on tenant-owned tables (financials, students, etc.).
4. Switches on `bypass_financial_triggers = 0` so financial triggers are live.

The same `TenantCtx` shape (`{ organizationId, userId }`) that M2 repositories
expect is returned by `withAuth()`, so **no repository changes were required**.
This satisfies M3 §5 (do not create a second source of truth).

---

## 10. Middleware (Edge) — Coarse Routing Only

`middleware.ts` runs on the Edge runtime and CANNOT open a database connection.
It therefore cannot validate sessions or memberships. What it does:

- For protected page routes (`/dashboard`, etc.) when no session cookie is
  present or the cookie is syntactically invalid → redirect to `/login?next=...`.
- For protected API routes under `/api/` (except `/api/auth/login|register|reset-*`
  and `/api/health`) when no syntactically valid session cookie is present →
  return HTTP 401 JSON.
- Pass through everything else.

**If an attacker forges a cookie that passes the syntax/regex check but
fails HMAC or DB verification, the request reaches the route handler which
rejects it with 401.** Middleware is an optimization for UX, not a security
boundary.

---

## 11. Audit

- `login_attempts` records every login attempt (email, ip, success, timestamp).
  Password is **never** recorded; user agent is not currently recorded (added
  in a follow-up) to limit PII surface.
- Sessions track `created_at`, `last_seen_at`, `revoked_at`, `revoked_reason`,
  and initial IP/user-agent — enough to attribute a session without storing
  credentials.
- Password resets track `requested_at`, `request_ip`, `consumed_at` — the
  token hash itself is sufficient to invalidate; the plaintext token is gone.
- Rate-limit counters are ephemeral (sliding window); they are not audit
  records but contribute to abuse detection.

We do not store passwords, session secrets, reset tokens, or cookies in audit
tables (per M3 §16).

---

## 12. Threat Model & Residual Risks

| Threat | Mitigation |
|--------|------------|
| Credential stuffing | Per-email + per-IP rate limits; generic errors; argon2 slows online guessing. |
| Brute-force password   | argon2id makes each guess ~50–100 ms; rate limits cap attempts. |
| Session theft via XSS  | HttpOnly cookies block direct JS access; CSRF tokens are bound to session. |
| CSRF                   | SameSite=Lax + double-submit CSRF token on mutations. |
| DB-dump session replay | Tokens hashed (sha256) at rest; dump doesn't yield usable cookies. |
| DB-dump password crack | argon2id (m=19MiB, t=2) makes large-scale cracking expensive. |
| Session fixation       | Fresh session issued on login; pre-login cookie is unusable post-auth. |
| Account enumeration    | Identical messages + timing dummy work. |
| Reset token replay     | Single-use, row-locked consumption, 1-hour expiry, sha256 at rest. |
| Privilege escalation across orgs | Server resolves membership; RLS + `set_tenant_context()` re-verify. |
| Pooled connection leakage | GUCs cleared in `finally`; every entry point calls `setSystemContext()` first. |

### Residual / known limitations for M3 → M4

- **Password reset email delivery is not wired.** The development response
  echoes the token; M4 must replace this with a queued email job and remove
  the token from all responses.
- **Email verification on registration is not enforced.** The first release
  trusts the email provided; M4 will add email verification / school-domain
  allow-listing.
- **Account lockout after N failures is not implemented.** Rate limits slow
  attacks but do not permanently lock; an exponential backoff / lockout
  strategy belongs in M4 when we can combine it with account-recovery UX.
- **2FA / passkeys / SSO** are out of scope for M3.
- **Refresh-token / remember-me beyond 30 days** is out of scope; M3 is 12h
  sliding / 30d absolute.
- **Per-IP rate limit accuracy** depends on the proxy setting
  `X-Forwarded-For` correctly. M4 infrastructure must configure trusted
  proxies.
- **WAF / distributed brute-force defense** is upstream infrastructure and
  not claimed as an application-layer property.

---

## 13. M3/M4 Boundary

M3 establishes identity + membership + verified tenant context. It does NOT
implement:

- Full RBAC (field-level authorization beyond "is a member with role X")
- Platform-admin tooling / cross-school administration
- Invitation flows for adding staff to a school
- Email / SMS delivery
- WebAuthn / TOTP / SSO
- WAF / CDN / bot management
- Paystack or other financial features
- Any UI beyond essential auth screens

M4 will build on M3's `AuthSession` (which includes the role per membership)
to implement route- and action-level authorization checks. The shape is
deliberately forward-compatible.

---

## 14. Operational Reference

### Required environment variables

| Variable | Purpose |
|----------|---------|
| `SCOLAIRA_SESSION_SECRET` | HMAC key (≥32 bytes). Generate with `openssl rand -base64 48`. Required in every environment. |
| `SCOLAIRA_SESSION_SECRET_PREVIOUS` | Optional. Comma-separated list of old keys accepted for verification during rotation. |
| `DATABASE_URL` | Postgres connection string. |
| `NODE_ENV=production` | Enables `Secure` flag on cookies. |

### Running migrations

```bash
npm run db:migrate    # applies all migrations including 0003_auth.sql
```

Migrations are fully idempotent; re-running 0003 is safe.

### Revoking all sessions for a user

```sql
UPDATE sessions
   SET revoked_at = now(), revoked_reason = 'manual'
 WHERE user_id = '<uid>'::uuid AND revoked_at IS NULL;
```

### Rotating the session secret

1. Generate a new secret: `openssl rand -base64 48`
2. Set `SCOLAIRA_SESSION_SECRET_PREVIOUS` to the old value (comma-separated list
   for historical secrets if rotating more than once).
3. Set `SCOLAIRA_SESSION_SECRET` to the new value.
4. Deploy. Existing cookies signed with old keys are still accepted; new
   cookies are signed with the new key.
5. After SESSION_ABSOLUTE_MAX_MS (30 days) the old keys can be removed.
