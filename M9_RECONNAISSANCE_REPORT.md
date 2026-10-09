# SCOLAIRA M9 Reconnaissance Report

**Date:** 2026-09-20
**Mode:** Reconnaissance only
**Recommended capability:** **Academic roster, session/term, and enrollment control** (academic readiness)
**Frozen baseline:** M8 at `9989e63` (`m8-controlled-term-billing`)

## 1. Executive finding

M8 made term billing controlled and repeatable, but it did not make the academic population that billing consumes maintainable by a real school. The billing path requires an active term, classes, active students, and term-specific `class_enrollments`. The database contains that model and the M8 billing code reads it correctly. Production, however, has no usable path to create academic sessions, terms, or classes, or to enroll, transfer, or leave a student.

The only current ways to create the required academic rows are direct database setup used by tests or the non-production-only `POST /api/setup/seed-current-term` helper. `GET /api/classes` and `GET /api/terms` are read-only dropdown endpoints. There is no enrollment repository, enrollment route, roster page, class CRUD page, or academic setup workflow. M8 tests therefore prove that billing works against a database-prepared cohort; they do not prove that a school can prepare or maintain that cohort.

**M9 should build the missing academic control loop, not start with bank import or allocation intelligence.** The capability should let an authorized school operator:

1. create and activate a session and term;
2. create, rename, order, and archive classes;
3. create or maintain students without a false class-link field;
4. enroll a student in one class for a term, change class before billing, and record a leave/withdrawal safely;
5. view roster and billing-readiness exceptions using the same population predicate as M8; and
6. hand the verified population to the existing M8 fee setup, preview, and billing flows without writing financial records implicitly.

This is the next product-critical capability because it unblocks the product's existing obligation-creation path. Reconciliation is a real operational gap, but its current API already supports confirmation and multi-allocation while its UI is merely thin. It cannot compensate for an upstream population that a school cannot maintain. Bank import, heuristic matching, carry-forward, wallet, portal, and reporting expansion were explicitly deferred by M8 and lack field evidence here.

A separate frozen-baseline risk must be carried into M9 planning: receipt issuance is application-idempotent on a read-before-insert path, but the database has no partial unique guard for one `ISSUED` receipt per payment. Two concurrent requests can both pass the pre-check. M9 must not claim preserved receipt correctness without forward-only hardening of that race, either in the M9 migration or as an explicit prerequisite migration. This is not an M8 amendment.

## 2. Scope, evidence, and verification boundary

### 2.1 Frozen constraints

- M5, M6, M7, and M8 remain frozen.
- M8 remains complete at `9989e63`; no M8 file, migration, test, or behavior is changed by this report.
- This report contains no M9 production code, migration, test, route, UI implementation, or commit.
- Any future database hardening described below is a new forward migration after `0020_term_billing.sql`.
- `scolaira_app` must remain least privileged and must remain NOSUPERUSER, NOINHERIT, NOCREATEROLE, NOCREATEDB, and NOBYPASSRLS.

### 2.2 Evidence inspected

The recommendation is derived from the repository and migrated database rather than milestone numbering or invented customer research. The inspection covered:

- academic schema, repositories, routes, seed helper, student routes, and current UI;
- fee definitions and assignments, M8 previews, term billing, waivers, invoices, payments, allocations, reversals/refunds, receipts, debtors, dashboard, reminders, and reconciliation;
- authorization policy, tenant context, RLS, audit, idempotency, state-transition and concurrency triggers;
- migrations `0000_init.sql` through `0020_term_billing.sql` and the deterministic migration runner;
- M8 regression and adversarial tests.

No customer interviews, support-ticket analysis, production usage analytics, school onboarding observations, or external field evidence are available. The finding is therefore a code-dependency finding: it identifies the capability that the frozen product needs in order to execute its current billing promise. It is not a claim about unobserved customer preference.

### 2.3 Verification completed against the frozen baseline

The correctly configured test run loaded `.env.test` and completed **23 test files and 246 tests passed**. `npm run typecheck` passed, `npm run build` passed, and `git diff --check` passed. The build emits existing ESLint warnings, principally `no-explicit-any` and a small number of unused-variable warnings; none were introduced by M9 because no implementation was made.

The first bare test invocation without environment loading failed to import six auth suites because `SCOLAIRA_SESSION_SECRET` was absent. That was a harness invocation issue, not a product result. Re-running with the test environment loaded passed all 246 tests.

The migrated test database was applied through all 20 migration files. The numeric sequence skips `0004`; this is an existing migration-history fact, not a missing applied migration. The runtime-role query returned:

```text
scolaira_app | f | f | f | f | f
```

The columns correspond to the required false values for superuser, inherit, create-role, create-database, and bypass-RLS. The repository was clean before this report was written; no M9 implementation has begun.

## 3. Frozen capability inventory

