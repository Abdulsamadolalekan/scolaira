# SCOLAIRA M9 CLOSEOUT REPORT — CONTROLLED ACADEMIC CONTROL LAYER

**Date:** 2026-09-21 (Africa/Lagos)
**Status:** Implemented and verified against the real migrated PostgreSQL database
**Final implementation commit:** `ce4b9230e60f15dbc0cca1e8c5d6ecc25e2a6b7e`

## 1. Executive result

M9 is implemented as the controlled academic layer feeding the frozen M8 billing boundary.

The shipped workflow is:

```text
academic session
  → planned terms
  → explicit current session/term activation
  → classes
  → student identity
  → term-specific enrollment
  → roster and billing-readiness exceptions
  → explicit M8 fee setup and bill preview/billing
```

Academic mutations do not create, alter, void, allocate, reverse, refund, receipt, or otherwise reinterpret financial records. M8 remains the explicit financial boundary. Academic readiness links to the existing fee-setup and billing surfaces rather than silently issuing obligations.

M5, M6, M7, and M8 remain frozen. M8 remains at `9989e63` with tag `m8-controlled-term-billing`. The M8 migration `0020_term_billing.sql` was not modified. The existing, explicitly retained `app/api/receipts/route.ts` uniqueness-race replay hardening is a narrow M9 compatibility change; the final tree is not described as untouched M8 source.

## 2. Frozen history and implementation boundary

- M5: `0c66618e29e6179c80052a82c40f669979cef6b0` — unchanged.
- M6: `36688546…` — unchanged.
- M7: `86beba9` — unchanged.
- M8: `9989e63`, tag `m8-controlled-term-billing` — unchanged as a milestone boundary.
- M9 implementation: `ce4b9230e60f15dbc0cca1e8c5d6ecc25e2a6b7e`.

The M9 implementation commit contains the forward migrations, repositories, authorized routes, academic workspace, test evidence, preflight/reconnaissance artifacts, and the narrow runtime/test-harness changes needed to retain the frozen security boundary during verification.

## 3. Delivered capability

### 3.1 Academic control and roster workflow

- Session list/create/edit and explicit activation, with one current session per organization.
- Term list/create/edit and explicit activation, with one current term per organization.
- Class create/edit/archive/restore; archived classes are excluded from ordinary enrollment selectors.
- Student identity remains separate from enrollment and class. The authoritative term relationship remains `(student_id, term_id)`.
- Atomic new-student plus initial term enrollment when requested.
- Existing-student enrollment, roster read, student enrollment history, pre-billing class transfer, and leave/withdrawal.
- Student archive/restore behavior closes permissible open-term enrollments without resurrecting historical term assignments on restore.
- Billing-readiness reporting for active population, inactive students, archived classes, missing enrollment, missing fee coverage, and M8 exception states.
- Academic workspace navigation and explicit links to `/settings/fees` and `/terms/[id]/bill`.
- The M8 bill-review exception/no-cohort links return to the academic workspace with the selected `termId`.

### 3.2 Database protections

Forward migrations `0021_academic_roster_control.sql` and `0022_m9_tenant_guard_order.sql` add or preserve:

- partial uniqueness for one current session and one current term per organization;
- partial uniqueness for at most one `ISSUED` receipt per payment, while allowing `VOID` → reissue;
- valid session, term, and enrollment date intervals;
- same-organization guards for terms, student-guardian links, fee assignments, and enrollments;
- future `enrolled_on` rejection;
- no active enrollment for inactive students or archived classes in open/billable terms;
- archive protection for classes carrying active open-term enrollments;
- billed/closed-term enrollment-delete protection;
- runtime-role `DELETE` denial on `class_enrollments`;
- trigger ordering so tenant auto-stamping precedes M9 cross-tenant guards.

No migration deletes, merges, rewrites, or financially reinterprets existing rows. The required preflight ran before applying M9 migrations.

### 3.3 Authorization, CSRF, audit, tenant isolation, and idempotency

- All M9 HTTP mutations use the centralized `withAuthorizedRoute` boundary.
- `OWNER` and `SCHOOL_ADMIN` receive academic management actions; `FINANCE_OFFICER` receives roster/read access but not academic management.
- Organization context comes from the authenticated tenant context. No M9 route trusts a client-supplied organization ID.
- State-changing routes require the existing CSRF boundary.
- M9 mutations record audit events with before/after data where applicable.
- New M9 mutation paths require an `Idempotency-Key`. The compatibility path remains optional only for pre-existing M5–M8 mutation callers whose frozen tests and integrations do not send keys; an initial-enrollment student create requires a key.
- Keyed requests are scoped by organization/user, scope, method, path, and request hash. Reuse with a different request shape returns `409 IDEMPOTENCY_KEY_REUSED`; concurrent same-key calls serialize and replay the durable winner.
- Missing-key enforcement is covered by a route test and returns `400` before an untracked M9 class mutation can proceed.

## 4. Database preflight and migration evidence

The preflight report is retained at `M9_PREFLIGHT_REPORT.md`. Against a throwaway database containing migrations `0000`–`0020`, all preflight violation counts were zero:

```text
duplicate_current_sessions|0
duplicate_current_terms|0
cross_tenant_terms|0
cross_tenant_enrollments|0
cross_tenant_guardians|0
cross_tenant_fee_assignments|0
invalid_enrollment_dates|0
future_enrollment_dates|0
active_inactive_enrollments|0
active_archived_class_enrollments|0
duplicate_issued_receipts|0
```

Migration evidence:

