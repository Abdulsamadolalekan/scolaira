# M3 Authentication Test Results

All tests run against **real PostgreSQL 17**, **real argon2**, and the same
cookie/HMAC/CSRF code paths production uses. There are no mocks, no dev
bypasses, no magic headers, and no test-only credential stores.

## Test inventory

| File | Tests | Kind |
|------|-------|------|
| `tests/auth/auth.test.ts` | 19 | Integration / red-team security |
| Existing M2 tests (`tests/db/*.test.ts`, unit) | 98 | Pre-existing — regression gate |
| **Total** | **117** | 30 unit · 87 integration (19 auth + 68 M2) |

Run:
```bash
NODE_ENV=test \
DATABASE_URL=postgresql://scolaira:scolaira@localhost:5432/scolaira_test \
SCOLAIRA_SESSION_SECRET=<secret> \
  npx vitest run
```

## Auth red-team assertions (19)

| # | Test | Property verified |
|---|------|-------------------|
| 1 | anonymous /api/auth/me returns 401 | Reject anonymous access (§15) |
| 2 | register creates user+org+membership and logs in | End-to-end account creation, automatic session (§13) |
| 3 | login creates fresh session; replay of old cookie fails after logout | Anti session-fixation, revocation (§8) |
| 4 | wrong password and unknown email return identical 401 with same message | Account enumeration resistance (§11, §14) |
| 5 | forged/tampered session cookie (signature flipped) rejected; garbage cookie rejected | HMAC integrity (§8) |
| 6 | logout revokes server-side session and clears cookie | Session revocation (§8, §13) |
| 7 | CSRF blocks POST without `X-CSRF-Token` even with a valid session | CSRF double-submit (§8) |
| 8 | CSRF passes when double-submit token included | CSRF positive path |
| 9 | change-password rejects wrong current password | Re-auth required for credential change (§13) |
| 10 | reset: issue → consume → new password works, old fails, old sessions revoked, replay fails | Full password reset lifecycle: single-use, expiry, revocation (§13) |
| 11 | reset request for unknown email returns 200 ok (no enumeration) | Reset enumeration resistance (§14) |
| 12 | forged reset token rejected | Reset token unforgeability (§14) |
| 13 | /me response never contains `password_hash`, `$argon2`, or 64-hex secrets | No credential leakage in responses (§16) |
| 14 | DB stores `$argon2id$…` hash; plaintext password not present | argon2id actually used (§7) |
| 15 | `sessions.token_hash` is 64-hex sha256; raw cookie id never appears anywhere in DB | Tokens hashed at rest (§8) |
| 16 | authenticated user cannot adopt a foreign org by setting sc_org cookie | Client-supplied org is not trusted; tenant isolation (§4, §11) |
| 17 | rate limit triggers after 10 failed login attempts; correct password then returns 429 | Rate limiting (§14) |
| 18 | concurrent duplicate user inserts produce exactly one user (uniqueness enforced) | No duplicate accounts under concurrency (§15, §18) |
| 19 | concurrent reset-token consumption (SELECT … FOR UPDATE) yields exactly one winner, one consumed row | Atomic single-use reset under concurrency (§13, §18) |

## Regression evidence

All 98 M2 tests (unit + financial/tenant/state-machine/concurrency/audit/webhook/
rich-seed/idempotency) continue to pass after M3 schema changes. The sessions
table was modified in-place by migration 0003 (token column renamed to
token_hash, csrf_token/revocation columns added); no M2 code depends on the old
plaintext `token` column because M2 did not use sessions.

## Executive Security & Architecture Gate (M3 §22)