| Capability | Existing evidence | Operational condition |
|---|---|---|
| Tenant/auth boundary | `lib/db/index.ts`, `lib/authz`, tenant GUC setup, RLS policies, runtime role | Strong foundation. New routes must use the same boundary. |
| Academic sessions | `academic_sessions` table, `academic-sessions.ts` repository, read support through seed/setup internals | Repository create exists, but no production management route or page. |
| Terms | `terms` table, `terms.ts`, `GET /api/terms`, M8 billing and preview | Read-only in production; no create/activate/current/close workflow. |
| Classes | `classes` table and repository, `GET /api/classes` | Read-only list. No class CRUD, archive workflow, or class-management page. |
| Students | Create, read, patch, archive, restore routes and pages | Partial lifecycle only. Enrollment is not connected to student creation or archive/restore. |
| Guardians | Tables and `student_guardians` join table | No production repository, route, or UI for maintaining contacts. |
| Enrollments | `class_enrollments` table, indexes, RLS, M8 lock trigger | No repository or production write path. Tests insert rows directly. |
| Fee definitions/assignments | M8 APIs, repositories, settings page, uniqueness and term-lock triggers | Usable only after terms/classes/enrollments already exist. |
| Bill preview/billing | `/api/terms/[id]/bill-preview`, `/api/terms/[id]/bill`, M8 UI and tests | Financially controlled and authoritative, but reports missing cohort data with no repair workflow. |
| Invoices/waivers | Invoice routes, line guards, waiver table and triggers | Existing ledger truth is strong; M9 must not reimplement it. |
| Payments/allocations | Payment APIs, trigger-maintained balances, allocation repository | Payment entry and allocation exist. Allocation UI handles one invoice at a time. |
| Reversals/refunds | Append-only reversal path and financial triggers | Existing financial correction path; do not make enrollment changes mutate it. |
| Receipts | Issue/read routes, immutable table behavior, receipt number uniqueness | Sequential duplicate prevention exists in code; database concurrency guard is missing. |
| Debtors/reminders | Debtor aggregation, immutable reminder snapshots, reminder routes/UI | Works from invoices and optional guardian data; no academic contact-maintenance path. |
| Reconciliation | `/reconcile`, payment confirmation/allocation/reversal APIs | Read-oriented workbench; no inline actions and no import/matching workflow. |
| Dashboard | Current-term operational aggregates and payment/debtor summaries | Depends on the same term/enrollment data; cannot solve missing academic setup. |
| Audit/idempotency | Append-only audit, idempotency repository used by key financial writes | Must be used for M9 state-changing actions; not every current write has full replay behavior. |
| Public payment boundary | Payment-link view/submit policies and token GUC protections | Must remain isolated from academic management. |

## 4. What the current end-to-end loop can and cannot do

### 4.1 Academic input loop

The database model is more complete than the product workflow:

- `academic_sessions` has name, dates, `is_current`, status, and closure metadata.
- `terms` belongs to a session and has dates, due date, `is_current`, billing status, and closure metadata.
- `classes` has organization, name, arm, sort order, timestamps, and soft-delete fields.
- `students` has organization, school-issued ID, profile, lifecycle status, and archive/withdraw/graduate fields.
- `guardians` and `student_guardians` exist.
- `class_enrollments` connects exactly one student to one class for one term, with enrolled and left dates.

The repositories for sessions, terms, classes, and students are scoped to a tenant, but repository existence is not a production workflow. There is no enrollment repository at all. `app/api/classes/route.ts` is explicitly documented as a thin read endpoint and contains only `GET`. `app/api/terms/route.ts` contains only `GET`. The settings page still describes academic-session and term setup as “Scheduled for M5.”

The seed helper is explicitly a test/development helper. It returns 404 in production and creates only a minimal current session and term. It is not a school setup surface and does not create classes, students, or enrollments.

### 4.2 Student contract mismatch

`POST /api/students` accepts an optional `classId`, but `students` has no `class_id`. The route passes that value through a broad cast to the student repository; the repository inserts only actual student columns. It does not create an `class_enrollments` row. The shipped new-student form does not collect a class. A caller can therefore submit `classId` and receive a successful student creation without an enrollment being created.

This is more than an unfinished feature: it is a misleading API contract. M9 must remove or deprecate the dead field and use an explicit enrollment operation, preferably with an atomic admission service when a new student is created together with an initial term/class assignment.

The archive route blocks a student with open invoices, but otherwise changes only student status and archive fields. It does not close an open enrollment. The restore UI calls the operation “Re-enrol (restore),” although restoring a student does not create a term enrollment. M9 must make this state transition explicit: archive/withdraw should close permissible active enrollments, and restore should not silently recreate a historical enrollment.

### 4.3 Fee setup and M8 billing

Fee setup fetches existing terms and classes and assigns fee definitions. It cannot repair a missing term, class, or enrollment. M8 preview correctly identifies missing active enrollment or missing fee configuration as an exception instead of silently issuing an incorrect bill. That is the right financial behavior, but there is no route from the exception to the data-management action that would resolve it.

The billing repository uses active `class_enrollments`, active students, and fee assignments as its authoritative source. M8 creates invoice lines with a billing key and protects term fee configuration, invoice-line identity, waivers, and top-up behavior with database constraints and triggers. M9 should expose and maintain the inputs; it should not create a parallel roster, duplicate billing predicates, or make enrollment changes create invoices automatically.

M8 supports a billed term receiving a new enrollment so a subsequent explicit bill run can issue a top-up. That behavior is valuable but currently test/database-only for enrollment because no production enrollment write path exists.

### 4.4 Payments, allocations, reversals, and receipts

The payment path records pending or confirmed payments. The allocation path is the only legitimate way to move money onto invoices and relies on database triggers to lock the payment and invoice, enforce available credit and outstanding balance, update `unallocated_kobo`, update `paid_kobo`, and derive invoice status. Reversals are append-only and unwind the affected financial state.

