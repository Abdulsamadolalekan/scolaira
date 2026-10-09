# SCOLAIRA M8 CLOSEOUT REPORT — CONTROLLED TERM BILLING

Date: 2026-09-20 (Africa/Lagos)

## 1. Executive result

M8 is implemented and verified as the controlled creation path for term obligations.

The shipped path is:

```text
fee definitions
  → term/class or school-wide assignments
  → server-computed preview
  → review-time concessions
  → one transactional bill/top-up operation
  → ordinary ISSUED invoices and invoice_lines
  → BILLED term state
  → existing debtors/dashboard/payment/allocation/receipt/audit truth
```

M8 does not create a batch ledger. The financial objects produced are the same ordinary invoices and invoice lines used by the pre-existing one-student invoice path.

## 2. Frozen history and implementation commits

- M5 remains frozen at `0c66618e29e6179c80052a82c40f669979cef6b0`.
- M6 remains frozen at `36688546…` (unchanged).
- M7 remains frozen at `86beba9` (unchanged).
- M8 reconnaissance was committed at `bddff42`.
- Database invariant resolution was committed at `30f9047` (`M8_DATABASE_INVARIANTS.md`).
- Controlled billing implementation was committed at `f15f788`.
- Adversarial route/database suite was committed at `14f5710`.
- Final review-data-effect cleanup was committed at `7ea2a17`.

No prior milestone commit was amended or rewritten.

## 3. Exact database state

Migration `0020_term_billing.sql` is present and applied.

Executed migration verification:

```text
scolaira_test: fresh migration chain 0000 → 0020, 20 migrations applied
scolaira:      npm run db:migrate, new=0, total=20
latest tag:    0020_term_billing
```

The migration adds and enforces:

- `fee_definitions.default_amount_kobo`;
- `terms.billed_at` and `terms.billed_by`;
- signed `invoice_lines.adjustment_kobo` for concession effects;
- `invoice_lines.billing_student_id` and `billing_term_id`;
- unique database billing key `(organization_id, billing_student_id, billing_term_id, fee_assignment_id)` for fee-backed lines;
- one school-wide assignment per fee definition/term;
- immutable `waivers` with fixed reason enum, positive magnitude, approver, RLS, and immutable triggers;
- term/enrollment/fee-assignment structural locks;
- term billing-state consistency check;
- RLS and FORCE RLS on `waivers` (existing tenant tables remain RLS + FORCE RLS).

The unique billing key is the database-level duplicate guard. A parent-invoice join cannot be used in a PostgreSQL unique index, so the two denormalized guard columns are trigger-proven to match the parent invoice and fee assignment before the unique index can be satisfied.

## 4. Product surface shipped

### Fee configuration

- `GET/POST /api/fee-definitions`;
- `PATCH /api/fee-definitions/[id]`;
- `GET/PUT /api/terms/[id]/fee-assignments`;
- `/settings/fees` responsive fee-definition and term-assignment surface.

`fee_definition.manage` and `fee_assignment.manage` were reused; they were not recreated.

### Controlled billing

- `GET /api/terms/[id]/bill-preview` — read-only review, available to term readers;
- `POST /api/terms/[id]/bill` — CSRF/authz/tenant-gated commit, `term.bill` only;
- `/terms/[id]/bill` — mobile-friendly review surface with cohort exceptions, fee explanations, totals, due dates, concession entry, and confirm-before-issue flow;
- Dashboard and Debtors callouts when the current ACTIVE term is not yet billed;
- invoice detail “Copy payment link” affordance reusing the existing payment-link API.

The single-student invoice path remains unchanged for legitimate ad-hoc charges.

## 5. Authorization and security verification

Only the new `term.bill` capability was added to the existing matrix:

- OWNER: allowed;
- FINANCE_OFFICER: allowed;
- SCHOOL_ADMIN: can configure and review, but cannot commit term billing;
- STAFF: denied;
- platform support mode: denied because it is read-only.

Executed route adversarial tests proved:

- unauthenticated bill POST → `401`;
- missing CSRF on bill POST → `403`;
- SCHOOL_ADMIN configuration/review succeeds but bill POST → `403`;
- FINANCE_OFFICER bill succeeds;
- repeated bill request creates zero additional invoices;
- cross-tenant fee listing is empty and cross-tenant term preview/bill returns `404`;
- billed invoices appear through the existing Debtors and Dashboard endpoints;
- no new public route or public/RLS boundary was introduced;
- no new SECURITY DEFINER function was added by M8.

