# M4 Security Test Results

**Verdict: PASS** (Executive Security Gate §23)

## Hardening Summary

After a critical finding that the prior M4 PASS was invalid (the runtime DB
principal was SUPERUSER/BYPASSRLS, silently disabling RLS), the DB principal
model was rebuilt from scratch as three clean roles:

| Role | Attributes | Used by |
|---|---|---|
| `postgres` | SUPERUSER, BYPASSRLS | `scripts/provision-db.sh` only (one-time provisioning) |
| `scolaira_owner` | NOSUPERUSER, NOBYPASSRLS, CREATEDB, CREATEROLE | Migrations & test bootstrap via `DATABASE_MIGRATION_URL` |
| `scolaira_app` | NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOINHERIT | Every HTTP request via `DATABASE_URL`; RLS enforced |

`lib/db/index.ts` onconnect hook FAIL-FASTS if `rolsuper` or `rolbypassrls` is
true for the runtime role, and resets all `app.*` GUCs to known-clean values
before each query begins.

## RLS coverage

- 29/29 public tables have `FORCE ROW LEVEL SECURITY` enabled.
- Tenant tables use `organization_id = app.organization_id` policies, with an
  additional `OR app.is_platform_admin = '1'` clause gated behind SECURITY
  DEFINER helpers (`set_tenant_context_for_system`, `enter_platform_context`).
- Non-tenant auth tables (`rate_limits`, `login_attempts`) are owned by
  `scolaira_owner` and only accessible to `scolaira_app` via SECURITY DEFINER
  helpers (`auth_rate_limit_hit`, `auth_record_login_attempt`,
  `auth_clear_rate_limits`).
- `set_tenant_context()` briefly lifts to platform-admin scope (within a
  SECURITY DEFINER function) only to validate ACTIVE membership, then
  immediately drops back to tenant scope with `is_platform_admin='0'`. It
  raises `insufficient_privilege` for non-members.
- `users` table SELECT policy allows reading co-members of the current
  organization (required for member listings / invite lookups). Writes remain
  self-or-platform-only.

## Test results

- **168/168 tests passing** across 17 test files (zero flaky/skipped failures):
  - `tests/auth/auth.test.ts` (24) — M3 auth red-team (argon2, session hashing, CSRF, rate-limits, reset tokens, expiry rejection, race-free password reset)
  - `tests/auth/authz.test.ts` (29) — OWNER/SCHOOL_ADMIN/FINANCE_OFFICER/STAFF matrix, member suspend/revoke/role-change rules, ownership transfer round-trip, exactly-one-OWNER invariant, foreign-org isolation, select-organization boundary
  - `tests/auth/m4-pentest.test.ts` (15) — adversarial P1–P16: forged orgId/role/isPlatformAdmin, CSRF, cross-tenant reads, unsigned-cookie switching, interleaved A/B isolation, SCHOOL_ADMIN cannot touch OWNER, DB-level partial unique index, anonymous denial, foreign-member 404/403, set_tenant_context rejects non-members
  - `tests/auth/runtime-role-safety.test.ts` (2) — runtime user=`scolaira_app` + rolsuper=f + rolbypassrls=f; onconnect GUC reset
  - `tests/db/tenant-isolation.test.ts` (10) — cross-tenant RLS read/write
  - `tests/db/financial-attacks.test.ts` (14) — M2 financial invariants preserved under RLS
  - `tests/db/state-machines.test.ts` (11) — invoice/payment/receipt/reversal state machines
  - `tests/db/financial-invariants.test.ts` (7) — payment allocation/balance invariants
  - `tests/db/concurrency.test.ts` (3) — concurrent double-spend / double-consume attempts
  - `tests/db/audit.test.ts` (7) — audit_event writes
  - `tests/db/webhook.test.ts` (7) — webhook idempotency
  - `tests/db/rich-seed.test.ts` (4) — seed script
  - `tests/db/idempotency.test.ts` (5) — idempotency keys
- **tsc**: clean, zero errors.
- **next build**: succeeds (warnings are pre-existing lint-level, not errors).

## Files touched this session

- `lib/db/index.ts` — simplified; direct connect as `scolaira_app`; fail-fast SUPERUSER/BYPASSRLS guard; GUC reset
- `lib/db/migrations/0007_rate_limits_rls.sql` — rate_limits / login_attempts owner-only RLS policies; SECURITY DEFINER `auth_record_login_attempt`
- `lib/db/migrations/0008_sysctx_rls.sql` — system/platform-context carve-out on all tenant tables; users co-member read policy; fixed `set_tenant_context` bootstrap; `auth_enter_system_context` wrapper for app role
- `lib/db/migrations/0009_test_helpers.sql` — `auth_clear_rate_limits` SECURITY DEFINER helper (test use only)
- `scripts/provision-db.sh` — idempotent 3-role provisioning
- `scripts/apply-migrations.ts`, `scripts/migrate.ts` — deterministic file-order migration runner (replaced drizzle-kit migrator which silently ignored SQL without snapshots)
- `tests/global-setup-db.ts` — connects as `scolaira_owner` to create schema & apply migrations, grants to `scolaira_app`
- `.env.local`, `.env.test` — DATABASE_URL/DATABASE_MIGRATION_URL split
- `app/api/auth/select-organization/route.ts` — enters system context before cross-org membership lookup
- `lib/auth/index.ts` — uses `auth_enter_system_context()` wrapper instead of calling owner-only `set_tenant_context_for_system` directly; uses `auth_record_login_attempt` SECURITY DEFINER for login audit writes
- `tests/auth/runtime-role-safety.test.ts` — new regression test for runtime principal invariants
- Several existing tests updated to enter system context via SECURITY DEFINER helpers before direct-DB assertions that span tenants.