The reconciliation page loads pending payments, unallocated confirmed payments, and open invoices, but has no inline confirmation/allocation controls. Payment detail can allocate, but the displayed form submits one allocation even though the API supports multiple allocations. This is a meaningful future work item, not the primary M9 blocker.

Receipt issuance has a clear intended contract in the route and repository: one active/issued receipt per payment, amount equal to active allocations, and immutable receipt records. The actual database has only:

- unique `(organization_id, receipt_number)`;
- an index on `payment_id`; and
- an index on `student_id`.

There is no partial unique index such as `UNIQUE (payment_id) WHERE status = 'ISSUED'`. The route first selects an issued receipt and then inserts. Concurrent requests can both observe no row and attempt inserts. A forward migration must add the database guard after a duplicate preflight, and the route must treat the unique violation as an idempotent race by re-reading the winning receipt. A voided receipt may still permit a later issued receipt if that is the approved product rule; the unique predicate must therefore be partial, not an unconditional payment uniqueness constraint.

### 4.5 Debtors, reminders, dashboard, and public boundaries

Debtors are derived from invoices, allocations, and optional primary guardian information. Reminder snapshots are immutable and must continue to capture message content at send time. M9 should not send messages or rewrite reminder history as a side effect of roster changes. Guardian CRUD is not required to make the core billing loop correct and should remain a separately decided slice unless the acceptance goal explicitly becomes contact-ready reminders.

The dashboard and debtor views use tenant-scoped financial truth. The current-term dashboard and all-open-debtors workbench are different scopes by design; M9 should label academic term context clearly rather than silently changing reporting semantics.

No new public route is needed. Payment-link view and submit remain the only public boundary. Academic setup, roster, student, and class routes must remain authenticated tenant routes and must never accept organization identity from the client.

## 5. Candidate comparison and decision

| Candidate | Repository evidence | Order decision |
|---|---|---|
| **Academic roster/term control** | Required by M8; schema exists but no production writes, no enrollment repo, no UI; clean tenant cannot reach billable cohort state | **M9: selected. Blocking dependency.** |
| Reconciliation improvement | `/reconcile` is read-oriented and allocation UI is one-at-a-time; APIs and trigger truth already exist | Important, but follows reliable invoice/population creation. |
| Term close/rollover/carry-forward | Term close route and next-term workflow are absent; existing state fields exist | Depends on safe term/session setup and roster operations. Do after M9 or as a narrowly defined follow-on. |
| Guardian/contact management | Tables exist, but no maintenance path; reminder data can be null without falsifying financial truth | Useful, but not required to make billing inputs authoritative. Decide separately. |
| Bank import/automatic matching | Explicitly deferred by M8; no provider or field evidence | Not M9. Avoid premature integration and heuristics. |
| Wallet/credit/carry-forward | Explicitly deferred; would alter payment and term semantics | Not M9. |
| Portal or payment-provider integration | Public payment boundary exists but no need to widen it for roster control | Not M9. |
| Reporting expansion | Derivative of reliable academic and financial data | Not M9. |

The selected capability is the smallest coherent slice that turns M8 from a database-operated feature into a school-operated feature. It is not a claim that reconciliation is unimportant; it is a dependency ordering decision.

## 6. Proposed M9 scope

### 6.1 In scope

#### A. Session and term management

- List all sessions and terms for the active organization.
- Create a planned session and its terms with validated date ranges.
- Activate one session/term under an explicit owner or school-admin action.
- Set and display the current term without allowing multiple current rows for one organization.
- Expose existing lifecycle state and billing state clearly.
- Provide a controlled archive/close action only where the existing state machine and financial consequences are understood. If close/rollover is not accepted in the first build, keep terms read-only after billing and make closure a follow-on action rather than inventing a partial rollover feature.

#### B. Class management

- Create and edit class name, arm, and sort order.
- Archive a class without deleting historical enrollments.
- Exclude archived classes from new-enrollment selectors and ordinary active-class lists.
- Prevent archiving a class with active enrollments in a way that would make the current roster unintelligible; recommend a clear conflict response and transfer/leave path.
- Preserve organization-local uniqueness and do not expose a client-supplied organization ID.

#### C. Student and enrollment control

- Keep existing student profile CRUD, but remove the misleading `classId` contract or replace it with an explicitly named initial-enrollment payload.
- Add term roster list/read operations grouped by class.
- Add enrollment creation with student, term, class, and enrolled date.
- Add a pre-billing class change operation that updates the enrollment rather than making a second row.
- Add a leave/withdraw operation that sets `left_on`; do not hard-delete an enrollment after the term is billed.
- Make archive/withdraw and restore semantics explicit. An archived or withdrawn student must not remain actively enrolled for a future billable population. Restore must require a new enrollment when appropriate, not silently resurrect a prior term assignment.
- Make new-student-plus-initial-enrollment atomic when that combined flow is offered. A student must not be left half-created because the class assignment failed.

#### D. Roster readiness and M8 handoff

- Show active enrollment count by term and class.
- Show students with no enrollment, archived/deleted classes, inactive students with active enrollment, and missing fee assignments as exceptions.
- Use the same definition as M8 for “billable population”: organization-matching enrollment, active student, `left_on IS NULL`, valid class, and selected term.
- Link to existing fee setup and bill preview; do not issue a bill from an enrollment form.
- Explain billed-term behavior: a new enrollment is a top-up candidate and requires an explicit later M8 bill run; an existing billed enrollment cannot be silently moved between classes.

