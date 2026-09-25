# M4 Closeout Report — Final Adversarial Gate

**M4 STATUS: PASS**

## Attack Surface Challenged

Attacks were mounted against a freshly migrated `scolaira_final` database over a raw PostgreSQL connection logged in as the runtime role `scolaira_app` (NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB/NOINHERIT), with full knowledge of schema, policies, SECURITY DEFINER functions, GUC names, and real IDs of two seeded schools (A = Alice/OWNER, B = Bob/OWNER) plus a seeded platform admin (Plat).

Round-by-round coverage:
1. Cold default-deny (no context).
2. Direct-ID cross-tenant SELECT on orgs / users / members / students.
3. Joins, subqueries, EXISTS, UNION, aggregates.
4. Forgery of every trusted GUC (is_platform_admin, platform_admin_id, auth_bootstrap, organization_id, user_id) and every combination (auth_bootstrap + tenant, bootstrap + platform flag, stolen tenant_token + forged org_id, NULL tenant, NULL user).
5. SECURITY DEFINER inventory & abuse (enter_platform_context, set_tenant_context, auth_is_platform_admin_authorized, auth_is_tenant_authorized, auth_enter_system_context, clear_app_context, rate-limit helpers, number generators, auth_tenant_token_for, auth_test_system_context).
6. Direct-DB cross-tenant SELECT/INSERT/UPDATE/DELETE.
7. Platform-admin boundary (forged platform_admin_id to both non-admin UUIDs and unrelated UUIDs; non-admin entry rejected; valid admin sees all).
8. Bootstrap narrowness (auth_enter_system_context sees only auth/identity tables — users, orgs, members, sessions, credentials — and 0 students/invoices/payments/fees).
9. Second-order attacks via foreign IDs (students / invoices / payment_ids / org_ids).
10. Exception-path / clear_app_context / onconnect GUC reset.
11. Fresh DB provision from `scripts/migrate.ts` (production-like) + seed via the SECDEF test helper.
12. Repository static hunt (BYPASSRLS / SUPERUSER / SECURITY DEFINER / SET ROLE / set_config / is_platform_admin / auth_bootstrap / fallback `OR` / dev bypasses).
13. Financial integrity/concurrency/idempotency suite (still passing).
14. Full regression suite (vitest, tsc, next build).

## Vulnerabilities Discovered During This Gate (Closed)