The runtime role verification returned:

```text
scolaira_app | rolsuper=false | rolinherit=false | rolcreaterole=false | rolcreatedb=false | rolbypassrls=false
```

For the new immutable table, runtime privileges were verified as:

```text
waivers: SELECT=true | INSERT=true | UPDATE=false | DELETE=false | TRUNCATE=false
```

## 6. Financial and lifecycle verification

Executed M8 database tests proved:

- PLANNED rejection;
- ACTIVE billing;
- BILLED retry with zero duplicate invoices;
- post-billing enrolment top-up;
- CLOSED rejection;
- empty enrollment rejection without a false BILLED transition;
- no-active-fee rejection;
- incomplete cohort rejection;
- database `23505` duplicate-key protection for the same student/term/fee assignment;
- class-specific fee applicability and school-wide applicability through the preview query;
- concession cap, positive invoice-total rule, signed line adjustment, waiver reason/approver persistence, and immutable waiver mutation rejection;
- negative fee-backed adjustment without a waiver rejected at the DRAFT → ISSUED boundary;
- ordinary invoice total/line total behavior;
- post-billing invoice payment allocation;
- receipt issuance against the allocation;
- tenant RLS hiding invoice lines and waivers from the other school;
- batch and per-invoice audit events.

The separately executed two-runtime-connection concurrency harness proved:

```text
concurrentResults: [{ createdInvoices: 1, unchanged: 0 },
                    { createdInvoices: 0, unchanged: 1 }]
invariant:         { invoices: 1, lines: 1, status: "BILLED", billed: true }
```

That harness migrated a throwaway database from 0000 through 0020 and ran two real `scolaira_app` bill transactions concurrently. The throwaway database was dropped afterward, and `scolaira_owner` was restored to `NOBYPASSRLS`.

## 7. Test execution results

Final complete Vitest execution:

```text
Test Files: 23 passed (23)
Tests:      246 passed (246)
```

Breakdown:

- existing M5/M6/M7 regression suite: `232/232` passed unchanged;
- `tests/db/m8-term-billing.test.ts`: `9/9` passed;
- `tests/auth/m8-term-billing.test.ts`: `5/5` passed.

The final run was executed against the real migrated PostgreSQL test database under the runtime role. A prior combined invocation exposed one non-repeatable auth-harness timing failure; the isolated auth file and the subsequent complete run both passed, with the final complete run recorded above.

## 8. TypeScript, build, and migration commands

- `npm run typecheck` → **PASS** (`tsc --noEmit`).
- `npm run build` → **PASS**. New dynamic routes appeared for fee setup, bill preview, fee APIs, and bill API. Next lint emitted the repository’s existing non-blocking `any` warnings plus no build errors.
- `npm run db:migrate` → **PASS**, `new=0 total=20` on the already-migrated development database.
- Fresh test database migration → **PASS**, all 20 migration files applied in order.
- `git diff --check` → **PASS**.

The `db:migrate` package script now points to the repository’s standalone migration runner (`scripts/migrate.ts`), which is the path that loads migration environment variables correctly in CLI execution.

## 9. Git scope review

The final diff was reviewed for accidental scope. Changes are limited to:

- migration/schema/repository support for controlled term billing;
- one new authorization capability;
- fee-definition/assignment APIs;
- bill preview/commit APIs;
- fee setup and bill review UI;
- dashboard/debtor billing-awareness callouts;
- the small invoice payment-link affordance;
- M8 adversarial verification and the concurrency harness;
- authorization matrix and M8 closeout/invariant documentation;
- migration-runner privilege hardening needed to retain the append-only waiver boundary after broad bootstrap grants.

No bank import, smart allocation, wallet, carry-forward, guardian portal, provider integration, reporting expansion, public payment boundary, or unrelated student-management surface was introduced.

## 10. Known unverified real-world items

The following are not claimed as verified by this repository execution:

- live school data quality and real bursar workflow timing;
- real Android handset/network performance under Nigerian carrier conditions;
- provider/bank settlement behavior and live payment rails;
- backup/restore and disaster-recovery drills;
- production-scale cohort sizes beyond the tested relational behavior;
- field validation of class-specific override conventions and concession approval policy.

These are explicitly real-world follow-ups, not hidden assumptions in the financial contract.

## 11. Freeze condition

M8 is ready to freeze after this report is committed, the working tree is rechecked clean, and the annotated tag `m8-controlled-term-billing` is created on the closeout commit. The tag is the release boundary for M8; subsequent work must build forward rather than amend this history.
