# H-4 Scope Map — Registration Transactionality & Auth Lifecycle Integrity

**Status:** reconnaissance complete (measure-first). Nothing below was implemented before the
findings were measured against the frozen H-2 tree (`07ab6e8…`).
**Baseline:** `07ab6e8789491dae503915ee5d3202d675cff90b` (H-2 accepted).
**Audit entry under remediation:** `docs/readiness/POST_M11_READINESS_AUDIT.md` → H-4
("registration writes not transaction-wrapped; register route has no outer cleanup;
remediation = one unit of work, full rollback on failure, actionable failure messages;
pilot-required; ADQ wants failure-injection evidence").

## 1. How the findings were measured

Temporary harness `tests/db/tmp-h4-measure.test.ts` (delete before the H-4 commit) drove the real
route handlers in-process (`tests/auth/support.ts::call`) against PostgreSQL, with failure injection
installed in `beforeAll` over a **committed owner connection** (DDL inside a per-test transaction
deadlocks), keyed on narrow markers so unrelated suites are untouched:

* `sessions` BEFORE INSERT trigger that raises for `ip_address = '203.0.113.250'` → auto-login fault.
* `password_resets` BEFORE UPDATE trigger that raises for `request_user_agent LIKE 'H4LEAK-%'` → reset-consume fault.

Raw evidence: `/tmp/h4-measure-raw.txt`, `/tmp/h4-policies.txt`, `/tmp/h4-authfns.sql`.

## 2. Measured findings and scope decisions

| # | Measured behaviour | Severity | Decision |
| - | ------------------ | -------- | -------- |
| F1 | Duplicate email on `/api/auth/register` → **500 INTERNAL** (should be `409 EMAIL_TAKEN`). Drizzle wraps the driver error so `e?.code === '23505'` never fires — same cause-chain class as the H-2 `PERIOD_OVERLAP` fix. | High (contract + pilot blocker) | **FIX** |
| F2 | Duplicate school slug → **500 INTERNAL** (should be `409 SLUG_TAKEN`), and the rejected attempt leaves no partial rows. | High | **FIX** |
| F3 | Auto-login (session insert) runs **after** the provisioning transaction. Injecting that failure returns 500 while `users:1 / organizations:1 / password_credentials:1` persist → an orphan school account that also permanently takes the email and slug, and whose retry then hits F1's mis-mapped conflict. | **Critical (core H-4)** | **FIX** |
| F4 | `/api/auth/register` has no outer unit of work: no cleanup, and its 500 body is generic while the real reason is lost (the failure is not actionable). | Medium | **FIX** |
| F5 | Consuming one password-reset token leaves **sibling tokens for the same user live**; `changePassword` also leaves outstanding reset tokens live. A token captured before a password change stays a working account-takeover path. | High | **FIX** |
| F6 | Sequential double-consume of the same token is already refused (`RESET_INVALID`). | — | No change (regression-pinned) |
| F7 | `POST /api/auth/logout` performs a state change (`revoke session`, `clear cookies`) with **no CSRF check**, contradicting the module's declared "CSRF double-submit for unsafe methods" contract. The UI posts a plain form (`components/ui/app-shell.tsx` → `sessionAction="/api/auth/logout"`), so the fix must keep the no-JS form working. | Medium | **FIX** |
| F8 | `reset-confirm` 500 body echoed internal text (`String(e?.message ?? e)`); the probe leaked the injected marker and the internal index name. | Medium (information disclosure) | **FIX** |
| F9 | Register rate limit was keyed on the client-supplied `x-forwarded-for` → **7/7 registrations accepted** with spoofed headers against a 5/hour policy. | Medium | **FIX** |
| F10 | `switchOrganization()` writes a raw (unsigned) `sc_org` value that `verifyActiveOrgCookie()` can never verify — the switch is silently ignored; the helper is dead code that lies about what it did. | Low (latent) | **FIX** |
| F11 | Identity-table visibility is reachable from a bare `app.auth_bootstrap='1'` / `app.user_id` GUC self-asserted by the runtime role (orgs/users/members/credentials/sessions read **and** write, incl. `UPDATE organizations/users`), and `auth_enter_system_context()` is app-EXECUTE-able with no argument. | Documented residual | **NOT IN H-4 — see §3** |
| — | The audit premise "registration writes are not transaction-wrapped" is **stale** for the four provisioning inserts: they already run in one `withSystemScope` transaction and roll back together (measured: `orphanUsersForRejectedEmail: 0`). The real gap is F3 (the session is minted outside that unit). | — | Recorded; no code change for the premise itself |

## 3. Deliberately out of scope (with reasons)

**F11 — the identity-visibility door.** Measured: with a bare
`set_config('app.auth_bootstrap','1',true)` the runtime role reads
`organizations/users/organization_members/password_credentials/password_resets/sessions`
and is accepted on `INSERT organizations` and on 18-row `UPDATE organizations` / `UPDATE users`;
with a bare `app.user_id` it reads/writes that user's credential row, session rows, reset rows and
email. It is **not** fixed in H-4 because:

1. `docs/security/M4_CLOSEOUT_REPORT.md` declares bootstrap narrow-and-accepted ("Yes [settable] —
   Narrow — only users/organizations/organization_members/sessions/password_credentials/
   password_resets … no financial/students/fees") and register/login/reset legitimately run on it.
   R1/R3/H-5 froze that model; H-4 must not rework frozen invariants.
2. The door is **dominated** by an app-callable SECURITY DEFINER (`auth_enter_system_context()`)
   that grants strictly more than the raw GUC does. Narrowing the raw-GUC branch alone would be
   cosmetic — it changes no attacker's reach.
3. The real remediation is structural: move the registration/login/reset units of work into
   DB-side SECURITY DEFINER entrypoints so `auth_enter_system_context()` can be revoked from the
   runtime role. That is a milestone-sized redesign, not an H-4 remediation, and it must not be
   half-landed.

It is recorded in the H-4 closeout and the readiness register as an **open** finding with this
evidence, so it is neither silently fixed nor silently dropped.

**Also out of scope (unchanged):** H-6, H-8, H-9, A5, M12; M1–M11 frozen history; R1/R2/R3/H-5/H-2
invariants; the H-2 dev-DB `auth_period_valuation` §4 ops note.

## 4. Fix plan (forward-only, no migration expected)

| Finding | Change |
| ------- | ------ |
| F1, F2 | Register maps conflicts by walking the **cause chain** (`lib/db/pg-error.ts` gains a unique-violation reader) → `409 EMAIL_TAKEN` / `409 SLUG_TAKEN`, else `409 CONFLICT`; messages stay actionable and leak nothing. |
| F3, F4 | Register provisions account + school + membership + credential **and mints the auto-login session inside the same unit of work**; cookies are published only after the transaction commits. A failure therefore rolls back everything and the response is actionable. |
| F5 | Consuming a reset token marks **all** outstanding tokens for that user as consumed; a successful `changePassword` invalidates outstanding reset tokens too. |
| F6 | Keep as-is; pin with a regression assertion. |
| F7 | `/api/auth/logout` requires the double-submit CSRF token. The token is accepted from `x-csrf-token` (fetch callers) **or** a `_csrf` form field (the existing app-shell form, which gains a hidden input). |
| F8 | Auth error envelopes never echo internal messages; internal detail goes to the server log only. |
| F9 | Rate-limit identity comes from a single helper with a **fail-closed** trusted-proxy policy: `x-forwarded-for` is ignored unless `TRUSTED_PROXY_HOPS=n` (n ≥ 1) is configured, in which case the n-th entry from the right is used. |
| F10 | `switchOrganization()` signs the cookie with `signActiveOrgCookie(orgId, userId)` through the same options helper the `select-organization` route uses, so one writer exists for the cookie. Residual recorded: the helper is still not wired to any route. |

Verification plan (standard): adversarial test suite → independent re-audit pass with fresh eyes →
root regression (`vitest`, `tsc`, lint, build, Playwright) → fresh-install + 47/48→upgrade
verification (no migration expected; confirm journal counts unchanged) → closeout → commit.