#### E. Forward-only correctness hardening required for the build

- Add a database-enforced one-issued-receipt-per-payment guard and handle its race in the receipt route.
- Add any missing database guards needed to make the new enrollment invariants true under direct SQL through the runtime role, not only through route code.
- Do not weaken or bypass existing M8 financial triggers, RLS, public-link protections, audit, or idempotency.

### 6.2 Deliberately not in scope

- Bank statement import, provider webhooks, automatic allocation heuristics, or bank matching.
- Wallet, credit balances, carry-forward, instalment plans, or cross-term payment policy.
- Parent/student portal, self-service enrollment, public academic endpoints, or login for guardians.
- Teacher assignment, attendance, capacity, timetable, grading, or curriculum management.
- Bulk CSV import unless a later decision supplies field evidence and a complete validation/rollback design.
- External SMS/WhatsApp/email dispatch or changes to reminder snapshots.
- Invoice, allocation, reversal, or receipt redesign beyond the receipt concurrency guard needed for correctness.
- Reporting expansion or a second roster/billing ledger.
- Amending or reopening M8.

## 7. Data model assessment and proposed migration

### 7.1 Reuse the existing authoritative model

The existing academic tables are sufficient for the core M9 slice. Do not introduce a second “current class” field on `students` or a shadow roster table. `class_enrollments` is the historical, term-specific source of truth. A student's current class is derived from the active enrollment for the selected/current term.

The existing unique index on `(student_id, term_id)` already expresses one enrollment record per student per term. It must be preserved. A transfer before billing should update that row; a second insert must not create a competing class. `left_on IS NULL` is the active-enrollment predicate; no redundant `is_active` flag is needed.

### 7.2 Proposed forward migration, subject to preflight

A future migration after `0020_term_billing.sql` should be additive and named according to the next available sequence, currently expected to be `0021_academic_roster_control.sql`. It should be reviewed and executed only when implementation is authorized. It should consider:

1. **Current-row uniqueness.** Add partial unique indexes for one current session per organization and one current term per organization, after a preflight identifies and resolves any existing duplicates. The current schema has ordinary `(organization_id, is_current)` indexes, not uniqueness.
2. **Cross-tenant academic integrity.** Add database checks/triggers so a term and its session, and an enrollment and its student/class/term, all share the same organization. Application `assertResourceInOrg` checks are necessary but insufficient against direct runtime SQL.
3. **Enrollment date validity.** Enforce `left_on IS NULL OR left_on >= enrolled_on` and validate dates against the term range according to the chosen policy. If late enrollment outside term dates is allowed, record that policy in the API rather than relying on an accidental database rejection.
4. **Student/enrollment consistency.** Prevent an active enrollment for an inactive student, or close permissible active enrollments in the same transaction as a student archive/withdrawal. The final choice must work for already billed terms and must not alter issued invoices.
5. **Billed-term deletion lock.** M8's enrollment trigger rejects identity moves in a `BILLED` term and all changes in a `CLOSED` term, but its `DELETE` branch returns the old row for a billed term. A new trigger must forbid deletion once a term is billed; after billing, use `left_on` or an explicit approved correction workflow. After closing, all enrollment mutations remain blocked.
6. **Receipt concurrency guard.** Add a partial unique index on `receipts(payment_id) WHERE status = 'ISSUED'` after a duplicate preflight. The route must catch a unique violation, read the issued row, and return it as the idempotent result. If a production preflight finds duplicates, the migration is blocked until an append-only financial resolution is approved; it must not silently delete receipts.
7. **Indexes for roster reads.** Confirm or add indexes covering organization/term/class and organization/student lookups needed by roster and readiness queries. Do not add an index that creates an alternative billing truth.
8. **Forward safety.** New trigger functions must use a fixed safe search path, fail closed when cross-tenant rows are not visible, and must not be `SECURITY DEFINER` unless a specific need is reviewed. The migration runner must apply it in one transaction using the owner/migration principal, then reapply runtime grants if the migration adds database objects requiring them.

The migration must not alter the frozen M8 migration file. It must not grant the runtime principal superuser, RLS bypass, role creation, database creation, or inherited privileges.

### 7.3 No financial re-materialization

M9 should not store balances on students or enrollments, recalculate invoice totals in application code, issue invoices from roster writes, or create a parallel payment ledger. Invoice totals, paid amounts, unallocated payment amounts, allocation status, reversal effects, receipt state, and dashboard/debtor aggregates remain trigger- and query-derived from existing financial tables.

## 8. Required invariants

### 8.1 Tenant and identity invariants

1. Every M9 mutation runs through `withAuthorizedRoute` or the equivalent approved service boundary.
2. The organization comes only from the authenticated tenant context. Client `organizationId` is rejected or ignored, never trusted.
3. Every resource ID is loaded with organization scope and checked with `assertResourceInOrg`; a foreign resource returns not-found semantics.
4. RLS remains enabled and forced on academic and financial tables. The runtime role remains `scolaira_app` with all five dangerous role attributes false.
5. Platform support remains read-only for tenant academic data; support context cannot create a roster or alter financial state.
6. Academic writes are audited with actor, action, resource, before/after where appropriate, request ID, and term context. Audit rows remain append-only.

### 8.2 Academic invariants