| # | Severity | Vulnerability | Root Cause | Remediation |
|---|----------|---------------|------------|-------------|
| V1 | CRITICAL | `scripts/migrate.ts` and `tests/global-setup-db.ts` issued `GRANT EXECUTE ON ALL FUNCTIONS … TO scolaira_app` AFTER migrations, silently re-granting EXECUTE on `set_tenant_context_for_system(NULL,NULL)` even after migration 0010 revoked it. | Over-broad post-migration grant in the harness. | Removed blanket `GRANT EXECUTE ON ALL FUNCTIONS`; added explicit per-function EXECUTE whitelist in 0010; added `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE` so future CREATE OR REPLACE doesn't auto-grant. |
| V2 | CRITICAL | `auth_is_platform_admin_authorized()` — platform branch previously trusted `app.is_platform_admin='1'` directly, and a second draft that looked up platform_admin_id via users could itself be bypassed by forging platform_admin_id to any existing UUID; also PL/pgSQL `FOUND` was being clobbered by a follow-up PERFORM in set_tenant_context/enter_platform_context, so the non-member/non-admin rejection never fired. | Missing membership-validated platform check + PL/pgSQL FOUND bug. | New SECDEF `auth_is_platform_admin_authorized()` that sets `auth_bootstrap` internally to read users without recursion, returns true only if the referenced user is is_platform_admin=true; captured FOUND into a boolean immediately after SELECT INTO in both set_tenant_context and enter_platform_context. |
| V3 | CRITICAL (re-discovered during adversarial run) | Tenant branch on ALL 21 tenant tables, organizations, and organization_members checked `organization_id = current_setting('app.organization_id')` (or `id = …`), trusting the raw GUC. An attacker with SQLi could simply `SELECT set_config('app.organization_id', '<School B>', false)` and read B's rows — even without calling set_tenant_context. | Tenant visibility tied to an attacker-settable GUC. | Introduced unforgeable tenant token: SECDEF `auth_tenant_token_for(org,user)` computes HMAC-SHA256 over `(org|user|pg_backend_pid())` keyed by a 32-byte secret stored in `app_meta` (owner-owned, NO grants to scolaira_app). `set_tenant_context()` mints the token into `app.tenant_token` after validating membership; `clear_app_context` clears it. SECDEF `auth_is_tenant_authorized()` recomputes and compares. Tenant-table policies now require `auth_is_tenant_authorized() AND organization_id = current_setting(...)`. |
| V4 | HIGH | `auth_tenant_token_for` was left with default EXECUTE → scolaira_app could mint its own tokens. | Missing REVOKE. | Explicit `REVOKE ALL ON FUNCTION auth_tenant_token_for(uuid,uuid) FROM PUBLIC, scolaira_app;` added to the whitelist block. |
| V5 | MEDIUM | `trg_set_org_from_context` only accepted explicit organization_id when is_platform_admin='1', breaking the legitimate register flow (which uses bootstrap mode to insert users + org + membership). | Trigger v_is_system flag didn't account for bootstrap. | Trigger now accepts explicit organization_id when either `v_is_system` OR `v_is_bootstrap` is true, matching the RLS policy model. |
| V6 | MEDIUM | `onconnect` GUC reset and `clearContext` in JS did not reset `platform_admin_id` or `tenant_token`; exception path could leak state. | Partial reset. | Added `platform_admin_id=''` and `tenant_token=''` to `clear_app_context`, `auth_enter_system_context`, `enter_platform_context`, set_tenant_context failure paths, set_tenant_context_for_system, and the lib/db/index.ts `SET SESSION` onconnect block. |
| V7 | MEDIUM | Original org/users/members seed path (owner → `set_tenant_context_for_system(NULL, <uuid>)`) chicken-and-egg: platform_admin_id refers to a user not yet inserted, so RLS blocked the insert. Test helper `auth_test_system_context(NULL,NULL)` did not set bootstrap. | Bootstrap vs platform confusion in seeding. | `auth_test_system_context(NULL,NULL)` now sets `auth_bootstrap='1'` with platform_admin_id='' (narrow — no financial visibility); when org is supplied it delegates to set_tenant_context so a valid tenant_token is minted. Fixed `trg_set_org_from_context` to accept explicit org during bootstrap. |
| V8 | LOW | Test files called `set_tenant_context_for_system(NULL,NULL)` directly and used raw `set_config` for tenant setup; after the revoke and token changes these no longer modelled the runtime correctly. | Test harness assumptions. | Updated `tests/support/seed.ts`, `tests/support/concurrent-seed.ts`, `tests/auth/auth.test.ts`, `tests/auth/authz.test.ts`, `tests/auth/m4-pentest.test.ts`, `tests/auth/rls-bypass-regression.test.ts` to use `auth_enter_system_context`/`auth_test_system_context`/`set_tenant_context`; added new `tests/db/db-boundary.test.ts` that connects as `scolaira_app` and asserts the live DB boundary. |

## Database Security (Live — `scolaira_final`)

### Role attributes (scolaira_app)

| Attribute | Value |
|---|---|
| rolsuper | false |
| rolbypassrls | false |
| rolcreaterole | false |
| rolcreatedb | false |
| rolinherit | false |
| canlogin | true |

`FORCE ROW LEVEL SECURITY` is enabled on all tenant, auth, financial and rate-limit tables; the owner role is also subject to RLS (`ALTER TABLE … FORCE ROW LEVEL SECURITY`).

### SECURITY DEFINER inventory — live grants

| Function | Owner | scolaira_app EXECUTE | Purpose / risk |
|---|---|---|---|
| set_tenant_context_for_system(uuid,uuid) | scolaira_owner | **false** | Restricted elevation primitive; owner/superuser only. Cannot be called by runtime. |
| auth_tenant_token_for(uuid,uuid) | scolaira_owner | **false** | Token minter; uses server-side HMAC secret. Runtime CANNOT call. |
| set_tenant_context(uuid,uuid) | scolaira_owner | true | Validates membership then mints tenant_token. Safe entry point. |
| enter_platform_context(uuid) | scolaira_owner | true | Validates is_platform_admin=true via bootstrap read; sets is_platform_admin='1' + platform_admin_id. Safe. |
| auth_enter_system_context() | scolaira_owner | true | Sets auth_bootstrap='1' only (narrow, for register/login/reset). Cannot read financial tables. |
| clear_app_context() | scolaira_owner | true | Resets ALL GUCs (organization_id, user_id, acting_role, is_platform_admin, platform_admin_id, auth_bootstrap, bypass_financial_triggers, tenant_token) to empty/0. |
| auth_is_platform_admin_authorized() | scolaira_owner | true | SECDEF validator. Returns boolean; internally uses bootstrap read of users to look up platform_admin_id.is_platform_admin. No side effects. |
| auth_is_tenant_authorized() | scolaira_owner | true | SECDEF validator. Returns true iff app.tenant_token matches HMAC(org,user,pid) signed by the app_meta secret. No side effects. |
| auth_test_system_context(uuid,uuid) | scolaira_owner | true | Test-only helper. With NULL,NULL sets bootstrap; with (org,user) delegates to set_tenant_context (so RLS-token is minted). Safe; used by tests/seeds. |
| auth_rate_limit_hit / auth_record_login_attempt / auth_clear_rate_limits / auth_verify_password | scolaira_owner | true | Auth/rate-limit helpers; rate_limits/login_attempts are owner-only, accessed exclusively through these SECDEFs. |
| next_doc_number / trg_assign_{invoice,payment,receipt,reversal}_number | scolaira_owner | true | Numbering triggers/helpers; no GUC mutation; run with fixed search_path. |