- Fresh test-database setup applied all 22 migrations in order, including `0021` and `0022`; the existing numeric `0004` gap remains an intentional historical gap.
- Upgrade verification applied `0021` and `0022` to the preflight database: `new=2 total=22`.
- A clean local `scolaira` database was migrated with `npm run db:migrate`: `new=22 total=22`.
- A subsequent idempotent migration run returned `new=0 total=22`.
- No migration path emitted an M9 failure. Existing migration `NOTICE` output and `01007` privilege notices were non-fatal baseline migration messages.

## 5. Direct migrated-database security audit

The audit was executed with the PostgreSQL owner against the real migrated `scolaira_test` database after the test migration setup.

Runtime-role attributes:

```text
scolaira_app | f | f | f | f | f
```

The columns are `rolsuper`, `rolinherit`, `rolcreaterole`, `rolcreatedb`, and `rolbypassrls`. `scolaira_app` therefore remains `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, and `NOBYPASSRLS`.

The audited academic and control tables all returned `relrowsecurity=t` and `relforcerowsecurity=t`:

```text
academic_sessions
class_enrollments
classes
fee_assignments
guardians
idempotency_keys
receipts
student_guardians
students
terms
```

Required database objects were present:

```text
m9_academic_sessions_one_current_idx
m9_terms_one_current_idx
m9_receipts_payment_issued_unique_idx
m9_academic_sessions_dates_valid
m9_terms_dates_valid
m9_class_enrollments_dates_valid
class_enrollments_unique_idx (student_id, term_id)
m9_terms_tenant_guard / z_m9_terms_tenant_guard
m9_student_guardians_tenant_guard / z_m9_student_guardians_tenant_guard
m9_fee_assignment_tenant_guard
m9_enrollment_integrity_guard
m9_student_status_enrollment_guard
m9_class_archive_guard
m9_enrollment_delete_guard
```

`has_table_privilege('scolaira_app', 'public.class_enrollments', 'DELETE')` returned `f`.

The receipt index definition was verified as:

```text
CREATE UNIQUE INDEX m9_receipts_payment_issued_unique_idx
ON public.receipts USING btree (payment_id)
WHERE (status = 'ISSUED'::receipt_status)
```

## 6. Verification results

### 6.1 Full regression and M9 route/database evidence

Final environment-loaded full Vitest execution:

```text
Test Files  26 passed (26)
Tests       251 passed (251)
```

The integration project alone passed:

```text
Test Files  22 passed (22)
Tests       221 passed (221)
```

M9-specific results in the final run:

- `tests/auth/m9-academic.test.ts`: `1/1` passed — route-driven session → term → class → student → enrollment → roster workflow, authorization, CSRF, durable replay, audit, and financial side-effect checks.
- `tests/db/m9-academic.test.ts`: `3/3` passed — tenant-safe academic references, transition guards, billed/closed protections, and receipt partial uniqueness.
- `tests/db/m9-idempotency.test.ts`: `1/1` passed — concurrent same-key serialization, committed replay, request-shape mismatch rejection, and durable-row verification.
- The final full run therefore reconfirmed the frozen M5–M8 regression suite as part of the `26/251` result.

The route workflow observed zero financial side effects after academic admission/enrollment:

```text
invoices: 0
payments: 0
receipts: 0
```

The clean-database concurrent M8 verifier passed after the identity bootstrap correction:

```json
{"migrated":{"applied":22,"total":22},"concurrentResults":[{"createdInvoices":0,"unchanged":1},{"createdInvoices":1,"unchanged":0}],"invariant":{"invoices":1,"lines":1,"status":"BILLED","billed":true}}
```

### 6.2 Static/build checks

- `npm run typecheck` → **PASS** (`tsc --noEmit`).
- `npm run build` → **PASS**; the dynamic academic and M9 API routes compiled successfully.
- `git diff --check` → **PASS** before closeout documentation.

### 6.3 Transaction-warning boundary

The full frozen regression output still contains the known legacy auth-harness warnings: 35 occurrences of PostgreSQL `25001` (“already a transaction in progress”) and 35 occurrences of `25P01` (“no transaction in progress”). They arise from committed setup combined with the frozen M5–M8 route harness’s outer transaction behavior; all affected tests pass.

M9 route verification opts into local savepoint transactions only for its isolated workflow test. The M9 route test itself passed without those transaction warnings. The harness change is opt-in and does not globally replace the frozen M5–M8 transaction behavior.

## 7. Scope and security review

The final implementation scope is limited to:

- forward academic schema/integrity migrations;
- session, term, class, student-enrollment, roster, and readiness routes/repositories;
- the academic workspace and M8 handoff links;
- centralized permission additions for roster/enrollment operations;
- required-key M9 idempotency and route-boundary tests;
- receipt uniqueness-race replay compatibility;
- migration/runtime privilege reapplication for `class_enrollments`;
- M9 preflight, reconnaissance, concurrency, and closeout evidence.

No public academic endpoint was added. Public payment-link and submit/payment boundaries remain unchanged. No bank import, automatic allocation, wallet, carry-forward, guardian portal, provider integration, reminder redesign, or reporting expansion was introduced.

No customer research, production usage analytics, live school-data audit, handset/network drill, backup/restore drill, or provider settlement test was available. Those are explicitly not claimed as verified by this repository execution.

## 8. Closeout

M9 is ready as a controlled academic control layer on top of the frozen M8 financial boundary. The exact final implementation commit is:

```text
ce4b9230e60f15dbc0cca1e8c5d6ecc25e2a6b7e
```

This closeout report is the post-verification documentation artifact for that implementation commit. The working tree should be rechecked clean after the authorized closeout-documentation commit.