7. There is at most one current session and one current term per organization. A current term belongs to the current/appropriate session according to the selected rollover policy.
8. A term belongs to a session in the same organization. A class, student, and enrollment all belong to the enrollment's organization.
9. One student has at most one enrollment row per term, enforced by the existing unique key.
10. An active enrollment has a valid student, active/non-archived class, valid term, and `left_on IS NULL`. A left enrollment is historical and is not included in the active billing population.
11. `left_on` cannot precede `enrolled_on`. The UI and API must make the date policy visible.
12. A planned term can be configured but cannot be billed. An active term can be enrolled and billed after fee readiness. A billed term allows only the explicitly approved top-up/leave operations. A closed term is immutable.
13. Class changes are allowed before billing only through the existing enrollment row. Class/term/student identity changes inside a billed term are rejected. Enrollment deletion in a billed term is rejected.
14. Student archive/withdraw/graduate behavior cannot leave a hidden active enrollment that will later bill. Restoring a student does not silently recreate a historical class assignment.
15. Archived classes cannot receive new enrollments, while historical rows remain readable.
16. The roster-readiness query and M8 bill-preview query use one shared service/predicate or are proven equivalent. No route reports “ready” using a looser population than billing.

### 8.3 Financial and communication invariants

17. Enrolling, moving, or leaving a student never directly inserts, updates, voids, allocates, reverses, or receipts an invoice/payment.
18. Existing M8 term locks, fee-assignment locks, billing keys, waiver uniqueness, and invoice-line guards remain in force.
19. A newly enrolled student in an already billed term is not silently billed; the operator must run the existing explicit top-up billing action.
20. A receipt is never duplicated for a payment merely because two requests raced. Receipt issuance is protected both by the partial unique database guard and route-level idempotent handling.
21. Payment allocation, reversal/refund, and debtor balances remain derived from existing financial triggers. Roster changes do not rewrite historical invoice or reminder snapshots.
22. Reminder content remains immutable after creation. A future guardian/contact edit may affect a future reminder, not a prior snapshot.

## 9. State machines and cross-domain consequences

