# SCOLAIRA M11 RECONNAISSANCE

**Date:** 2026-09-21 (Africa/Lagos)
**Mode:** Reconnaissance only
**Repository:** `/home/user/scolaira`
**Branch at inspection:** `main`
**Authoritative starting point:** frozen M10 repository state

This report is evidence-backed reconnaissance for M11. It records the implementation that was inspected, the controls that are already present, the operational gaps that remain, candidate control layers, and one bounded M11 proposal. No M11 production code, migration, test, commit, or tag was created during reconnaissance. The only intended persistent change in this session is this report.

## 1. Frozen baseline and verification

The following was verified before this report was written:

| Check                                | Result                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD`                               | `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`                                                                                                                           |
| M9 tag target                        | `m9-academic-control-layer` -> `791b6e09ad211eac470e6011e28172b1ff925575`                                                                                            |
| M10 tag target                       | `m10-reconciliation-control-plane` -> `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`                                                                                     |
| M10 tag form                         | Annotated tag; dereferenced target equals `HEAD`                                                                                                                     |
| Branch                               | `main`                                                                                                                                                               |
| Working tree at reconnaissance start | Clean: `git status --short --branch` reported `## main` with no file changes                                                                                         |
| SQL migration files                  | 36, `0000_init.sql` through `0036_m10_terminal_linkage_guards.sql`                                                                                                   |
| Migration journal entries            | 36 in `lib/db/migrations/meta/_journal.json`                                                                                                                         |
| Full Vitest baseline                 | 28 files, 262/262 tests passed                                                                                                                                       |
| TypeScript baseline                  | `npm run typecheck` passed                                                                                                                                           |
| Build baseline                       | `npm run build` passed; current invoices, payments, receipts, payment-links, debtors, terms, dashboard, and reconciliation routes built                              |
| Lint baseline                        | `npm run lint` passed with existing non-fatal `any`/unused-variable warnings                                                                                         |
| Accepted browser baseline            | M10 closeout records Playwright 32/32 passed; no M11 implementation was run against or added to this baseline                                                        |
| Real migrated-database M10 baseline  | M10 closeout records replay through migration 0036, fresh/upgrade fixture execution, runtime-role/RLS checks, and the required positive/negative control-plane tests |

The M10 closeout's staging condition remains relevant: the real database verification had no active tenant fixture for the legitimate positive tenant smoke path. A staging environment with one valid tenant membership and one valid platform-support path is still required before production deployment of future work. The earlier empty-variable UUID cast failure was a harness/setup condition, not an M10 financial-integrity finding.

`rg` is not installed in this repository environment. Targeted searches therefore used `git grep`, `grep`, `find`, and direct file inspection.

## 2. Scope and method

The inspection used implementation evidence rather than documentation alone. It covered:

- the request/authentication/CSRF/tenant boundary;
- centralized authorization and audit helpers;
- tenancy, academic, financial, communications, platform, and reconciliation schemas;
- all current `app/api/**/route.ts` files;
- authoritative repositories and services;
- database migrations, triggers, RLS/FORCE RLS, runtime grants, and migration-runner behavior;
- school-facing dashboard, academic, student, debtor, invoice, payment, receipt, payment-link, and reconciliation pages; and
- auth, database-integrity, concurrency, tenancy, M7-M10, and E2E regression evidence.

The comparison below is deliberately unordered. It does not rank candidate layers or declare a candidate winner. The separate proposal section defines one bounded M11 boundary after the evidence review.

## 3. Implemented architecture map

### 3.1 Authentication, tenancy, and authorization

The current trust boundary is:

1. `middleware.ts` performs only a coarse cookie-shape routing check. It does not make the authentication decision.
2. Protected routes call `withAuthorizedRoute` from `lib/authz/index.ts`.
3. `getSession()` in `lib/auth/index.ts` verifies the signed HttpOnly session cookie, hashes the raw session identifier, reads the session and user under system context, checks revocation/expiry/absolute age, loads active organization memberships, and resolves the active organization from a signed/validated organization cookie or session state.
4. Unsafe protected methods require the CSRF double-submit header/cookie check.
5. `authorize()` in `lib/authz/permissions.ts` applies the explicit role/action matrix.
6. `withTenant()` calls the security-definer tenant-context function, which derives organization context from the authenticated active membership and sets the database GUCs. `finally` clears the context.
7. Route handlers use a tenant-scoped database handle and repositories. `assertResourceInOrg()` provides a second resource check and returns not-found semantics for cross-tenant resources.

Current membership roles are `OWNER`, `SCHOOL_ADMIN`, `FINANCE_OFFICER`, and `STAFF`. The first three have financial/debtor/reconciliation capabilities according to the centralized matrix; `STAFF` is intentionally restricted to the dashboard baseline. Platform support is a separate read-only context and is not a tenant membership role.

Relevant implementation: `lib/auth/index.ts`, `lib/auth/cookies.ts`, `lib/authz/index.ts`, `lib/authz/permissions.ts`, `lib/authz/audit.ts`, `middleware.ts`, `lib/db/tenant.ts`, `lib/db/repo/_context.ts`.

### 3.2 Database isolation and runtime principal

The database design provides the following controls:

- tenant tables have organization-scoped policies;
- the relevant tables are RLS-enabled and FORCE RLS-enabled;
- the runtime role is `scolaira_app` and must remain `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, and `NOBYPASSRLS`;
- the tenant context is established by a security-definer function that checks active membership;
- insert triggers derive/overwrite tenant organization context rather than trusting a client organization ID;
- financial tables have restrictive foreign keys and no ordinary financial deletion path;
- audit, reversal, waiver, reminder, and M10 evidence/history records have append-only or restricted lifecycle controls as applicable; and
- the migration runner uses the migration principal/URL separately from the least-privilege runtime connection and applies the journal through one authoritative path.

The M10 migrations additionally harden tenant attribution, authenticated actor attribution, case/candidate linkage, terminal history, and public/platform context behavior. Future M11 migrations must preserve these properties and be forward-only.

### 3.3 Academic and identity model

The academic chain is represented by:

- `organizations`, `users`, `organization_members`;
- `academic_sessions`;
- `terms`;
- `classes`;
- `students`;
- `guardians` and `student_guardians`; and
- `class_enrollments`.

Sessions and terms have `PLANNED`, `ACTIVE`, and `CLOSED`-shaped lifecycle fields; terms also have `BILLED`, `billed_at`, `billed_by`, `closed_at`, and `closed_by` fields. Current routes can create/list/update planned terms and activate sessions/terms, and controlled billing can move an active term to billed. No close-term, close-session, or rollover route was found in the current route inventory. The fields therefore show a prepared lifecycle model, not a completed close/rollover workflow.

Students can be created, read, updated, archived, restored, enrolled, transferred, and left through protected routes. The student profile read path joins invoices and payments to show a financial summary. Guardians exist in the schema and permission matrix, but no standalone `app/api/guardians/**` route was found, and the current student-create body does not create guardian records despite older API/documentation wording suggesting otherwise.

### 3.4 Financial model and control surfaces

The financial chain is:

- fee definitions and term/class fee assignments;
- invoices and invoice lines;
- payments;
- payment allocations;
- receipts;
- reversals with `REVERSAL`, `REFUND`, or `CORRECTION` type; and
- waivers attached to invoice lines for controlled term billing.

Money is integer kobo in `BIGINT` columns. The implementation and database enforce that:

- invoices begin as `DRAFT`;
- invoice lines can be changed only while the invoice is draft;
- `invoices.total_kobo` is maintained from invoice lines;
- `invoices.paid_kobo` is maintained by allocation/reversal effects;
- `payments.unallocated_kobo` is seeded on the first transition to `CONFIRMED` and maintained by allocation/reversal triggers;
- allocation locks and validates the payment and invoice, consumes payment unallocated balance, increases invoice paid balance, and recomputes invoice state;
- reversals are append-only and reverse allocation/payment effects through a trigger; and
- direct financial-column updates and ordinary financial deletes are rejected by trigger/privilege controls.

The dashboard, debtor workbench, invoice detail, payment detail, student profile, receipts, and reconciliation queue read these server-maintained values. They do not establish a second AR ledger.

### 3.5 Platform, communications, and reliability model

`lib/db/schema/platform.ts` contains:

- `payment_links` with `ACTIVE`, `PAID`, `EXPIRED`, and `REVOKED` enum values, token, invoice/student linkage, optional amount, expiry, and paid/revoked fields;
- `communications` with provider/delivery-shaped fields;
- append-only `audit_events` with actor/entity/action, before/after, reason, metadata, request/correlation data, and timestamps;
- `idempotency_keys` with tenant/user/key scope, request hash, cached response, and expiry; and
- `webhook_events` with provider/event uniqueness, payload, signature, processing state, attempts, and error fields.

The implemented communication path is the M7 debtor reminder path. `reminders` are an immutable tenant-scoped balance-follow-up log with a cooldown. PRINT is implemented synchronously. The current route accepts SMS/EMAIL/WHATSAPP-shaped values but does not connect an external delivery provider.

### 3.6 M10 reconciliation control plane

M10 adds `reconciliation_cases`, `reconciliation_evidence`, and `reconciliation_candidates`. These records contain operational state, evidence, human-selected candidates, assignment/history, and resolution data; they do not contain payment balances, invoice totals, allocation amounts, receipt amounts, or a second ledger.

The current M10 API/UI includes:

- a cursor-paginated queue;
- payment detail with allocations and retained reconciliation history;
- append-only evidence;
- explicit human student/invoice matching candidates and acceptance;
- evidence-gated confirm, match, allocate, flag/unflag, and no-financial-action resolve operations; and
- state/version/terminal guards, idempotency, audit, tenant attribution, and concurrency handling.

The M10 confirm path calls the existing payment confirmation repository. The M10 allocation path calls the existing allocation repository. M10 resolve explicitly reports `financialAction: none`. M10 therefore remains a control plane over existing financial truth.

## 4. Supported lifecycle trace

| Lifecycle stage              | Authoritative record(s)                                                                             | Authoritative service/path                                                                                                                          | Current surface and control notes                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| School/tenant                | `organizations`, `users`, `organization_members`                                                    | Auth registration, membership services, `withTenant()`                                                                                              | Organization is derived from authenticated membership; client organization IDs cannot establish context.                                  |
| Academic session             | `academic_sessions`                                                                                 | `lib/db/repo/academic-sessions.ts`; `/api/academic-sessions`, `/activate`                                                                           | Activation is serialized and audited. Close/rollover is not implemented.                                                                  |
| Academic period              | `terms`, `fee_assignments`, `class_enrollments`                                                     | `terms.ts`, `fee-assignments.ts`, `enrollments.ts`; `/api/terms/**`                                                                                 | Terms can be planned/activated/billed; assignments and enrollments are locked after billing by M8/M9 controls.                            |
| Student                      | `students`, `guardians`, `student_guardians`, `class_enrollments`                                   | `students.ts`, enrollment/class repositories; `/api/students/**`, `/api/terms/:id/enrollments`                                                      | Student identity and enrollment are tenant-scoped. Guardian data has no complete standalone API surface.                                  |
| Obligation/fee configuration | `fee_definitions`, `fee_assignments`, `waivers`                                                     | `fee-definitions.ts`, `fee-assignments.ts`, `billing.ts`; fee/settings and term billing routes                                                      | Configuration is not a ledger. Billing snapshots the applicable assignment into ordinary invoice lines.                                   |
| Invoice/obligation           | `invoices`, `invoice_lines`                                                                         | Manual path: `/api/invoices` -> `invRepo.createDraft` -> `lineRepo.addLines` -> `invRepo.issue`; controlled path: `billingRepo.billTerm()`          | Totals are trigger-maintained. Issue and void are explicit audited transitions. No paid invoice is voided without reversal first.         |
| Payment recorded             | `payments`                                                                                          | Authenticated `/api/payments` -> `payRepo.record`; public `/api/p/:token/submit` uses a narrowly scoped raw SQL public boundary to insert `PENDING` | Authenticated path is transactional and reference/idempotency-aware. Public submission is intentionally pending and not allocated.        |
| Payment confirmed            | `payments.status` and timestamps                                                                    | `/api/payments/:id/confirm` -> `payRepo.confirm`; M10 `/api/reconciliation/payments/:id/confirm` -> same repository                                 | Confirmation seeds unallocated balance only on first entry to confirmed. Evidence is required in the M10 path.                            |
| Allocation                   | `payment_allocations`, plus trigger-maintained `payments.unallocated_kobo` and `invoices.paid_kobo` | `payment-allocations.ts`; `/api/payments` atomic create path, `/api/payments/:id/allocate`, and M10 allocation path                                 | This is the only supported way to move a confirmed payment onto an invoice. Trigger locking and checks prevent over-allocation.           |
| Receipt                      | `receipts`                                                                                          | `/api/receipts` -> `receiptRepo.issue`; `/api/receipts/:id` read                                                                                    | Receipt issuance is manual after allocation, idempotent under the M9 uniqueness constraint/race replay. No receipt-void route is present. |
| Reversal/refund              | `reversals`, reversed allocations, payment/invoice derived state                                    | `/api/payments/:id/reverse` -> `revRepo.create`; `REFUND` is a reversal type, not a separate route                                                  | Reversal/refund rows are append-only. The trigger consumes allocation effects and reopens invoice state as required.                      |
| Reconciliation               | `reconciliation_*` tables plus authoritative payment/invoice/allocation rows                        | `lib/reconciliation/index.ts`, `lib/db/repo/reconciliation.ts`, M10 routes                                                                          | Operational evidence/state only; no balance copy and no automatic/heuristic/AI matching.                                                  |
| Audit/idempotency            | `audit_events`, `idempotency_keys`                                                                  | `audit-events.ts`, `idempotency-keys.ts`, M9 idempotency helper, route-level calls                                                                  | Financial/M10 paths write actor/request/before/after data. Coverage is route-specific rather than a universal DB audit trigger.           |

### Authoritative financial mutation inventory

The following is the specific answer to where financial state may change:

1. **Invoice totals:** only invoice-line insert/update/delete triggers maintain `invoices.total_kobo`; no route writes the total directly.
2. **Invoice paid balance/status:** only active allocation insert and reversal insert triggers maintain `invoices.paid_kobo` and derived invoice status.
3. **Payment unallocated balance:** only confirmation seeding and allocation/reversal triggers maintain `payments.unallocated_kobo`.
4. **Invoice creation/issue:** `app/api/invoices/route.ts` and `app/api/invoices/[id]/issue/route.ts` call `lib/db/repo/invoices.ts` and `invoice-lines.ts`; `lib/db/repo/billing.ts` is the controlled term-billing path.
5. **Invoice void:** `app/api/invoices/[id]/void/route.ts` calls `invRepo.voidInvoice()` after requiring zero paid balance.
6. **Payment creation:** authenticated `app/api/payments/route.ts` calls `payRepo.record()`; the public link submit route inserts a `PENDING` payment through its security-definer/public-context boundary and does not allocate it.
7. **Payment confirmation:** `payRepo.confirm()` is called by the standard confirm route and the M10 reconciliation confirm route.
8. **Allocation:** `allocRepo.allocate()` is called by standard payment recording/allocation routes and M10 reconciliation allocation. The allocation trigger is the financial authority.
9. **Reversal/refund/correction:** `revRepo.create()` is called only by `/api/payments/[id]/reverse`; `REFUND` is a typed append-only reversal, not parallel refund state.
10. **Receipt issuance:** `receiptRepo.issue()` is called only by `/api/receipts`. There is no separate receipt-void implementation in the current route inventory.
11. **Payment-link lifecycle:** `linkRepo.create()` and `linkRepo.revoke()` own authenticated link creation/revocation. The public submit path currently does not update the link to `PAID`, attach a payment ID (there is no such column), or allocate the submitted payment.
12. **Reconciliation:** M10 changes only cases/evidence/candidates, except that its evidence-gated confirm and allocation workflows deliberately delegate financial effects to the existing payment/allocation paths.
13. **Reminder/collections records:** reminder rows and future collections records are operational communications/control records; they must never write invoice/payment balances.

There is no distinct public refund endpoint, bank/provider ingestion route, automatic matching route, or guardian/student portal route in the inspected implementation.

## 5. Current control strengths

1. **Tenant context is not client supplied.** Authenticated membership resolution and the security-definer context function establish organization scope; route bodies do not get to choose the active organization.
2. **RLS is defense in depth, not a convention.** The runtime principal is non-superuser and non-bypass-RLS. Tables are FORCE RLS protected, and migrations add tenant/actor guards for sensitive control records.
3. **Financial truth is trigger-maintained.** Direct writes to total, paid, and unallocated columns are blocked. Allocation/reversal locking protects concurrent money movement.
4. **Financial records are non-destructive.** Reversals, audit events, waivers, reminders, and M10 evidence/history have append-only or restricted semantics; financial deletes are blocked.
5. **State machines are explicit.** Invoice/payment/term/link/reminder/reconciliation transitions are protected in service and/or database code.
6. **M8 controlled billing is idempotent and completeness-aware.** It locks the term, validates the active cohort, reuses existing covered keys, blocks unsafe draft/void retry shapes, and records ordinary invoices/lines.
7. **M9 academic activation and receipt race hardening are present.** Academic current pointers are serialized; issued receipt uniqueness is database-backed and the route re-reads the winner on a uniqueness race.
8. **M10 preserves the ledger boundary.** Evidence and human candidates are durable and tenant-scoped but do not copy financial balances. M10 allocation/confirmation reuses authoritative services.
9. **Server-derived dashboards and debtor views are substantially faithful.** Dashboard and debtor math reads trigger-maintained invoice and allocation values rather than client-supplied balances.
10. **Reliability controls exist, although coverage is uneven.** Idempotency keys, unique references, webhook-event uniqueness, M10 versioning, and receipt uniqueness provide strong patterns to reuse.

## 6. Current operational gaps and control risks

These are reconnaissance findings, not M11 implementation changes.

### 6.1 Collections ownership is absent

The debtor workbench (`/api/debtors`, `/debtors`) ranks students and permits an operator to print a reminder. It does not provide a durable collections case, owner, next action, escalation state, contact outcome, or closure reason. M10 cases solve payment exceptions, not outstanding-account follow-up. A reminder log is not a case-management lifecycle.

### 6.2 Account views are internal and incomplete as an operational timeline

The current debtor detail and printable statement show current outstanding invoices and reminder history. The student profile shows invoices and payments allocated to the student. There is no single internal account timeline that combines invoice issuance, active/reversed allocations, receipts, reversals, reminders, and unresolved payment/reconciliation context in one operational view. There is also no guardian-authenticated account view. The latter remains a non-goal unless explicitly reopened.

### 6.3 Arrears calculations are useful but policy-light

The aging workbench derives balances from invoice totals and paid values, which is a strength. It does not persist collection policy, case ownership, promise/next-action dates, escalation thresholds, or treatment of an account with an unresolved pending/unallocated payment. `listDebtors()` is a 500-row workbench query rather than a complete case queue with an operational lifecycle.

The debtor-detail query also includes `PAID` invoices in its read set, then filters the open summary in application code. That is safe for the displayed balance but leaves the account-view contract less explicit than a dedicated statement projection.

### 6.4 Payment-link lifecycle is only partially implemented

The schema has `PAID` and `paid_at` fields, but the authenticated create/revoke routes implement only `ACTIVE` and `REVOKED` behavior. The public view resolver handles active, expired, revoked, and missing tokens. The public submit route creates a `PENDING` bank-transfer payment with link-token text in notes, but it does not:

- use the normal payment repository;
- accept or persist an idempotency key;
- associate the payment to the link through a dedicated relation;
- transition the link to `PAID` after confirmation/allocation;
- enforce one successful submission per link; or
- enforce a configured amount equality/ceiling against the link amount or invoice remaining balance.

The last item may be a deliberate overpayment policy, so it is a product-policy question rather than an automatic defect. In the present implementation it can result in a pending unallocated payment requiring human review, which is consistent with the M10 control-plane boundary but needs an explicit link lifecycle policy.

### 6.5 Receipt lifecycle has a schema without the complete route surface

`receipt_status` includes `ISSUED` and `VOID`, and the schema has void fields, but no `/api/receipts/[id]/void` route was found. The receipt issue route correctly requires a confirmed payment and active allocation, but it issues one payment-level receipt using the first allocation's student when a payment covers more than one student. That is a known bounded behavior in the implementation and should not be silently reinterpreted as a multi-student receipt policy.

### 6.6 Reminder delivery state is inconsistent with the route contract

The route documentation and response say non-PRINT channels are `PENDING`, but `lib/db/repo/reminders.ts:create()` always inserts `status: 'SENT'` and only sets `sentAt` for PRINT. The database lifecycle permits `PENDING -> SENT/FAILED -> DELIVERED`, but the current route skips the pending state for SMS/EMAIL/WHATSAPP without a provider. This makes the operational display and the durable communication state potentially overstate delivery.

### 6.7 Approval and segregation of duties are absent

The role matrix authorizes the same broad financial roles for record/confirm/allocate/reverse/void/receipt/reconciliation actions. There is no maker/checker approval record or immutable approval decision. M10 requires evidence and human review but does not implement financial approval/SoD. Any future approval layer must be an append-only control record and must not be a second approval-shaped financial status that bypasses existing state machines.

### 6.8 Period close and rollover are not a supported lifecycle

Terms and sessions carry close fields and closed statuses. Current activation and billing paths prevent some unsafe changes, but no close/rollover workflow was found. A future rollover cannot copy invoices, carry balances by rewriting records, or silently generate obligations. Prior-term debt must remain on its original invoices and be displayed/collected through derived account views.

### 6.9 Settlement/provider operations are only primitives

`webhook_events` and provider-shaped payment fields exist, and documentation names provider/settlement concepts, but the route inventory contains no provider webhook intake or settlement workflow. M10 explicitly excluded bank/provider ingestion and automatic matching. This remains a staging/provider-integration dependency, not a safe M11 assumption.

### 6.10 Audit coverage is route/service dependent

Financial and M10 routes use `auditRepo.record()`, and the audit table is append-only. The older `lib/authz/audit.ts:writeAudit()` helper intentionally swallows audit errors after logging; that may be acceptable for some non-financial membership paths but must not be copied into a new financial/control mutation where audit durability is an acceptance invariant. A future control layer must choose transactionally durable audit behavior.

## 7. Candidate control layers (unordered comparison)

The following candidates were investigated without ranking. Each entry records the required problem, primitive, surface, security/integrity, RLS, migration/test, staging, and M10 relationship.

### Candidate A — Collections case/control layer

- **Problem evidenced:** the debtor workbench identifies owing students and records reminders but has no ownership, next action, escalation, resolution, or durable case episode.
- **Existing primitives:** `students`, `invoices`, trigger-maintained balances, `reminders`, `audit_events`, `debtor.read`, `reminder.send`, and the `/debtors` UI.
- **Potential new primitives:** tenant-scoped collections cases and append-only case events with actor, state, assignment, priority, next-action time, notes, and reminder linkage. No money columns are needed.
- **Affected tables/routes/services:** new `collections_cases`/`collections_case_events`; `lib/db/repo/reminders.ts`; a new collections repository/service; `/api/debtors`, `/api/debtors/[studentId]`, new internal collections case routes, and `/debtors` UI.
- **Security and financial integrity:** all mutations must use centralized auth, CSRF, explicit action policy, idempotency, and durable audit. Case state must never set invoice/payment/receipt/reconciliation state. Current balances must be selected from authoritative invoices at read time.
- **RLS/tenant implications:** both new tables require RLS and FORCE RLS, organization auto-stamping, same-tenant student/actor/assignee guards, restrictive foreign keys, and no client organization input. One-open-case concurrency needs a database partial unique index.
- **Migration/test complexity:** medium. New tables, state/version/terminal triggers, immutable events, partial uniqueness, grants, and fresh/replay/upgrade tests are required. Concurrency tests must prove two operators converge on one case and stale state updates conflict.
- **Staging dependency:** active tenant/member fixture, role matrix verification, realistic debtor/reminder fixtures, and an explicit product decision on one open case per student versus invoice-level cases.
- **M10 relationship:** adjacent and complementary. M11 may display M10 unresolved-payment context, but it must not create a second reconciliation case or mutate M10 records.

### Candidate B — Internal student/guardian account views

- **Problem evidenced:** current debtor detail, printable statement, and student profile expose overlapping slices rather than one complete internal account timeline; no guardian account authentication exists.
- **Existing primitives:** invoices, invoice lines, allocations, payments, reversals, receipts, reminders, students, guardians, and audit events; `/api/debtors/[studentId]`, the print statement, `/api/students/[id]`, invoice/payment detail APIs.
- **Potential new primitives:** a read-only account projection/query and timeline serializer; only add guardian-authentication primitives if the portal is explicitly reopened.
- **Affected tables/routes/services:** existing read routes and UI, potentially a new internal `/api/accounts/students/[id]` route. The projection must join authoritative records and not materialize a balance ledger.
- **Security and financial integrity:** read-only account access must use role/action authorization and PII minimization. Guardian access would require verified identity-to-student relationships, consent/privacy policy, session/CSRF controls, and must not use a public token as an account credential.
- **RLS/tenant implications:** every join must retain organization predicates or rely on correctly scoped RLS; a guardian user model would need same-tenant relationship guards and no client-supplied student/organization trust.
- **Migration/test complexity:** low to medium for internal read-only projection; high for a guardian portal because it introduces identity, relationship, PII, public/authenticated boundary, and cross-student tests.
- **Staging dependency:** representative multi-invoice, multi-payment, reversal, receipt, guardian, and cross-tenant fixtures; guardian portal additionally needs privacy and support workflows.
- **M10 relationship:** read M10 case/evidence/history only where useful; never show a reconciliation candidate as an allocation or alter M10 state from an account view. Guardian/student portals remain an M10 non-goal.

### Candidate C — Arrears/aging policy layer

- **Problem evidenced:** current aging is a useful SQL calculation but has no persisted policy, action threshold, owner, promise, or exception treatment; it is limited to a 500-row workbench.
- **Existing primitives:** `reminderRepo.listDebtors()`, debtor detail, dashboard overdue KPIs, invoice due dates/status/balances, and reminder cooldown/history.
- **Potential new primitives:** a reusable server-side aging/account query, policy configuration, or a case link. A materialized amount table would be unsafe unless it is explicitly a cache with authoritative invalidation and never financial truth.
- **Affected tables/routes/services:** `lib/db/repo/reminders.ts`, dashboard/debtors routes, invoice/student joins, and possibly a collections policy table.
- **Security and financial integrity:** all aging must be derived from `invoices.total_kobo`, `paid_kobo`, status, and due dates. Policy labels may be operational; they must not rewrite invoice status or create a payment/allocation.
- **RLS/tenant implications:** raw SQL must use the authenticated GUC or explicit tenant predicates on every base relation; cross-tenant guardian joins need the same defense.
- **Migration/test complexity:** low for a query/index improvement, medium for configurable policies and versioned policy history. Test boundary dates, partial payments, void/paid invoices, current term versus all-time, and concurrent allocation reads.
- **Staging dependency:** real schools have prior-term debt, current-term unbilled students, and pending transfers; staging must validate the policy before any reminder automation.
- **M10 relationship:** pending/unallocated payments can make an account look outstanding. M10 state can be displayed as a warning, but no heuristic suppression or automatic “paid” interpretation is allowed.

### Candidate D — Payment-link lifecycle

- **Problem evidenced:** link fields imply a paid lifecycle, while current public submit only creates pending payment evidence and leaves link/payment association and idempotency to later manual operations.
- **Existing primitives:** `payment_links`, public resolver/probe/context security-definer functions, `/api/payment-links`, `/api/payment-links/[token]`, `/api/p/[token]/view`, `/api/p/[token]/submit`, `payments`, and M10 reconciliation.
- **Potential new primitives:** explicit link-submission/payment relation or idempotency record, safe link locking, amount policy, terminal link transition, and a provider/manual confirmation callback. These must be designed before implementation; adding a fake “paid” flag alone would create parallel payment state.
- **Affected tables/routes/services:** payment links, payments, idempotency, audit, public routes, payment confirmation/allocation routes, and potentially webhook intake.
- **Security and financial integrity:** public bearer access must remain PII-minimized and must only create `PENDING` evidence. It must not confirm, allocate, issue receipts, or infer tenant from the request body. Amount mismatch/overpayment must remain visible and route to human review.
- **RLS/tenant implications:** public lookup may use only the narrow resolver/probe and public context; every post-resolution query/mutation must be scoped to the resolved organization and clear context in `finally`. Authenticated operators must use membership-derived context.
- **Migration/test complexity:** high because public concurrency, replay, expiry/revocation, overpayment, duplicate submission, and link/payment/reconciliation association must be tested. Migrations must preserve existing tokens and terminal history.
- **Staging dependency:** real provider/manual transfer policy, public HTTPS/CSRF/bearer testing, duplicate payer attempts, and active tenant fixtures. Provider settlement is not available in the current repository baseline.
- **M10 relationship:** submitted pending payments should enter the existing M10 queue. Link lifecycle must delegate confirmation/allocation/reversal to existing paths and must not invent a second payment state.

### Candidate E — Finance operations and document lifecycle

- **Problem evidenced:** payment, allocation, reversal, receipt, invoice, and void operations are spread across separate surfaces; receipt voiding/reissue and operational exceptions are incomplete.
- **Existing primitives:** financial repositories, invoice/payment detail activity, receipt issue race hardening, reversal/refund type, audit, idempotency, and state-machine triggers.
- **Potential new primitives:** explicit receipt-void workflow, operational finance task records, better document/account timeline, and service-level transaction wrappers. No new ledger is needed.
- **Affected tables/routes/services:** receipts, reversals, payments, invoices, their existing routes/repositories, and possibly a finance-operations queue.
- **Security and financial integrity:** receipt void must be append-only/audited and cannot erase payment/allocation history. Reversal/refund must remain on `revRepo.create()`; invoice void must still require zero paid balance. All fixes must preserve the authorized receipt uniqueness-race replay hardening.
- **RLS/tenant implications:** receipt/payment/student/invoice joins need same-tenant checks; any void actor must be a same-tenant authorized user. Runtime grants and immutable-column triggers must be extended only forward.
- **Migration/test complexity:** medium to high. Receipt lifecycle changes require terminal/void guards, reissue uniqueness behavior, allocation/reversal interaction, and concurrent issue/void tests.
- **Staging dependency:** school policy for receipt void/reissue, multi-student payment examples, refund evidence, and finance-officer role review.
- **M10 relationship:** M10 may link an exception to existing finance operations, but reconciliation resolve must not perform a receipt void/reversal. Financial consequences remain in financial routes.

### Candidate F — Exception/escalation layer

- **Problem evidenced:** M10 provides a strong payment reconciliation exception state machine; there is no general operational escalation for debtors, stale reminders, public-link anomalies, receipt/document issues, or term readiness.
- **Existing primitives:** M10 cases/evidence/candidates, dashboard attention rows, reminders, payment pending/unallocated derived work, and audit.
- **Potential new primitives:** either collections cases for AR-specific exceptions or a broader operational case taxonomy. A generic table should not be introduced without clear ownership/state semantics because it can become an unbounded parallel workflow.
- **Affected tables/routes/services:** M10 read surfaces, debtor/reminder surfaces, dashboard, and any new operational case repository.
- **Security and financial integrity:** exception state must be evidence-bearing, tenant-scoped, append-only where history matters, and incapable of changing financial state except by delegating to an existing service. Ambiguity must remain visible rather than auto-resolved.
- **RLS/tenant implications:** M10's actor/terminal/linkage guards are the minimum standard. A new exception table needs the same organization/actor/assignee checks and FORCE RLS.
- **Migration/test complexity:** medium; high if it attempts to generalize M10 tables or reuse M10 states for non-payment work. Test closed-case immutability, evidence, stale versions, terminal records, and cross-tenant assignee attempts.
- **Staging dependency:** definition of operational ownership, escalation SLAs, and which human role may close each category.
- **M10 relationship:** reuse M10 as an example and read dependency; do not weaken or broaden M10's frozen schema/state machine during M11.

### Candidate G — Approvals and segregation of duties

- **Problem evidenced:** the current policy grants broad financial authority to each eligible role; no maker/checker or approval trail separates invoice void, reversal/refund, receipt void, or high-impact billing decisions.
- **Existing primitives:** centralized action policy, audit events, user/membership roles, M8 waiver approver field, M10 evidence/decision actor fields.
- **Potential new primitives:** append-only approval requests/decisions, action-specific amount/policy thresholds, separate approver eligibility, and immutable links to the exact request hash/entity/state.
- **Affected tables/routes/services:** permission matrix, financial mutation routes, audit, and a new approvals repository/table. Existing routes would need to reject unapproved actions only where policy is explicitly adopted.
- **Security and financial integrity:** approvals must not be a client-supplied boolean or a mutable column on the invoice/payment. The approved request hash, actor, decision, reason, time, and target state must be durable. Self-approval and same-person maker/checker conflicts need explicit rules.
- **RLS/tenant implications:** approval actor and target entity must be same-tenant; roles are tenant membership roles, not client labels. Platform support must remain read-only.
- **Migration/test complexity:** high. It crosses every financial mutation boundary and requires replay, stale request, cross-role, self-approval, concurrent approval, and direct-SQL guard tests.
- **Staging dependency:** proprietor policy, amount thresholds, emergency correction policy, and role staffing realities. No implementation should infer these rules.
- **M10 relationship:** M10 evidence is not a financial approval. Any future approval of M10-linked financial action must still call the existing confirmation/allocation/reversal path; M10 itself remains frozen.

### Candidate H — Reporting and control views

- **Problem evidenced:** dashboard, debtors, invoice, payment, and reconciliation views are useful but fixed; there is no general controlled export/report contract for period, aging, receipts, reversals, or audit coverage.
- **Existing primitives:** server-side aggregate queries, `audit_events`, invoice/payment/allocation/reversal/receipt tables, dashboard summary, debtor list, reconciliation queue, and permission actions `report.financial.read`/`report.financial.export`.
- **Potential new primitives:** parameterized read-only report queries, export serializers, as-of semantics, report run audit, and bounded indexes. No reporting ledger or denormalized balance store should be added.
- **Affected tables/routes/services:** dashboard/report routes, all financial read joins, audit, authorization, and UI/export surfaces.
- **Security and financial integrity:** report figures must identify scope/as-of date and derive from authoritative rows. Exports need PII controls, tenant predicates, safe integer serialization, and audit of who exported what. Client totals must not be trusted.
- **RLS/tenant implications:** every report query must run under tenant context; platform reports require an explicit separate capability and read-only context. Large export queries need pagination/streaming without bypassing RLS.
- **Migration/test complexity:** low to medium for bounded reports; high for arbitrary report builders. Test current/prior terms, reversals, pending/unallocated payments, voids, cross-tenant IDs, export authorization, and exact kobo totals.
- **Staging dependency:** reporting definitions, fiscal/as-of policy, volume/performance data, and PII retention policy.
- **M10 relationship:** include M10 case/evidence counts as control metadata only; never treat a reconciliation case as a financial balance or duplicate payment table.

### Candidate I — Settlement/provider operations

- **Problem evidenced:** provider/webhook schemas and payment fields exist, but no provider webhook intake, signature verification, settlement batch, provider-to-payment linkage, or settlement exception workflow is implemented.
- **Existing primitives:** `webhook_events`, idempotency keys, payment references/statuses, audit, public payment links, and M10 evidence kinds including `PROVIDER_EVENT`.
- **Potential new primitives:** signed webhook endpoint, provider event processor, settlement batches/lines, provider reference mapping, retry/dead-letter operations, and an explicit settlement control plane. These are substantially more than a read-only M11 reconnaissance candidate.
- **Affected tables/routes/services:** webhook events, payments, payment links, reconciliation, provider integration, secrets/configuration, and settlement tables/routes.
- **Security and financial integrity:** signature validation, provider event idempotency, replay defense, amount/currency/order checks, and human review of ambiguity are mandatory. A provider callback must not create a parallel payment state or allocate without the existing financial service.
- **RLS/tenant implications:** provider-to-tenant resolution cannot trust a client organization ID; event identity and resolved tenant must be bound before tenant data is read/written. System/provider actors require explicit database actor semantics.
- **Migration/test complexity:** high, including provider sandbox, retries, out-of-order events, duplicate events, failed/refunded events, settlement mismatch, and network failure tests.
- **Staging dependency:** provider sandbox credentials, callback URL/HTTPS, signature fixtures, settlement files, operational ownership, and reconciliation policy.
- **M10 relationship:** explicitly an M10 non-goal. M10 can store provider evidence and review a known payment, but no automatic ingestion/matching should be added under the frozen M10 state.

### Candidate J — Communication-triggered workflows

- **Problem evidenced:** reminders are durable and printable, but external channels are not delivered, async statuses are inaccurate for non-PRINT, and no event-driven follow-up workflow exists.
- **Existing primitives:** `reminders`, `communications`, channel/status enums, guardian contact data, cooldown, reminder UI, and audit.
- **Potential new primitives:** communication job/outbox semantics, template/version records, provider delivery updates, opt-out/preferences, retry policy, and a link from a reminder/event to a collections case.
- **Affected tables/routes/services:** reminder repository/route, communications table, guardian/student joins, provider worker/webhook routes, and future collections events.
- **Security and financial integrity:** bodies must be generated from server-truth balances; delivery status must not be confused with payment confirmation; no message callback may allocate or mark an invoice paid. PII and opt-out rules must be explicit.
- **RLS/tenant implications:** recipient address and body are tenant-scoped PII; provider callbacks need authenticated event identity and tenant resolution. Public links must not expose reminder records.
- **Migration/test complexity:** medium for correcting status and case linkage; high for real providers/retries/opt-outs. Test current status transitions, immutable body/balance snapshots, delivery races, and cross-tenant callbacks.
- **Staging dependency:** SMS/email/WhatsApp providers, sender identity, consent/opt-out, cost controls, and test recipients.
- **M10 relationship:** independent operational layer. A message about an unresolved payment must not auto-confirm, match, or allocate it; M10 remains the review path.

### Candidate K — Academic close/rollover

- **Problem evidenced:** sessions/terms have close fields and billing locks, but no supported close, carry-forward, rollover, or readiness workflow.
- **Existing primitives:** academic/session/term status fields, activation routes, enrollment controls, fee assignment locks, controlled billing, invoices tied to term/session, and M9 idempotency/audit.
- **Potential new primitives:** close/readiness checks, explicit close decision/history, next-session/term creation wizard, roster-copy operation, and reports of open invoices/pending reconciliation/reminders. Carry-forward should be a read relationship, not copied financial rows.
- **Affected tables/routes/services:** academic sessions/terms/enrollments, fee assignments, invoices, debtors, reminders, dashboard, and audit/idempotency.
- **Security and financial integrity:** closing must not delete or rewrite historical invoices, allocations, receipts, reversals, reminders, or M10 history. Rollover must not silently duplicate fee lines or obligations. Future corrections need their existing audited paths.
- **RLS/tenant implications:** all copied academic rows need same-tenant reference validation and concurrency locks; cross-session references need tenant and lifecycle guards.
- **Migration/test complexity:** high. It requires state-machine changes, readiness calculations, concurrent activation/close/billing tests, prior-term debt fixtures, and upgrade-safe data preservation.
- **Staging dependency:** academic calendar policy, promotion/withdrawal rules, prior-term debt treatment, and real roster/fee data.
- **M10 relationship:** M10 explicitly excluded term rollover. A close readiness view may read open reconciliation work, but M11 must not alter M10 cases or infer that unresolved payments are settled.

## 8. Explicit anti-patterns and prohibited changes

The following would violate the current architecture and must be rejected in design review:

| Prohibited change                                                                                                                                 | Why it is unsafe                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add `student_balance`, `arrears_amount`, `account_total`, or collection-case amount as a new financial truth                                      | Duplicates trigger-maintained invoice/payment truth and creates drift after allocation/reversal. Operational snapshots must be clearly non-authoritative if ever used. |
| Update `invoices.total_kobo`, `invoices.paid_kobo`, or `payments.unallocated_kobo` from a new service                                             | Bypasses the database financial mutation boundary and can silently reinterpret money.                                                                                  |
| Mark invoices paid from a reminder, collection case, public link, report, or reconciliation decision                                              | Bypasses allocation and creates a false financial state.                                                                                                               |
| Add a parallel `payment_attempts`, `collection_payments`, or link-specific payment ledger that competes with `payments`                           | Creates parallel payment state and ambiguous reconciliation. Public link submissions must remain ordinary pending payments.                                            |
| Allocate by changing an invoice status or copying a payment amount into an account table                                                          | Bypasses `payment_allocations` and its locking/triggers.                                                                                                               |
| Auto-match by name/amount/heuristic/AI or silently mark a case reconciled                                                                         | Violates the M10 human-evidence boundary and hides ambiguity.                                                                                                          |
| Accept organization IDs, assignee IDs, student IDs, or guardian IDs without same-tenant validation                                                | Enables tenant leakage or cross-tenant actor attribution. Organization context must come from authenticated tenant context.                                            |
| Add a public route that confirms payments, allocates, issues receipts, or changes reconciliation state                                            | Public bearer links may submit pending evidence only; consequential financial operations require the existing authenticated boundaries.                                |
| Merge, delete, rewrite, or backfill old invoices/payments/allocations/reversals/receipts/reminders/M10 cases without a declared correction policy | Destructive mutation and unauditable financial reinterpretation are prohibited. Stop for human/product policy.                                                         |
| Reuse M10 tables for collections or alter M10 terminal/state semantics                                                                            | Reopens/fuses frozen control-plane responsibilities and risks weakening M10 guarantees.                                                                                |
| Introduce an approval boolean or mutable `approved_by` field directly on a financial row as the whole SoD design                                  | An approval is a separate durable decision record tied to an exact request; it must not become a bypassable financial status.                                          |
| Auto-close debt cases when a payment is merely pending or unallocated                                                                             | Pending/unmatched money is not allocated money. The operator must follow the existing confirmation/allocation/reconciliation workflow.                                 |
| Copy prior-term invoices or balances during rollover                                                                                              | Duplicates obligations or silently moves financial truth. Historical invoices remain tied to their original term.                                                      |

## 9. Proposed bounded M11 boundary

### 9.1 Proposed milestone name and objective

**M11 — Collections Workbench and Case Control Plane**

**Objective:** give the school a tenant-safe, auditable way to own outstanding student accounts from identification through human follow-up and resolution, while continuing to derive every displayed balance from the existing authoritative invoice/payment/allocation system and leaving M10 reconciliation as the sole payment-exception control plane.

This is a proposal, not an implementation decision. The one product policy that must be confirmed before implementation is the proposed **one open collections case per student per collection episode** model. The first bounded implementation should be student-level because the existing debtor queue and reminder flow are student-level; it should not invent simultaneous invoice-level and student-level cases.

### 9.2 In scope

1. **Internal collections queue:** extend the existing debtor workbench so outstanding students can be opened into a durable operational case. The queue derives current outstanding/overdue values from invoices and labels, rather than stores, those values.
2. **Collections case lifecycle:** create/open, assign, add an operator note, set priority/next action, escalate, resolve, and close. Each state change is explicit, authorized, versioned, audited, and represented in append-only case history.
3. **Student account context:** improve the existing internal debtor detail/statement surface with all current open invoices, current paid/outstanding values, reminder history, case state/owner/next action, and a non-financial warning when related payment/reconciliation work may require review.
4. **Reminder linkage:** allow a case action to invoke the existing reminder service and link the resulting reminder to the case event. PRINT remains the only actually delivered channel in this boundary. Correct the existing status mismatch so unsupported external channels remain pending rather than being recorded as sent.
5. **Operational escalation:** support human escalation of a collections case with a reason and audit history. Escalation is not an automatic financial action and does not alter invoices, payments, allocations, receipts, reversals, or reconciliation.
6. **Read-only M10 context:** where useful, show that an account has pending/unallocated/reconciliation work and link to the existing M10 surface. M11 does not create, update, close, or resolve M10 cases.

### 9.3 Explicitly out of scope

- bank/provider ingestion, settlement batches, automatic/heuristic/AI matching, or provider-triggered financial effects;
- guardian/student authentication, portal access, or new public account views;
- payment-link paid lifecycle, online checkout, provider payment processing, or link-specific financial state;
- payment recording, confirmation, allocation, reversal, refund, receipt issue/void, invoice issue/void, or any new financial ledger;
- wallets, credit balances, installments, multi-currency, or term rollover/academic close;
- automatic reminders, SMS/email/WhatsApp provider delivery, opt-out policy, or scheduled collection campaigns;
- maker/checker approvals and broad SoD policy, except that M11 mutations must remain explicitly role-authorized and audited;
- a general reporting/export expansion;
- changing any M10 table, state machine, migration, tag, commit, or closeout claim; and
- automatic case closure based only on a payment status or a balance calculation.

### 9.4 Proposed data primitives and invariants

A future implementation may add one forward migration containing:

- `collections_cases`: `id`, `organization_id`, `student_id`, operational state, priority, assignee, next-action timestamp, reason, created/resolved/closed actor/time, and optimistic `version`. It must contain **no financial amount or balance column**. The proposed unique partial index permits at most one open case for a tenant/student.
- `collections_case_events`: append-only case history with case ID, tenant ID, event type, before/after operational state, actor, note, assignment/next-action context, and optional `reminder_id`. It must contain **no payment/invoice amount**. A reminder link is a relationship to the existing immutable reminder row, not a copy of its balance.

Required invariants:

- current monetary values are selected from `invoices.total_kobo`, `invoices.paid_kobo`, invoice status, due date, and existing payment/allocation/reconciliation rows;
- no case route writes `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `receipts`, `reversals`, or M10 state;
- a case can be opened only for an in-tenant active student with an observable outstanding account at the time of opening; a case whose balance later reaches zero is resolved by an explicit human workflow, not silently deleted;
- transitions are allow-listed, use an organization/version/open-case predicate, and require reasons where policy demands them;
- closed case and event history are immutable; a later collection episode creates a new case rather than reopening or rewriting closed history;
- assignees and actors must be active same-tenant members; no client organization ID establishes scope;
- reminder status accurately represents delivery: PRINT may be `SENT`, unsupported external channels remain `PENDING` until a real provider exists; and
- every applicable mutation has authentication, centralized authorization, CSRF, validated input, idempotency, transaction scope, and durable audit.

### 9.5 Proposed surfaces

Potential protected APIs, subject to naming review:

- `GET /api/collections/cases` — tenant-scoped queue derived from current debtor/invoice truth;
- `POST /api/collections/cases` — idempotently open a case for an in-tenant student after server-side outstanding validation;
- `GET /api/collections/cases/:id` — case, append-only events, current account projection, reminders, and M10 warning context;
- `POST /api/collections/cases/:id/assign` — assign/unassign to an active same-tenant member;
- `POST /api/collections/cases/:id/note` — append a human operational note;
- `POST /api/collections/cases/:id/transition` — allow-listed operational transition/escalation/resolve/close;
- `POST /api/collections/cases/:id/remind` — call the existing reminder service, not a second communication or payment path; and
- an extension of `GET /api/debtors` and `GET /api/debtors/:studentId` or a deliberate replacement by the collections read service, without changing their financial meaning.

Potential service/repository boundaries:

- `lib/db/repo/collections.ts` for tenant-scoped case/event operations;
- a collections service for transition policy, optimistic concurrency, and idempotency;
- reuse of `lib/db/repo/reminders.ts` for reminder creation and current balance-derived body generation;
- `lib/db/repo/audit-events.ts` for transactional audit; and
- reuse of invoice/payment/reconciliation read services only for projections, never for a new balance write.

### 9.6 Authorization and RLS design

- Add explicit `collections.read` and narrowly scoped `collections.case.*` actions to the centralized policy matrix, granting only the roles approved for internal finance operations. Do not use a permissive default.
- Keep `reminder.send` as the gate for reminder delivery/recording.
- All protected routes use `withAuthorizedRoute`; unsafe methods require CSRF; mutations require an idempotency key and audit event.
- Derive organization from `session.activeOrganizationId`/`TenantCtx`, never from a body, query, or route-provided organization ID.
- Add RLS and FORCE RLS policies for both new tables, using the same authenticated tenant/platform policy family as the current runtime. Add tenant auto-stamping and same-tenant actor/assignee guards.
- Do not permit platform-support context to mutate collections. If support read is needed, add a separate explicit read capability and test it as read-only.
- Keep `scolaira_app` least privilege and non-bypass-RLS; future migration grants must be reviewed against the runtime principal.

### 9.7 Migration and migration-runner boundary

The implementation would require a new forward-only migration after `0036`, tentatively `0037_m11_collections_control_plane.sql`, plus its journal entry. It must:

- be safe on a fresh database and on a database already migrated through 0036;
- create the new tables, foreign keys, indexes, partial open-case uniqueness, checks, RLS/FORCE RLS, policies, tenant/actor triggers, immutable-event trigger, transition/version guard, and least-privilege grants;
- avoid changing or replacing any M10 migration/function/trigger; and
- run through the existing single migration runner, with a real migrated-database verification before acceptance.

No such migration exists as of this reconnaissance.

### 9.8 Required test plan

Before an M11 implementation could be accepted, the minimum evidence should include:

1. **Unit/service:** allow-listed transitions, terminal behavior, required reasons, one-open-case semantics, current-balance projection, reminder status mapping, and stale-version conflicts.
2. **Auth/API:** unauthenticated, missing/invalid CSRF, role matrix, body/path validation, same-tenant assignee validation, idempotency replay/key reuse, and public/platform-support mutation rejection.
3. **Database:** fresh/replay/upgrade migration execution; RLS and FORCE RLS; cross-tenant reads/writes; direct SQL insert/update/delete attempts; append-only events; tenant/actor guards; and runtime role attributes.
4. **Concurrency:** two simultaneous case opens, assignment/transition races, duplicate reminder attempts, and account read during concurrent authoritative allocation/reversal. No case operation may change a financial total.
5. **Financial regression:** invoice totals/paid values, payment unallocated values, allocations, reversals/refunds, receipts, M10 cases/evidence/candidates, and audit rows remain correct and untouched by case-only operations.
6. **UI/E2E:** debtor queue, case open/assignment/escalation/note/resolve/close, current account values, reminder print, pending external-channel display, cross-tenant not-found behavior, and accessibility.
7. **Baseline:** retain the frozen M10 28-file/262-test Vitest, typecheck, build, lint, and accepted 32/32 Playwright evidence; add M11 tests without weakening existing M1-M10 assertions.

### 9.9 Acceptance criteria

M11 would be accepted only if all of the following are demonstrated on a real migrated database and in the API/UI test suite:

- the current debtor queue can open and display one tenant-scoped student collection case without adding a balance ledger;
- every displayed amount is read from authoritative invoice/payment/allocation truth and changes immediately when the existing financial paths change;
- case state, ownership, escalation, notes, resolution, and closure are durable, actor-attributed, idempotent, version-safe, and audit-visible;
- closed cases/events cannot be rewritten, deleted, or reopened; a new episode creates new operational history;
- same-tenant RLS/actor/assignee constraints hold under ordinary API calls and direct runtime-role SQL attempts;
- a collections operation cannot issue/void an invoice, confirm/allocate/reverse a payment, issue/void a receipt, or mutate M10 state;
- PRINT reminders are accurately marked as delivered and unsupported external channels remain pending; reminder bodies remain server-generated and tied to current authoritative data at creation;
- concurrent open/transition/reminder requests converge or return a safe conflict without duplicate case truth or financial effects;
- public payment-link routes cannot read or mutate collections cases, and M10 public/platform-support boundaries remain intact; and
- migration replay, fresh install, typecheck, lint, build, full Vitest, targeted database/RLS/concurrency tests, and the accepted E2E baseline all pass.

### 9.10 Milestone boundary

The proposed M11 starts from the frozen M10 commit/tag and ends after the internal collections case lifecycle and reminder-state correction are proven. It does not include provider settlement, public/guardian access, financial mutation changes, academic close/rollover, approvals/SoD, or reporting expansion. Any request to add one of those must be a separate reconnaissance/design decision rather than a silent enlargement of M11.

## 10. Dependencies, risks, and staging requirements

### Dependencies

- product confirmation of one open student-level case per collection episode;
- explicit operational states, escalation reasons, priority meaning, and closure policy;
- confirmation that unsupported non-PRINT channels remain pending until a provider is implemented;
- the existing M10 payment/reconciliation surfaces remain frozen and available for read-only context;
- migration-runner authorization and a migration journal review; and
- an active tenant/member fixture for legitimate positive-path testing.

### Risks

- stale case projections could cause an operator to chase an account while a payment is pending; the UI must make unresolved payment work visible and never call it settled;
- a generic operational-case design could become a second reconciliation system; the initial student-level collections boundary avoids that by owning only AR follow-up;
- reminder status correction may expose previously over-reported `SENT` rows; existing immutable delivery history must not be rewritten—only future lifecycle behavior can be corrected, with any historical interpretation surfaced to a human;
- broad role grants could turn collections into an authorization bypass; actions must be explicit and reviewed per role;
- high-volume debtor queries may need indexes/pagination, but performance changes must not introduce materialized financial truth; and
- future rollover or provider work could tempt destructive backfills. Those policy questions must stop and be escalated rather than inferred.

### Staging verification required before implementation acceptance

1. Run the complete forward migration set on a disposable fresh database and an upgrade fixture from 0036.
2. Verify `scolaira_app` role attributes, RLS/FORCE RLS, policies, triggers, constraints, and grants from the migrated catalog.
3. Seed two real tenant-shaped organizations with active memberships, students, invoices, payments, reminders, and M10 work; verify positive and negative paths.
4. Exercise case concurrency and direct SQL bypass attempts under the actual runtime role.
5. Exercise a public payment-link submission and verify it remains a pending authoritative payment routed to existing M10 work, with no access to collections cases.
6. Re-run all frozen M10 and full-suite evidence before tagging any future implementation.

## 11. Inspected files and surfaces

The following implementation sources were inspected directly or through targeted repository inventory:

### Frozen baseline and architecture evidence

- `M10_CLOSEOUT_REPORT.md`
- `docs/security/M10_FINAL_AUDIT_REPORT.md`
- `docs/API_CONTRACTS.md` (used as context only where it matched implementation; implementation wins when they differ)
- `lib/db/migrations/0000_init.sql` through `lib/db/migrations/0036_m10_terminal_linkage_guards.sql`
- `lib/db/migrations/meta/_journal.json`
- `lib/db/migrate.ts`, `scripts/migrate.ts`

### Auth, tenant, authorization, and reliability

- `middleware.ts`
- `lib/auth/index.ts`
- `lib/auth/cookies.ts`
- `lib/authz/index.ts`
- `lib/authz/permissions.ts`
- `lib/authz/audit.ts`
- `lib/db/tenant.ts`
- `lib/db/index.ts`
- `lib/db/repo/_context.ts`
- `lib/db/repo/idempotency-keys.ts`
- `lib/db/repo/audit-events.ts`
- `lib/db/repo/webhook-events.ts`

### Schemas and repositories

- `lib/db/schema/tenancy.ts`
- `lib/db/schema/auth.ts`
- `lib/db/schema/academic.ts`
- `lib/db/schema/financials.ts`
- `lib/db/schema/platform.ts`
- `lib/db/schema/communications.ts`
- `lib/db/schema/reconciliation.ts`
- `lib/db/repo/academic-sessions.ts`
- `lib/db/repo/terms.ts`
- `lib/db/repo/students.ts`
- `lib/db/repo/enrollments.ts`
- `lib/db/repo/fee-definitions.ts`
- `lib/db/repo/fee-assignments.ts`
- `lib/db/repo/billing.ts`
- `lib/db/repo/invoices.ts`
- `lib/db/repo/invoice-lines.ts`
- `lib/db/repo/payments.ts`
- `lib/db/repo/payment-allocations.ts`
- `lib/db/repo/reversals.ts`
- `lib/db/repo/receipts.ts`
- `lib/db/repo/payment-links.ts`
- `lib/db/repo/reminders.ts`
- `lib/db/repo/reconciliation.ts`
- `lib/reconciliation/index.ts`

### API routes

- `app/api/auth/**/route.ts`
- `app/api/academic-sessions/**/route.ts`
- `app/api/terms/**/route.ts`
- `app/api/students/**/route.ts`
- `app/api/enrollments/**/route.ts`
- `app/api/fee-definitions/**/route.ts`
- `app/api/invoices/route.ts`
- `app/api/invoices/[id]/route.ts`
- `app/api/invoices/[id]/issue/route.ts`
- `app/api/invoices/[id]/void/route.ts`
- `app/api/payments/route.ts`
- `app/api/payments/[id]/route.ts`
- `app/api/payments/[id]/confirm/route.ts`
- `app/api/payments/[id]/allocate/route.ts`
- `app/api/payments/[id]/reverse/route.ts`
- `app/api/receipts/route.ts`
- `app/api/receipts/[id]/route.ts`
- `app/api/payment-links/route.ts`
- `app/api/payment-links/[token]/route.ts`
- `app/api/p/[token]/view/route.ts`
- `app/api/p/[token]/submit/route.ts`
- `app/api/debtors/route.ts`
- `app/api/debtors/[studentId]/route.ts`
- `app/api/debtors/[studentId]/remind/route.ts`
- `app/api/dashboard/summary/route.ts`
- `app/api/reconciliation/queue/route.ts`
- `app/api/reconciliation/payments/[id]/route.ts`
- `app/api/reconciliation/payments/[id]/confirm/route.ts`
- `app/api/reconciliation/payments/[id]/match/route.ts`
- `app/api/reconciliation/payments/[id]/allocate/route.ts`
- `app/api/reconciliation/payments/[id]/flag/route.ts`
- `app/api/reconciliation/payments/[id]/evidence/route.ts`
- `app/api/reconciliation/payments/[id]/resolve/route.ts`

### School-facing surfaces

- `app/(app)/dashboard/page.tsx`
- `app/(app)/academic/page.tsx`
- `app/(app)/students/**`
- `app/(app)/debtors/page.tsx`
- `app/(app)/debtors/[studentId]/page.tsx`
- `app/(print)/debtors/[studentId]/statement/page.tsx`
- `app/(app)/invoices/**`
- `app/(app)/payments/**`
- `app/(app)/reconcile/**`
- `app/(app)/terms/[id]/bill/**`

### Tests and test support

- `tests/auth/auth.test.ts`
- `tests/auth/authz.test.ts`
- `tests/auth/m6-hardening.test.ts`
- `tests/auth/m7-debtors.test.ts`
- `tests/auth/m8-term-billing.test.ts`
- `tests/auth/m9-academic.test.ts`
- `tests/auth/m10-reconciliation.test.ts`
- `tests/auth/rls-bypass-regression.test.ts`
- `tests/auth/runtime-role-safety.test.ts`
- `tests/db/audit.test.ts`
- `tests/db/concurrency.test.ts`
- `tests/db/db-boundary.test.ts`
- `tests/db/financial-attacks.test.ts`
- `tests/db/financial-invariants.test.ts`
- `tests/db/idempotency.test.ts`
- `tests/db/m10-reconciliation.test.ts`
- `tests/db/m8-term-billing.test.ts`
- `tests/db/m9-academic.test.ts`
- `tests/db/m9-idempotency.test.ts`
- `tests/db/state-machines.test.ts`
- `tests/db/tenant-isolation.test.ts`
- `tests/db/webhook.test.ts`
- `tests/support/seed.ts`
- `tests/support/rich-seed.ts`
- `tests/support/concurrent-seed.ts`
- `e2e/a11y.spec.ts`
- `e2e/health.spec.ts`
- `e2e/screenshots.spec.ts`

## 12. Required final confirmation

- **Baseline:** recorded above: M9/M10 targets, `HEAD`, clean pre-report tree, 36 migrations/journal entries, 28-file/262-test Vitest, typecheck, build, lint, and accepted 32/32 Playwright baseline.
- **Map:** authentication, tenancy, authorization, academic periods, students/guardians/enrollments, fee assignments, invoices/lines, payments, allocations, reversals/refunds, receipts, links, reminders/communications, reconciliation, audit, idempotency, dashboard, debtor, account, and school-facing control surfaces are mapped above.
- **Gaps:** collections ownership, complete account operational timeline, arrears policy, link lifecycle, receipt lifecycle, reminder delivery accuracy, approvals/SoD, academic close/rollover, provider settlement, and bounded reporting/communication controls are identified above.
- **Candidates:** collections, account views, arrears, payment links, finance operations, exception/escalation, approvals/SoD, reporting, settlement, communications, and academic close/rollover are compared without ranking.
- **Proposal:** one bounded M11 boundary is proposed: internal Collections Workbench and Case Control Plane, with no new financial truth and no M10 mutation.
- **Dependencies/risks:** product policy, real tenant staging fixtures, migration-runner/catalog verification, reminder delivery policy, M10 read-only integration, and concurrency/RLS evidence are recorded above.
- **Non-scope:** bank/provider ingestion/settlement, automatic matching, portals, rollover, wallets/credit, installments, unrelated reporting expansion, financial mutation redesign, and approvals/SoD remain outside the proposed M11 boundary.
- **M9/M10 untouched confirmation:** no M9 or M10 implementation file, migration, historical commit, tag, or frozen closeout was modified, amended, reopened, rewritten, or retagged during reconnaissance. Before this report was written, `HEAD` and the M10 tag both remained `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`, and the M9 tag remained `791b6e09ad211eac470e6011e28172b1ff925575`. The only intended working-tree addition is this reconnaissance report.

M11 RECONNAISSANCE COMPLETE