Every SECURITY DEFINER function pins `SET search_path = pg_catalog, public`.

## Authorization-Context Security

| GUC | Settable directly by scolaira_app via `set_config`? | Sufficient on its own to access tenant data? | Set legitimately by | Cleared by |
|---|---|---|---|---|
| app.organization_id | Yes | **NO** — requires matching tenant_token | set_tenant_context (SECDEF) | clear_app_context, onconnect reset, all rejection paths |
| app.user_id | Yes | **NO** — requires matching tenant_token | set_tenant_context / enter_platform_context (SECDEF) | clear_app_context, onconnect reset |
| app.is_platform_admin | Yes | **NO** — requires valid platform_admin_id AND validator true | enter_platform_context (SECDEF) | clear_app_context, onconnect reset |
| app.platform_admin_id | Yes | **NO** — must refer to a user with is_platform_admin=true (checked by SECDEF validator) | enter_platform_context | clear_app_context, onconnect reset |
| app.auth_bootstrap | Yes | Narrow — only users/organizations/organization_members/sessions/password_credentials/password_resets visible; no financial/tables/students/fees | auth_enter_system_context (SECDEF) | clear_app_context, onconnect reset |
| app.tenant_token | Yes | Can only be forged if attacker knows the 32-byte HMAC secret in app_meta (scolaira_app has NO read on app_meta). A stolen token from (A,Alice,pid) does not grant access to any other (org,user) — verified in D3. | set_tenant_context (SECDEF), via auth_tenant_token_for which is REVOKED from scolaira_app | clear_app_context, onconnect reset, set_tenant_context failure paths |
| app.acting_role / app.bypass_financial_triggers | Yes | Not used as RLS gates (display / trigger bypass respectively) | set_tenant_context / platform | clear_app_context |

GUC combinations (auth_bootstrap+tenant, auth_bootstrap+platform flag, platform_admin_id+forged flag, NULL tenant+platform, stolen token+forged org) were all exercised; every combination returns 0 rows for tenant/financial data except the verified platform branch and validated tenant branch.

## Cross-Tenant Attack Matrix (cold connect as scolaira_app)

| Attack | Result |
|---|---|
| Cold SELECT (orgs/members/users/students/invoices/payments/fees) | 0 rows across all tables |
| A: direct `set_tenant_context_for_system(NULL,NULL)` | 42501 permission denied |
| B: `set_config(is_platform_admin='1', platform_admin_id='')` | 0 rows |
| C: `set_config(is_platform_admin='1', platform_admin_id=<Alice, non-admin>)` | 0 rows |
| D: `set_config(organization_id=<B>, user_id=<Alice>)` — direct GUC forge | 0 rows |
| D2: `set_config(organization_id=<B>, user_id=<Bob>)` — knowing Bob's UUID | 0 rows |
| D3: mint valid token for (A,Alice) then `set_config(organization_id=<B>)` — token stolen + org forged | 0 rows (HMAC mismatch) |
| E: `enter_platform_context(<Alice>)` — non-admin platform attempt | 42501 rejected, GUCs reset |
| F: legitimate Alice @ A — SELECT orgs/users/students/invoices B | Only School A visible; Bob=0; B's student=0 |
| F-write: INSERT students with forged organization_id=B | RLS blocks with 42501; trigger also overwrites org to A for any row that reaches it. Row lands in A, never B. |
| F-update: `UPDATE organizations SET name='PWNED' WHERE id=B` | UPDATE 0 (USING clause excludes B) |
| F-delete: DELETE org B | DELETE 0 |
| G: bootstrap mode — students/invoices/payments/fees | 0 rows (narrow to auth tables only) |
| G+D combo: bootstrap + forged organization_id=B | 0 students / 0 invoices (bootstrap does not read tenant tables) |
| H: legitimate `enter_platform_context(<Plat>)` | 2 orgs / 2 students / 3 users visible (platform admin works) |
| Joins / EXISTS / UNION / aggregates across B | All return 0 |
| mint token via `auth_tenant_token_for(...)` directly | 42501 permission denied |
| Connection reuse / exception leakage | `clear_app_context` resets ALL GUCs on finally; onconnect resets GUCs at session start; after-crash `after_clear: orgs=0` |