| Entity | Existing state/data | M9 behavior required |
|---|---|---|
| Academic session | `PLANNED`, `ACTIVE`, `CLOSED`; current flag and close fields | Create planned; activate explicitly; do not expose arbitrary reopening. If the existing generic transition guard permits a reopen, the route still needs an explicit audited policy. |
| Term | `PLANNED`, `ACTIVE`, `BILLED`, `CLOSED`; `billed` and current flags | Planned is setup-only; active accepts roster and billing; billed is top-up/leave constrained; closed is read-only. Existing M8 billing remains the only billing transition. |
| Class | No enum; soft-delete fields | Active for new enrollment until archived; archive is not physical deletion and must preserve historical billing joins. |
| Student | `ACTIVE`, `ARCHIVED`, `WITHDRAWN`, `GRADUATED` | Profile updates are separate from enrollment state. Inactive students cannot remain in the future active billing population. |
| Enrollment | No status; active means `left_on IS NULL` | Insert, pre-billing class update, and leave. No billed-term delete; no closed-term change. |
| Invoice | `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `VOID` | M9 does not change invoice transitions. M8 owns term billing and line creation. |
| Payment | Pending/confirmed/reversed/refunded and related states | M9 does not change payment transitions or allocation heuristics. |
| Receipt | `ISSUED` or `VOID` | Add database one-issued-per-payment guard; void/reissue policy must be explicit and audited. |

The most important cross-domain rule is that academic state controls what may be billed, but financial state does not get silently rewritten when academic state changes. A pre-billing transfer changes the future billing population. A post-billing leave is a roster fact and must not erase an already issued invoice. A post-billing class move is blocked unless a separately approved correction workflow exists.

## 10. Security and authorization design

The existing permission vocabulary already declares `academic_session.manage`, `term.manage`, `term.read`, `class.manage`, `class.read`, `student.*`, and `guardian.manage`, but those actions are largely dormant because the write surfaces do not exist. M9 should add explicit enrollment/roster permissions rather than treating `term.manage` as a blanket substitute.

Recommended policy:

- **OWNER:** manage sessions, terms, classes, students, enrollments, and the selected academic setup; may bill under existing `term.bill`.
- **SCHOOL_ADMIN:** same academic management scope, except organization-owner operations; may not be granted financial powers merely because they manage a roster unless the existing policy says so.
- **FINANCE_OFFICER:** read students, classes, terms, and roster readiness; may configure fees and bill under existing policy; may not mutate academic structure or enrollment in the first slice.
- **STAFF:** remains denied academic and financial reads under the current baseline unless a later class-scoped role is designed. Do not widen STAFF implicitly.
- **Platform support:** read-only support context only; no academic mutation.

Every unsafe method must receive CSRF protection. Every state change must validate body input with Zod, use tenant-scoped queries, and avoid leaking foreign-resource existence. New routes must not be public and must not share the payment-link token GUC. Audit entries must use the authenticated actor, not a client-supplied `createdBy` or `approvedBy`.

Threats to test explicitly include forged organization IDs, foreign UUIDs, a finance officer attempting roster writes, a staff member reading another tenant's roster, a platform support session mutating data, missing/forged CSRF, malformed dates, inactive or archived class selection, and direct runtime SQL attempts that rely on RLS or database trigger enforcement.

## 11. Idempotency and concurrency design

### 11.1 Idempotency

Use the existing `idempotency_keys` repository and `Idempotency-Key` header for create/activate/leave/transfer writes that can be retried by a browser or client. Store request method/path/hash and response status/body. A repeated key with a different request body must be rejected, not replayed with a changed meaning.

The existing `(organization_id, user_id, key)` uniqueness and duplicate-race handling are suitable as the base, subject to the repository's documented scope-prefix convention. M9 must not invent a second key table. Read operations do not need idempotency keys.

Enrollment uniqueness is a second, domain-level idempotency guard: a retry that submits the same student/term should return the existing operation result when the request key matches, and should return a clear conflict when it attempts a different class without an explicit transfer operation.

### 11.2 Concurrency

- **Current-term activation:** lock the affected organization/session rows in a deterministic order; use the partial unique index as the final race guard. Do not rely only on “unset all current rows, then set one.”
- **Enrollment create:** lock term, then student/class in a consistent order; allow the unique `(student_id, term_id)` constraint to reject a duplicate race and translate it to a domain conflict or idempotent response.
- **Transfer/leave:** lock the enrollment and term; re-read term status after the lock. A billed or closed transition must win over a stale UI request.
- **Class archive:** lock class/term enrollment rows or use a transaction that rechecks active enrollments before archiving. Prevent an archive and enrollment insert from interleaving into an invalid active roster.
- **Billing versus enrollment:** preserve M8's term lock protocol. A bill run locks the term `FOR UPDATE`; enrollment logic must use the same term-first ordering and the existing trigger behavior so an enrollment either commits before the billing snapshot or waits. Never make a route hold locks in the opposite order.
- **Receipt issue:** use the new partial unique index as the database winner. On unique violation, re-read the issued receipt and return it. Do not treat the race as a generic 500.
- **Fee assignment changes:** remain blocked after billing by M8; M9 must not add a bypass from roster UI.

## 12. Proposed API surface

The following is a build plan, not an implementation claim. Existing `GET /api/classes`, `GET /api/terms`, student routes, fee routes, and M8 billing routes should be preserved or evolved compatibly.

| Method/path | Purpose | Permission/state notes |
|---|---|---|
| `GET /api/academic-sessions` | List sessions and terms/summary | `term.read` or dedicated academic read; tenant scoped. |
| `POST /api/academic-sessions` | Create planned session | `academic_session.manage`; idempotency required. |
| `PATCH /api/academic-sessions/[id]` | Edit dates/name before activation | Resource check; immutable/closed fields rejected. |
| `POST /api/academic-sessions/[id]/activate` | Activate/set current session | Explicit action; transaction and unique-current guard. |
| `GET /api/terms` | Existing read endpoint, enriched only as needed | Preserve `term.read`; exclude or label closed terms deliberately. |
| `POST /api/terms` | Create planned term under a session | `term.manage`; validate same-tenant session and date range. |
| `PATCH /api/terms/[id]` | Edit planned term/current metadata | `term.manage`; billed configuration remains frozen. |
| `POST /api/terms/[id]/activate` | Move planned term to active/current | `term.manage`; cannot bypass session/term policy. |
| `GET /api/classes` | Existing list endpoint | Filter archived classes for active selectors and include explicit archived/read mode if needed. |
| `POST /api/classes` | Create class | `class.manage`; idempotency and unique-name conflict. |
| `PATCH /api/classes/[id]` | Rename/reorder/edit class | `class.manage`; billed historical display must remain understandable. |
| `POST /api/classes/[id]/archive` | Soft-archive class | `class.manage`; reject active-roster conflict or require explicit resolution. |
| `GET /api/terms/[id]/roster` | Roster by class plus readiness exceptions | `term.read`/dedicated roster read; same population predicate as M8 preview. |
| `POST /api/terms/[id]/enrollments` | Enroll a student in a class | `enrollment.manage`; term status and class/student checks; idempotency. |
| `PATCH /api/enrollments/[id]` | Pre-billing class/date correction | `enrollment.manage`; identity move blocked after billing. |
| `POST /api/enrollments/[id]/leave` | Set `left_on` | `enrollment.manage`; allowed only under term policy; no delete after billing. |
| `GET /api/students/[id]/enrollments` | Student enrollment history | `student.read`/roster read; tenant scoped. |
| `POST /api/students` | Existing student creation with dead `classId` removed or explicit nested initial enrollment | `student.create`; if nested, one transaction and one audit narrative. |
| Existing `/api/terms/[id]/bill-preview` and `/bill` | Existing M8 handoff | No new implicit billing; preserve `term.read`/`term.bill`, idempotency, and all M8 guards. |

The initial implementation should use service functions shared by the API routes and the server-rendered UI rather than route-specific SQL. No route should call `withTenant` directly outside the approved authorization boundary.

## 13. UI workflow

### 13.1 Guided academic setup

Replace the current placeholder settings experience with a focused academic setup surface for owner/admin users:

1. “Create academic session” with name and date range.
2. “Add terms” with order, date range, due date, and planned status.
3. “Activate current term” with a clear warning that this controls the billable context.
4. “Create classes” with name/arm/order.
5. “Add students and assign roster” or link to the roster page.

The page should show incomplete setup states rather than quietly producing empty dropdowns. It must not expose the development seed helper.

### 13.2 Roster page

The roster page should be term-first and class-grouped. It should provide:

- active class list and enrollment count;
- student search by school ID/name;
- enroll existing student;
- admit new student and assign initial class atomically;
- move before billing;
- leave with date and reason where required;
- historical enrollment visibility;
- exceptions for no enrollment, inactive student, archived class, and missing fee configuration;
- a direct “Review billing” link to M8 preview.

For a billed term, the page should explain that new students are top-up candidates, class changes are restricted, and leaving does not void existing invoices. The UI must not imply that “restore student” means “re-enroll student.”

### 13.3 Student detail and current pages

The student detail page should show the selected/current term and class as enrollment data, not as a mutable student profile field. The student creation form should either collect an optional explicit initial enrollment or route to a post-create enrollment step; it must not submit the current dead `classId` field.

Finance users should see roster and readiness context through read access, but academic mutation controls should be absent rather than merely disabled after rendering. M8 fee setup and bill preview should link back to the missing-data correction surface when an exception is actionable.

## 14. Attack surface and abuse cases

| Area | Attack/failure case | Required outcome |
|---|---|---|
| Tenant isolation | Submit a foreign session, term, class, student, or enrollment UUID | 404/409 as appropriate; no row or existence leak. |
| Organization injection | Send another `organizationId` in JSON | Ignore/reject; context wins. |
| Role escalation | Finance officer or STAFF posts roster mutation | 403; no SQL side effect. |
| CSRF/replay | Re-submit create/activate/leave due to browser retry | CSRF required; idempotency response, no duplicate effect. |
| Duplicate enrollment | Two requests enroll same student/term | One row; other result is conflict or same idempotent result. |
| Concurrent current flag | Two terms activated simultaneously | One winner; unique constraint and transaction leave a consistent state. |
| Billed-term mutation | Change class, delete enrollment, or alter fee assignment after billing | Rejected by route and database; no invoice disappearance. |
| Closed-term mutation | Insert/update/delete roster in closed term | Rejected by database trigger and route. |
| Inactive student | Archive/withdraw then bill or enroll | No active billable enrollment; archive operation closes permitted enrollment or fails clearly. |
| Archived class | Enroll into soft-deleted class | Rejected. Historical rows remain readable. |
| Date manipulation | `left_on` before `enrolled_on`, invalid term/session dates | 400 or database check violation; no partial write. |
| Direct runtime SQL | Bypass UI and write organization-mismatched academic rows | RLS plus cross-tenant trigger fails closed. |
| Receipt race | Two concurrent issue requests for one payment | One ISSUED row; loser re-reads and returns it. |
| Public boundary | Payment-link token used against academic route | Authentication/authorization required; no public academic access. |
| Audit spoofing | Client supplies actor/approver or alters audit record | Server context and database trigger determine actor; audit is append-only. |
| Financial side effects | Roster write attempts to “helpfully” bill or allocate | No financial write outside explicit M8/payment APIs. |

## 15. Regression surface and acceptance tests

M9 must add tests without weakening the existing 23-file/246-test baseline. The most valuable new test is a real route-driven lifecycle that currently cannot exist.

### 15.1 Database and migration tests

- Apply a fresh database from `0000` through the new migration in order, including the existing `0004` numbering gap.
- Assert all academic tables remain RLS-enabled and forced.
- Assert runtime role attributes remain false.
- Assert one current session and term per tenant under concurrent activation.
- Assert cross-tenant session/term/class/student/enrollment combinations fail.
- Assert one student/term enrollment and valid enrollment dates.
- Assert inactive student and archived class cannot receive an active enrollment.
- Assert billed-term class identity changes and deletes fail; leave policy works; closed-term all-mutation failure works.
- Assert preflight detects duplicate current rows and duplicate issued receipts before unique indexes are added.
- Assert the partial issued-receipt index blocks concurrent duplicates and allows the approved void/reissue behavior.
- Assert no M8 invoice, line, payment, allocation, reversal, receipt, waiver, or reminder trigger regresses.

### 15.2 API/authz tests

For every state-changing route:

- anonymous request is 401;
- missing or forged CSRF is 403;
- wrong role is 403;
- foreign resource is not found without leakage;
- malformed UUID, dates, status, and body are 400;
- idempotent retry returns the original result;
- conflicting retry or state transition returns a domain conflict;
- audit event has the authenticated actor and request ID.

### 15.3 End-to-end product test

Starting from a clean organization with no academic rows:

1. owner creates a session and terms;
2. owner activates a term;
3. owner creates classes and students;
4. owner enrolls students through the API/UI;
5. finance user sees the roster but cannot mutate it;
6. owner/finance configures fees using existing M8 routes;
7. bill preview reports ready using the same roster;
8. explicit bill run creates expected invoice/line rows;
9. pre-billing transfer changes future billing class without duplicate enrollment;
10. post-billing new enrollment remains a top-up candidate and requires explicit M8 retry;
11. post-billing leave does not erase the existing invoice;
12. all dashboard/debtor/payment totals remain correct.

This must use production-shaped routes and migrated database state, not direct test SQL for the new capability. Direct SQL remains appropriate for adversarial database-trigger tests.

### 15.4 Existing M8 and financial regression tests

Retain and rerun tests for:

- no duplicate invoice lines on repeated bill;
- term and fee-assignment locks;
- missing enrollment/fee readiness exceptions;
- waiver amount and immutability rules;
- payment allocation and reversal truth;
- public payment-link isolation;
- receipt issue/read/void behavior;
- debtor balances, reminder immutability, and dashboard aggregation;
- audit and tenant isolation.

Add a concurrent receipt issuance test and a concurrent enrollment/billing test. A passing sequential test is not enough for either race.

### 15.5 Release verification

A future implementation closeout must run against the real migrated database, not only mocked repository types:

```text
set -a; . ./.env.test; set +a; npm test -- --reporter=dot
npm run typecheck
npm run build
npm run ...  # project-approved migrated-database verification, when defined
psql ...     # verify runtime-role attributes, RLS/FORCE, indexes, triggers
 git diff --check