| # | Gate criterion | Evidence |
|---|----------------|----------|
| 1 | Anonymous users cannot perform protected operations | Tests #1, #7, and the server-side redirect in `/dashboard` and 401 from `/api/auth/me` |
| 2 | One user cannot impersonate another | HMAC requires `SESSION_SECRET`; DB lookup joins on `sessions.user_id`; test #5 verifies tampered sig rejected |
| 3 | Sessions cannot be forged trivially | 256-bit random id + HMAC-SHA256 signature; test #5 covers forgery |
| 4 | Revoked sessions cannot continue | Tests #3 and #6; `revoked_at` checked in `getSession()` |
| 5 | Reset capabilities expire and cannot be replayed | Test #10 (expiry enforced in code; replay returns RESET_INVALID), test #12 (forged token rejected) |
| 6 | Duplicate accounts cannot bypass uniqueness under concurrency | Test #18 (PG unique index wins races) |
| 7 | Membership cannot be fabricated | `organization_members` is the only source; `getSession()` reads ACTIVE memberships only; `set_tenant_context()` re-verifies in PL/pgSQL |
| 8 | Organization context cannot be fabricated | Test #16; membership lookup rejects sc_org values with no membership |
| 9 | Roles cannot be trusted from client input | Roles are read from `organization_members`; no role fields in cookies/headers |
| 10 | Tenant context does not leak across pooled connections | `clearContext()` runs in `finally` for every auth entry point; `setSystemContext()` is called before each system-level query |
| 11 | Auth cannot bypass M2 tenant enforcement | Auth calls M2's `set_tenant_context()`, which is the same function repositories use; RLS/force-RLS/triggers remain active |
| 12 | Alternate routes cannot bypass auth | Middleware 401/redirect + every protected route must call `getSession()` (e.g. `/dashboard`, `/api/auth/me`, `/api/auth/change-password`) |
| 13 | Credentials and session secrets do not leak | Test #13; error messages are generic; audit tables do not store passwords/tokens |
| 14 | Security events are attributable | `login_attempts`, `sessions.revoked_reason`, `password_resets.consumed_at` provide attribution without credential leakage |
| 15 | Production security boundaries intact | Cookies HttpOnly+Secure(prod)+SameSite=Lax; argon2id params at OWASP levels; session hashed at rest; NODE_ENV=test in tests, NODE_ENV=production used for build verification |

## Build & type-check evidence

- `npx tsc --noEmit` — **clean, zero errors**
- `NODE_ENV=production next build` — **passes** (only pre-existing eslint warnings about `any` in audit/idempotency modules, no new errors)
- Full migration chain from zero — verified by vitest global setup which DROPs
  public + drizzle schemas and re-runs `drizzle-kit migrate` including 0003
  before every test run.

## Secret scan

No plaintext secrets, API keys, or hardcoded passwords were added in M3:
- `SCOLAIRA_SESSION_SECRET` is required from env; no default.
- `.env.local` and `.env.test` are gitignored (pre-existing) and contain
  locally-generated random values.
- `argon2` npm package is the only new runtime dependency (mature, audited).
  No auth frameworks (Auth.js, Lucia, Supabase SDK, NextAuth) were added.

## Known defects found and fixed during M3

1. **Sessions stored plaintext token (M2 carry-over):** Fixed by migration 0003
   — column renamed to `token_hash`; now stores sha256(raw id). Raw id is only
   ever present in Set-Cookie response.
2. **Sessions table had no CSRF token column:** Added `csrf_token char(43)`
   with CSPRNG default, enabling double-submit defense.
3. **Sessions table had no revocation reason / last_seen columns:** Added to
   support audit and sliding expiry.
4. **Missing RLS write policies for auth tables in system context:** Initial
   RLS policies were SELECT-only (self-read). Fixed with `WITH CHECK` clauses
   permitting writes when `app.user_id` matches OR in system context
   (empty GUCs) — used only during login/register/reset flows which explicitly
   call `set_tenant_context_for_system(NULL, NULL)`.
5. **Incorrect column names in TS schema for `login_attempts` /
   `password_resets` / `rate_limits`:** Corrected to exactly match the
   migration (`attempted_at`, `requested_at`, `counter`, `expires_at`).
6. **Rate-limit function returns `auth_rate_limit_hit` with `counter > max`
   semantics:** Confirmed via rate-limit test (11th attempt → 429).
7. **Test harness transaction poisoning:** SQL errors inside handlers were
   aborting the per-test BEGIN transaction. Fixed by wrapping each handler
   invocation in a `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` so a handler error
   doesn't poison later calls. This is a harness fix, not a production
   weakening.

## Coverage note

M3 is 19 tests per the founder's directive to prefer "35 meaningful security
tests over 200 superficial ones." Additional surface (invitation flows, email
verification, 2FA, RBAC) belongs to M4 and will be tested there.