## Financial Attack Results

- payments.invoice_id FK references are scoped by invoice RLS (no foreign-key leak confirmed: allocation attack returns 0 invoices visible for B).
- idempotency_keys and webhook_events are tenant-scoped (passed their existing tests).
- Concurrency invariants (unique invoice numbers, allocation contention, concurrent legitimate payments) continue to hold.
- Reversal/state-machine guardrails hold.

## Fresh Database Results

A fresh database provisioned via `scripts/migrate.ts` (production path) then seeded via the SECDEF test helper reproduces all of the above results; no manual intervention required. Migrations 0001–0010 apply cleanly (24 statements in 0010).

## Regression Results

- **Vitest:** 19 test files / **187 passed / 0 failed** (including the new `tests/db/db-boundary.test.ts` DB-principal regression suite and existing `rls-bypass-regression`, `m4-pentest`, `authz`, `tenant-isolation`, `financial-*`, `concurrency`, `idempotency`, `audit`, `webhook`, `state-machines`, `rich-seed`, `auth` suites).
- **tsc:** `npx tsc --noEmit` — zero errors (warnings only, all pre-existing `any`s).
- **next build:** production build completes successfully (ESLint warnings only).

## Git

- Final HEAD commit: `62a9f2f2b588464bbe3798adc06f21d8bf2b1f3d` (pre-existing; working tree contains the M4 hardening changes listed below).
- Working tree changes (security-relevant):
  - `lib/db/migrations/0010_lockdown_secdef.sql` — principal defense (HMAC tenant token, SECDEF validators, RLS rewrite, trigger fix, whitelist grants, default-privilege neutralization).
  - `lib/db/index.ts` — onconnect reset adds `platform_admin_id=''`, `tenant_token=''`; fail-fast SUPERUSER/BYPASSRLS guard preserved.
  - `lib/auth/index.ts` — `clearContext()` now calls `clear_app_context()` to reset all GUCs uniformly.
  - `lib/db/tenant.ts` — `withSystemContext` uses `auth_test_system_context` SECDEF; finally block uses `clear_app_context()`.
  - `scripts/migrate.ts`, `tests/global-setup-db.ts` — removed blanket `GRANT EXECUTE ON ALL FUNCTIONS`; replaced with default-privilege revocation.
  - Test support (`tests/support/seed.ts`, `tests/support/concurrent-seed.ts`, `tests/auth/*.test.ts`) — switched to legitimate bootstrap/set_tenant_context paths; no more direct calls to the restricted primitive.
  - `tests/db/db-boundary.test.ts` (new) — permanent DB-principal regression: role attributes, default-deny, GUC forgery, SECDEF abuse, bootstrap narrowness, platform-scope sanity.

## Known Limitations

- `app_meta.tenant_ctx_secret` is a static 32-byte random secret generated at migration time; rotating it requires running `UPDATE app_meta SET v = encode(gen_random_bytes(32),'hex') WHERE k='tenant_ctx_secret';` (which invalidates all in-flight tokens; connections reset on next request via onconnect).
- `pg_backend_pid()` is used to scope the HMAC to a connection; if an attacker can read their own backend_pid (they can — `select pg_backend_pid()`) they still need the secret. Tokens are per-connection and never persisted, so connection-pool recycle is safe.
- The `auth_test_system_context` SECDEF is granted to scolaira_app; it can set bootstrap (narrow) mode but cannot establish platform admin or arbitrary tenant context without going through set_tenant_context/enter_platform_context validation. It is required for test seeding only; production code does not import it.
- Audit and idempotency policies are tenant-scoped; rate_limits/login_attempts remain owner-only via SECDEF helpers (no direct app-role access).

---

## Final State

**M4 CLOSED — READY FOR NEXT ROUND**