```

The exact verification command must be recorded when implementation exists. “VERIFIED” means it executed against the real migrated database.

## 16. Migration and implementation sequence

This sequence is intentionally forward-only and does not reopen M8.

### Phase 0 — preflight and decision record

1. Confirm the recommended M9 scope and role matrix.
2. Query for duplicate current sessions/terms, cross-tenant academic links, invalid enrollment dates, active enrollments on inactive students, and duplicate issued receipts.
3. Decide term date policy, billed-term leave behavior, close/rollover boundary, and whether initial admission is atomic.
4. If duplicate issued receipts exist, stop for an append-only financial resolution before adding the unique guard.

### Phase 1 — database hardening

1. Add the next forward migration for current-row uniqueness, academic tenant/date checks, billed-delete protection, and receipt concurrency protection.
2. Add or confirm roster indexes.
3. Reapply/verify runtime grants without changing the required role attributes.
4. Add database adversarial tests and verify the migration chain from `0000`.

### Phase 2 — repositories and domain service

1. Add an enrollment repository and a transaction-safe roster service.
2. Centralize term-state, class-state, student-state, and enrollment invariants.
3. Centralize the M8-compatible active-population predicate.
4. Add atomic admission/initial-enrollment behavior if selected.
5. Fix the student `classId` contract and archive/restore semantics.

### Phase 3 — authorization and APIs

1. Add explicit enrollment/roster read and manage permissions.
2. Implement session, term, class, roster, enrollment, leave, and student integration routes behind the central authz boundary.
3. Add CSRF, idempotency, request hashes, audit, resource checks, and domain error mapping.
4. Harden the receipt route's unique-race handling in the same forward-only release.

### Phase 4 — UI and M8 handoff

1. Replace placeholder academic settings with the guided setup surface.
2. Add class maintenance and term roster pages.
3. Update student creation/detail/archive flows.
4. Add readiness exceptions and links to existing fee setup/bill preview.
5. Verify finance read-only behavior and no public-route leakage.

### Phase 5 — migrated-database verification and release

1. Run the full route-driven lifecycle from a clean organization.
2. Run concurrent activation, enrollment, billing, and receipt tests.
3. Run the full frozen regression suite, typecheck, build, diff check, and role/RLS/index verification.
4. Review audit events and financial totals before/after roster operations.
5. Commit only after explicit implementation authorization using the required Scolaira commit identity. No commit is made in reconnaissance.

## 17. Open questions and recommended defaults

These questions should be answered before coding, but the repository evidence is sufficient to propose defaults and continue to build once the owner authorizes M9.

1. **Who may activate or close a term?** Recommended default: OWNER and SCHOOL_ADMIN may manage academic state; FINANCE_OFFICER may bill but not activate/close.
2. **Can a term be active without being current?** Recommended default: permit historical active terms only if the product has a clear use; otherwise one current active term per organization and make the restriction explicit.
3. **Are late enrollment dates allowed outside term dates?** Recommended default: allow late admission with `enrolled_on` on/after term start and before close, but document the policy and never infer it from a date cast.
4. **What does a billed-term leave mean financially?** Recommended default: it changes future roster/readiness only and never voids or reduces an issued invoice; any credit/refund is a separate financial action.
5. **Should a billed-term class transfer be supported?** Recommended default: no in M9; require leave/new-term correction or a future audited correction workflow. Preserve M8's existing identity lock.
6. **Should initial student admission and enrollment be one request?** Recommended default: yes when initiated from the roster UI, implemented as one transaction; retain a separate enrollment endpoint for existing students.
7. **Should guardian/contact maintenance be part of M9?** Recommended default: no for the core build. Add it only if the acceptance goal is contact-ready reminders, and do not add external dispatch in that slice.
8. **Should CSV import be included?** Recommended default: no until field evidence and a validation/rollback plan exist. Manual, auditable roster control is the narrower foundation.
9. **When should a term close or next-term rollover ship?** Recommended default: after the setup/roster loop is proven. Do not create a partial carry-forward process that changes payment semantics.
10. **How should existing duplicate receipts be resolved if found?** Recommended default: stop the migration and obtain an append-only financial correction decision; never delete or silently merge issued receipts.

No field evidence is available to settle these product-policy questions. The defaults above are conservative because they preserve existing financial truth and minimize irreversible behavior.

## 18. Readiness decision

The codebase evidence is sufficient to authorize an M9 build of the recommended academic roster/term readiness capability. The scope is narrow, the data model already exists, the financial boundary is clear, the missing production path is demonstrated, and the implementation sequence identifies the required forward-only hardening. The receipt race and academic cross-tenant/billed-delete gaps are explicit build gates rather than reasons to conceal the finding.

The M9 build should begin only after the implementation authorization and preflight decisions above. This reconnaissance report itself makes no code or database change.

READY FOR M9 BUILD
