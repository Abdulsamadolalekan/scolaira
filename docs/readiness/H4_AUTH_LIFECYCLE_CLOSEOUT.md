# H-4 Closeout — Registration Transactionality & Auth Lifecycle Integrity

**Baseline:** `07ab6e8789491dae503915ee5d3202d675cff90b` (H-2 accepted; H-5 `6ba8b149…`).
**Scope source:** `docs/readiness/H4_SCOPE_MAP.md` (measured first, implemented second) and the
register entry `docs/readiness/POST_M11_READINESS_AUDIT.md` §H-4.
**Migrations added:** **none.** The verified H-4 defects are all in the application/authorization
layer; the schema was already correct. Every deployment state (fresh install, upgraded database)
therefore runs the same code with the same journal (48 migrations).

---

## 1. Findings closed

| # | Measured before | Fixed behaviour | Evidence |
| - | --------------- | --------------- | -------- |
| F1 | Duplicate email on `POST /api/auth/register` → **500 INTERNAL** (Drizzle wraps the driver error, so `e?.code === '23505'` never fired) | **409 `EMAIL_TAKEN`**, actionable message, no constraint/SQLSTATE in the body | `h4-lifecycle` F1 |
| F2 | Duplicate school slug → **500 INTERNAL**; audit text claimed the four inserts were separate autocommit statements | **409 `SLUG_TAKEN`**; the four inserts were already one transaction — the real gap was F3 | `h4-lifecycle` F2 |
| F3 | Auto-login session insert ran **outside** the provisioning transaction: injecting a failure returned 500 while `users:1 / organizations:1 / password_credentials:1` persisted — an orphan school account that also consumed the email and slug | One unit of work: account, school, membership, credential **and the session row** commit or roll back together; cookies are published only after the commit | `h4-lifecycle` F3 (0 rows in all five tables, email+slug reusable, retry 201), `h4-independent-reaudit` A (failure moved to the *last* insert) |
| F4 | No outer cleanup; failures were not actionable | Any provisioning/auto-login failure rolls back fully and answers with a mapped, operator-readable error; a retried signup cannot create a second account | `h4-lifecycle` F4, `h4-independent-reaudit` A |
| F5 | Consuming a reset token left **sibling tokens for the same user live**; `changePassword` left outstanding reset tokens live | Consuming a token retires the whole outstanding reset family for that user; a successful authenticated password change does the same | `h4-lifecycle` F5, F5b; ordering pinned by `h4-independent-reaudit` C (an expired/refused token cannot be used to retire a live sibling) |
| F6 | Sequential double-consume already refused (`RESET_INVALID`) | unchanged — pinned as a regression | `h4-lifecycle` F6 |
| F7 | `POST /api/auth/logout` changed state (session revoke + cookie clear) with **no CSRF check**, contradicting the module's declared "double-submit for unsafe methods" contract | Logout requires the double-submit token: `x-csrf-token` (fetch callers) **or** a `_csrf` form field (the app-shell's no-JS form, which now renders the hidden field from the signed CSRF cookie) | `h4-lifecycle` F7 (403 / 403 / 303-form / 200-header), `h4-independent-reaudit` D (another session's token is refused), `e2e/h4-signout.spec.ts` (real browser submit → `/api/auth/me` 401 → shell redirects to sign-in) |
| F8 | `reset-confirm` 500 body echoed internal text (probe leaked `H4-LEAK-MARKER … password_resets_internal_idx`) | Auth error envelopes never echo internal detail; SQLSTATE/index names/stack go to the server log only | `h4-lifecycle` F8 (fault injected through a real DB constraint) |
| F9 | Register rate limit keyed on client-supplied `x-forwarded-for` → **7/7 signups accepted** against a 5-per-hour policy | Rate-limit identity comes from `lib/http/client-ip.ts`: the header is **ignored unless** the deployment declares `TRUSTED_PROXY_HOPS=n`, in which case the n-th entry from the right is used (prepended fakes sit to the left) | `h4-lifecycle` F9/F9b, `h4-independent-reaudit` F (prepending hops cannot rotate the bucket) |
| F10 | `switchOrganization()` wrote a raw `sc_org` value `verifyActiveOrgCookie()` can never accept → the switch was silently ignored (dead, lying helper) | The cookie is signed with `signActiveOrgCookie(orgId, userId)` through the single `activeOrgCookieOptions()` writer shared with `select-organization` | `h4-lifecycle` F10 (cookie verifies, `getSession()` honours it, non-member switch refused), `h4-independent-reaudit` E (unsigned cookie ignored) |

**Consequences recorded, not defects:** with no declared proxy the register/login/reset limiters fall
back to one deployment-wide bucket and audit rows keep a null client address. That is the fail-closed
behaviour; a deployment **must** set `TRUSTED_PROXY_HOPS` (1 for a single nginx/ELB hop) to restore
per-client buckets. Documented in `docs/API_CONTRACTS.md` §II.A.1 and in the module header.

---

## 2. Residual: the identity-visibility door (measured, NOT closed)

Measured with the runtime role only (no migration changed this):

* `set_config('app.auth_bootstrap','1',true)` → reads on
  `organizations / users / organization_members / password_credentials / password_resets / sessions`,
  `INSERT organizations` accepted, 18-row `UPDATE organizations` and `UPDATE users` accepted.
* `set_config('app.user_id', <any user>)` → that user's credential row, session rows, reset rows and
  `users.email` become readable/writable without any token.
* `auth_enter_system_context()` is app-`EXECUTE`-able and needs no argument.

It is **not** fixed here, for three reasons (full reasoning in `H4_SCOPE_MAP.md` §3):

1. `docs/security/M4_CLOSEOUT_REPORT.md` declares bootstrap narrow-and-accepted, and the register,
   login and reset flows legitimately run on it. R1/R3/H-5 froze that model; H-4 does not rework
   frozen invariants.
2. The door is **dominated** by the app-callable SECURITY DEFINER, which grants strictly more than
   the raw GUC does — narrowing the raw-GUC branch alone would change no attacker's reach.
3. The real remediation is structural: move the registration/login/reset units of work into DB-side
   SECURITY DEFINER entrypoints and revoke `auth_enter_system_context()` from the runtime role. That
   is a milestone-sized redesign and must not be half-landed.

Status: **open**, recorded in the readiness register (§H-4 status note) as remaining work, not
silently accepted.

---

## 3. Files changed

| Area | Files |
| ---- | ----- |
| Transaction & conflict mapping | `lib/auth/index.ts` (register unit of work, `registerConflict`, `mintSessionRow`/`publishSession`, login publication), `lib/db/pg-error.ts` (`uniqueViolationKey`, `uniqueViolationIndex`, `pgField`, `isUniqueViolation`) |
| Reset lifecycle | `lib/auth/index.ts` (`resetPassword`, `changePassword`) |
| Logout CSRF | `app/api/auth/logout/route.ts`, `lib/auth/index.ts` (`requireCsrf` form-field support), `components/ui/app-shell.tsx`, `app/(app)/layout.tsx` |
| Error disclosure | `app/api/auth/reset-confirm/route.ts` |
| Rate-limit identity | `lib/http/client-ip.ts` (new), `app/api/auth/{register,login,reset-request}/route.ts` |
| Active-org cookie | `lib/auth/cookies.ts` (`activeOrgCookieOptions`), `lib/auth/index.ts` (`switchOrganization`), `app/api/auth/select-organization/route.ts` |
| Tests | `tests/auth/h4-lifecycle.test.ts` (new, 12), `tests/auth/h4-independent-reaudit.test.ts` (new, 8), `tests/auth/support.ts` (form-body + header precedence), `tests/auth/auth.test.ts` (logout now sends CSRF), `e2e/h4-signout.spec.ts` (new), `playwright.config.ts` (declares the e2e proxy hop) |
| Docs | this file, `docs/readiness/H4_SCOPE_MAP.md`, `docs/readiness/POST_M11_READINESS_AUDIT.md`, `docs/API_CONTRACTS.md` |

Frozen history untouched: M1–M11, R1/R2/R3, H-5 and H-2 files were not modified except the
logout assertions inside `tests/auth/auth.test.ts`, which asserted the behaviour F7 removes.

---

## 4. Gates

| Gate | Result |
| ---- | ------ |
| H-4 contract suite (`tests/auth/h4-lifecycle.test.ts`) | **12/12** |
| H-4 independent re-audit (`tests/auth/h4-independent-reaudit.test.ts`) | **8/8** |
| Root regression `npx vitest run` | **46 files / 544 tests passed** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | exit 0 (pre-existing warnings only) |
| `npm run build` | succeeded |
| Playwright `npx playwright test` | **37 passed** (a11y 7, health 7, H-5 4, H-4 sign-out 1, screenshots 18) |
| Fresh install (`scolaira_h4fresh`) | drop/create → `scripts/migrate.ts` `new=48 total=48`; then 45/45 through the vitest harness (`h4-lifecycle` 12, `h4-independent-reaudit` 8, `m4-pentest` 15, `db-boundary` 10) |
| Upgrade (`scolaira_upgrade`, 48 with pre-existing data: 772 invoices, 5 memberships, …) | `scripts/migrate.ts` → **`new=0 total=48`** (H-4 adds no migration); 11-table row fingerprints **identical** before/after (`/tmp/h4-fp-before.txt` vs `-after.txt`); the auth suites also pass with the runner pointed at that database (the harness rebuilds the schema, so that leg is fresh-install class — the upgrade-specific claims are the zero-migration journal and the unchanged data) |
| Migration journals | unchanged: `scolaira`, `scolaira_test`, `scolaira_h2fresh`, `scolaira_upgrade`, `scolaira_h4fresh` = 48; `scolaira_scratch` = 47 (as at H-2) |

---

## 5. Residual NOT-YET-VERIFIED items

1. **`switchOrganization()` is still not wired to any route/UI** (no org switcher exists). The helper
   is now truthful and tested; wiring it is product work outside H-4.
2. **`TRUSTED_PROXY_HOPS` is unverified in a real proxied deployment.** The fail-closed default is
   proven; the trusted path is proven with a declared hop count, but no production proxy
   configuration exists to validate against.
3. **The identity-visibility door (F11)** — see §2.
4. **Client address in audit rows** (`sessions.ip_address`, `password_resets.request_ip`,
   `login_attempts.ip`) is now `null` unless the deployment declares its proxy topology. Correct by
   policy, but the audit-trail consequence is only exercised at the unit/integration level.
5. **Concurrent duplicate registration** under real HTTP (parallel signups for one email) is covered
   by the existing `tests/auth/auth.test.ts` concurrency test at the SQL level, not through two
   simultaneous route invocations.
