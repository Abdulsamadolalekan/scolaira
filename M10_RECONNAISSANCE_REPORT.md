# SCOLAIRA M10 RECONNAISSANCE REPORT — RECONCILIATION CONTROL PLANE

**Date:** 2026-09-21 (Africa/Lagos)
**Mode:** Reconnaissance only
**M9 freeze:** annotated tag `m9-academic-control-layer`
**M9 freeze target:** `791b6e09ad211eac470e6011e28172b1ff925575`
**M9 implementation:** `ce4b9230e60f15dbc0cca1e8c5d6ecc25e2a6b7e`
**Migration state:** `0000` through `0022_m9_tenant_guard_order` applied

No M10 application code, migration, schema change, or implementation commit was made. This report is the only new M10 artifact.

## 0. M9 freeze record

Phase 1 was completed before reconnaissance began.

- The working tree was clean at closeout commit `791b6e09ad211eac470e6011e28172b1ff925575`.
- `m9-academic-control-layer` is an annotated tag targeting exactly `791b6e09ad211eac470e6011e28172b1ff925575`.
- The tag object was created with message `M9 freeze: controlled academic control layer`.
- M5 remains `0c66618e29e6179c80052a82c40f669979cef6b0`, tag `M5-FROZEN`.
- M6 remains `3668854682e39c7ef5ce1ec2647f85d6c6b8ced9`.
- M7 remains `86beba9742c31bcb3ce01d96934b06e9e4a7d445`.
- M8 remains `9989e6334c51ca61f43af4cd938a146c24fd054e`, tag `m8-controlled-term-billing`.
- No prior milestone was amended, rebased, rewritten, or reopened.
- Both `scolaira` and `scolaira_test` report 22 applied migrations; their latest rows are:

```text
22|0022_m9_tenant_guard_order
21|0021_academic_roster_control
20|0020_term_billing
```

The M9 verification baseline recorded in `M9_CLOSEOUT_REPORT.md` remains:

```text
Full environment-loaded Vitest: 26 files, 251 tests passed
Integration project:             22 files, 221 tests passed
TypeScript:                      PASS
Production build:               PASS
git diff --check:                PASS
M8 concurrent billing:           exactly 1 invoice and 1 invoice line
Runtime role:                    scolaira_app = f|f|f|f|f
```

The known 35 `25001` and 35 `25P01` PostgreSQL transaction warnings belong to the frozen M5–M8 auth harness. They are not treated as a new M10 problem or silently changed during reconnaissance.

## 1. Executive finding

### Selected capability: reconciliation control plane

M1–M9 now let a school establish a term population, configure fees, issue controlled term obligations, receive or record payments, allocate money, issue receipts, view debtors, send immutable reminders, and preserve financial truth under tenant/RLS/authz boundaries.

The next production-critical failure is between **money arriving** and **money becoming a confirmed, correctly allocated, explainable ledger event**.

The repository contains payment primitives, but it does not yet provide a reliable reconciliation workflow:

1. A bank transfer, POS settlement, cash receipt, or public payment-link submission may exist outside the authoritative ledger or remain `PENDING`/unallocated.
2. The current `/reconcile` page is a read-oriented snapshot. It lists pending payments, confirmed unallocated credit, and open invoices, but action happens one payment at a time on the payment-detail page.
3. The documented reconciliation queue and state-resolution APIs do not exist.
4. The payment state machine defines `DUPLICATE_SUSPECT`, `REJECTED`, and flagged/late-event behavior, but the production routes do not implement those transitions.
5. `webhook_events`, `communications`, payment-link data, and the `reference` field are structural capabilities, not an operational reconciliation loop.
6. The term state-machine documentation says term close requires reconciliation review, but M9 intentionally did not create term close/rollover. Reconciliation is therefore a prerequisite to safely deepening term lifecycle.

**M10 should make reconciliation an explicit, auditable control plane for known incoming-money records.** It should not begin with a bank-specific parser, fuzzy matching, or a new financial ledger. Those require field evidence and policy decisions that are not available in this repository.

## 2. Why this is the correct next dependency

### M1–M9 already establish

- tenant identity, membership roles, CSRF, centralized authorization, RLS/FORCE RLS, and a least-privilege runtime role;
- append-only audit events and durable idempotency infrastructure;
- trigger-maintained invoice totals, payment unallocated balances, allocation effects, reversals, receipts, dashboard, and debtor truth;
- manual payment recording for cash, bank transfer, POS, online, and other methods;
- pending-payment confirmation, multi-invoice allocation, reversal/refund/correction, and receipt issuance primitives;
- public payment links that intentionally create `PENDING` payments only;
- M7 debtor/aging and reminder surfaces that depend on invoices and allocations;
- M8 explicit fee setup, preview, bill, and top-up behavior;
- M9 authoritative term-specific academic population and billing-readiness handoff.

### What M9 changes about the dependency order

Before M9, the school could not reliably create the academic population consumed by M8 billing. M9 closes that upstream gap. After M9, a school can create a roster and issue a controlled obligation set, so the next bottleneck is no longer population creation: it is proving what incoming money means and applying it without duplication or silent interpretation.

Reconciliation is now the dependency that connects:

```text
M9 roster → M8 obligations → incoming payment evidence → confirmed payment → allocation → receipt/debtors/dashboard → safe term review
```

Without this control plane:

- an unallocated payment can remain suspended while the invoice stays outstanding;
- a payment can be recorded manually but not tied to the correct student/invoice;
- duplicate or late events have no durable review state;
- the dashboard's unreconciled number is not a complete queue;
- a proprietor cannot know whether a term is financially ready for close/rollover.

This is a dependency decision, not a claim that reconciliation is more impressive than term close, guardian management, bank integration, or reporting.

## 3. Evidence-based capability map

### 3.1 Already solved

| Capability | Repository evidence | Current operational result |
|---|---|---|
| Tenant/auth/RLS/authz | `lib/authz`, `lib/auth`, tenant GUC migrations, runtime-role tests | Strong foundation; new routes must use it. |
| Financial ledger truth | `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `reversals`, database triggers | Totals, paid amounts, unallocated amounts, and status effects are database-maintained. |
| Academic population control | M9 routes, repositories, migrations `0021`/`0022`, `/academic` | Session, term, class, student, enrollment, roster, and readiness workflow exists. |
| Controlled bulk billing | M8 fee setup, preview, bill routes/UI | Explicit review-time financial side effect; no implicit billing from academic mutation. |
| AR/debtors | `/debtors`, debtor APIs, reminder migration and routes | Ranked debtors, statements, reminder snapshots, and cooldown are operational. |
| Manual payment entry | `POST /api/payments`, `/payments/new` | A finance user can create confirmed or pending payment records and optionally allocate during creation. |
| Basic payment actions | `/api/payments/[id]/confirm`, `/allocate`, `/reverse` and payment detail UI | A known payment can be confirmed, allocated, reversed, or refunded through explicit actions. |
| Receipt correctness | `POST /api/receipts`, M9 partial unique issued-receipt guard | Receipt amount derives from active allocations; concurrent issued-receipt race is protected. |
| Public boundary | `/api/p/[token]/view`, `/submit`, public-context RLS | Public submit creates a `PENDING` payment only and does not allocate, confirm, issue, or mutate invoices. |

### 3.2 Partially solved

| Capability | Existing surface | Remaining production gap |
|---|---|---|
| Reconciliation | `/reconcile`, payment register, payment detail actions | No queue entity, review states, evidence workflow, candidate matching, duplicate resolution, or complete queue pagination. |
| Payment confirmation | Pending status and confirm route | Confirmation has no evidence/case payload and no durable reconciliation reason. |
| Allocation | Multi-allocation API and detail form | UI is one-payment/one-submit at a time; no queue-level allocation plan or student/invoice suggestions. |
| Duplicate detection | Reference guard and `DUPLICATE_SUSPECT` enum/docs | No production route to flag, resolve, link to original, reject, or safely confirm a suspect. |
| Public payment links | APIs and public pages exist | No operator-facing link-generation/list/revoke workflow page; public PENDING records still require reconciliation. |
| Dashboard unreconciled KPI | Current-term dashboard has pending-payment attention | It counts `PENDING` only, not all confirmed unallocated or duplicate/flagged cases, so it is not a complete queue count. |
| Payment register | `/payments` and `GET /api/payments?status=` | API and UI are capped at 200 records and lack method/date/student/unallocated/cursor filters. |
| Financial idempotency | `POST /api/payments` has optional legacy key support | Confirm, allocate, and reverse routes do not use the M9 request-shape idempotency helper; optional reference replay is not a universal request contract. |

### 3.3 Structurally present but operationally missing

- `payment_status` already includes `DUPLICATE_SUSPECT`, `REJECTED`, `FAILED`, `REVERSED`, and `REFUNDED`, but only a subset of transitions has a route.
- `webhook_events` has provider/event/status/payload/attempt fields, but no application webhook route or provider event processor exists under `app/api`.
- `communications` has channel/status/address/provider fields, but M7 only wires print reminders; no email/SMS/WhatsApp dispatch or delivery reconciliation exists.
- `payment_links` has creation, list, revoke, and public submit data, but no authenticated UI surface exposes those operations.
- `guardians` and `student_guardians` have schema, RLS, and M9 tenant guards, but no repository, API, or maintenance UI.
- `audit.read` exists in the permission matrix and audit rows are append-only, but there is no tenant audit-log viewer/API in the current route tree.
- `terms.closed_at`, `terms.closed_by`, `academic_sessions.status=CLOSED`, and state-machine documentation exist, but no production close/rollover route exists.

### 3.4 Genuinely absent

- `/api/reconciliation/queue` and the documented reconciliation action routes.
- A durable reconciliation-case/evidence model.
- A first-class unmatched/flagged review state distinct from the payment's financial status.
- A match-candidate workflow for a payer/reference/amount/date to one or more students/invoices.
- Bank-statement import or provider webhook intake.
- Import preview, row-level errors, duplicate-row detection, and commit/replay boundaries.
- A complete queue-driven reconciliation UI with filters, pagination, review timeline, evidence, and explicit resolution.

## 4. Current contradictions and risks

### 4.1 API contracts promise routes that are absent

`docs/API_CONTRACTS.md` documents:

- payment list filters for method, status, student, date range, and unreconciled state;
- `GET /api/payments/unreconciled`;
- `GET /api/reconciliation/queue`;
- `/confirm`, `/match-student`, `/resolve-duplicate`, `/allocate`, and `/flag` reconciliation routes.

The actual route tree contains none of the reconciliation routes. `GET /api/payments` accepts only an optional `status` filter and returns at most 200 records. The actual payment model also does not have the documented `student_id` field; student ownership is inferred through invoice allocations.

### 4.2 State-machine promises exceed route behavior

`docs/state-machines/PAYMENT.md` specifies duplicate-suspect and rejected transitions, matching evidence, late webhook flags, and reconciliation visibility. The implementation currently exposes only:

- create payment;
- pending → confirmed;
- confirmed → allocation;
- confirmed → reversal/refund/correction;
- receipt issuance.

There is no route for `CONFIRMED → DUPLICATE_SUSPECT`, `DUPLICATE_SUSPECT → CONFIRMED`, `DUPLICATE_SUSPECT → REJECTED`, `PENDING → REJECTED`, or a separate flagged case.

### 4.3 The current reconcile page is not a queue

`app/(app)/reconcile/page.tsx` fetches `/api/payments` and `/api/invoices`, filters and sums the response in the server component, then links to payment detail. It has no mutation controls, cursor, date/method filter, assignment filter, review status, evidence form, duplicate action, or case history. The payment detail page has operational buttons, but the operator must already know which payment to open and cannot resolve duplicate or unmatched cases.

### 4.4 Unreconciled counts are inconsistent

- `app/api/dashboard/summary/route.ts` counts `payments.status = 'PENDING'` for `unreconciledPayments`.
- The reconcile page separately calculates pending plus confirmed unallocated credit.
- The payments register treats `DUPLICATE_SUSPECT` as pending for a local summary, but the dashboard does not.

These surfaces cannot currently answer one consistent question: “What money needs a finance officer’s decision?”

### 4.5 Idempotency is uneven across financial mutations

The repository-level/API contract says mutations are idempotent, but the actual payment transition routes predate M9’s request-shape helper:

- `POST /api/payments` accepts an optional key and stores legacy method/path data without enforcing a request hash.
- `POST /api/payments/[id]/confirm` has status-based replay behavior but no durable request-key replay contract.
- `POST /api/payments/[id]/allocate` has no request-key replay boundary.
- `POST /api/payments/[id]/reverse` can replay by optional reversal reference, but reference is not a universal idempotency key and partial reversals may legitimately differ.

M10 must harden these boundaries without changing trigger-maintained financial meaning.

## 5. The exact M10 problem statement

A finance officer needs a single, tenant-safe, auditable queue that answers:

> Which incoming-money records need confirmation, student/invoice matching, allocation, duplicate review, rejection, reversal, or follow-up, and what evidence supports the decision?

The queue must support money already represented in Scolaira first:

- public payment-link submissions in `PENDING`;
- manually recorded `PENDING` transfers/cash/POS payments;
- confirmed payments with unallocated credit;
- payments that trigger duplicate/reference review;
- late or failed provider records if a future provider adapter supplies them.

M10 must not pretend that a payment row proves a bank account settlement. A `PENDING` record is an assertion awaiting verification; a `CONFIRMED` record is verified money under the school’s declared workflow; an allocation is the only operation that moves confirmed money onto an invoice.

## 6. Why not select another candidate first?

| Candidate | Evidence and dependency | M10 decision |
|---|---|---|
| **Reconciliation control plane** | Existing payment/allocations/triggers/routes are enough to build a safe manual queue; M8 now creates obligations and M9 creates the population; term close depends on reconciliation review. | **Selected. Immediate dependency.** |
| Bank statement import / Paystack webhooks | Structurally anticipated by `webhook_events` and roadmap, but bank formats, provider credentials, settlement timing, and unmatched-transfer frequency are explicitly unknown (`PRODUCT_DISCOVERY_BACKLOG` U-03/U-05/U-14/U-15). | Defer provider-specific ingest until real statement samples and provider policy are available. Design a boundary, do not guess a parser. |
| Term close / rollover / carry-forward | State fields and documentation exist, but close policy, owner acknowledgement, prior-term reporting, and unresolved-money behavior remain product questions. Closing before a usable reconciliation queue would freeze uncertainty. | Next after or alongside a proven reconciliation readiness contract; not the first M10 build slice. |
| Guardian/contact management | Tables and RLS exist, but no operational surface. It would improve reminders, not establish financial truth for incoming money. No field evidence proves it is the next dependency. | Defer. |
| Payment-link operator UI | Useful and narrow, but it improves one intake channel while cash, POS, bank transfer, and public PENDING records still lack a shared review loop. | Include only as a small supporting affordance if needed; not the milestone thesis. |
| Audit-log viewer | Valuable for trust and support, but audit rows already exist and do not currently block the money workflow. | Defer behind the reconciliation timeline requirements. |
| CSV student/history import | M9 explicitly selected controlled manual academic mutation; bulk import needs validation/rollback policy and field evidence. | Defer. |

## 7. Required invariants

### 7.1 Reconciliation-case invariants

1. Every reconciliation case belongs to exactly one organization and is visible only within that tenant.
2. A payment may have at most one active primary reconciliation case for a given unresolved reason; reopening a resolved case creates an auditable new case or explicit reopen event, not a duplicate hidden queue row.
3. A queue case never deletes or rewrites the underlying payment, allocation, reversal, invoice, receipt, or audit record.
4. The case status is not the payment financial status. Review metadata must not make a payment `CONFIRMED`, `REJECTED`, `REVERSED`, or `REFUNDED` without the explicit financial transition that owns that state.
5. A `PENDING` or `DUPLICATE_SUSPECT` payment cannot be allocated.
6. A confirmed payment may remain unallocated; that state must remain visible until an explicit allocation, rejection, reversal, or other approved resolution.
7. A duplicate decision must link to the original payment when one exists. It must not silently delete, merge, void, or rewrite either payment.
8. A student/invoice match is only a candidate until the operator explicitly confirms it. A candidate must be tenant-local and resource-validated.
9. One payment may be allocated across multiple invoices/students only through the existing allocation service and database triggers; no second balance ledger is introduced.
10. A flagged or evidence-only action has no financial side effect.

### 7.2 Financial and state invariants

11. `payment.amount_kobo` is positive and immutable; `unallocated_kobo` remains trigger-maintained.
12. Sum of active allocations never exceeds payment amount or invoice outstanding balance.
13. Confirmation, allocation, reversal, refund, and receipt issuance retain the existing state machines and append-only records.
14. A reversed/refunded payment never silently returns to `CONFIRMED`.
15. Receipt issuance remains limited to confirmed, allocated money and remains at most one `ISSUED` receipt per payment unless an existing receipt is explicitly voided and reissued.
16. A payment imported or manually recorded twice from the same source event is not double-counted; the duplicate outcome is visible and auditable.
17. Dashboard, payments register, reconciliation queue, debtors, and term-readiness counts use the same server-side predicates and agree on the meaning of “unresolved.”
18. No queue action changes an issued invoice or reminder snapshot unless the explicit financial route and state machine authorizes it.

### 7.3 Import invariants if a later provider/import slice is approved

19. Raw source rows are retained or content-addressed for audit; parsing/normalization is separate from financial commit.
20. The same provider event or import row cannot create two payment records.
21. Preview and validation never create payments, allocations, receipts, or invoice changes.
22. Commit is explicit, transactional, row-level error reporting is deterministic, and re-running the same batch is a safe replay.
23. Provider signature verification and provider-to-organization mapping happen before any tenant financial context is entered.

## 8. Required database changes

The minimum reconciliation-control-plane schema should be additive and forward-only. Exact names are implementation decisions for M10, but the design requires the following capabilities.

### 8.1 Reconciliation cases

Add a tenant-scoped `reconciliation_cases` table or equivalent with:

- stable case ID;
- organization ID auto-stamped from authenticated context;
- optional payment ID, and optional source-event/import-row ID;
- case kind such as `TO_CONFIRM`, `TO_ALLOCATE`, `DUPLICATE_REVIEW`, `UNMATCHED`, `FLAGGED`, or `LATE_EVENT`;
- case status such as `OPEN`, `IN_REVIEW`, `RESOLVED`, `REJECTED`, or `CLOSED`;
- reason, priority, assigned user, created/resolved timestamps;
- resolution type and linked original payment where relevant;
- immutable/auditable before/after resolution metadata.

Use a partial unique index or equivalent invariant for one active primary case per payment/reason. Preserve the underlying payment state machine; do not use case status as a shortcut for financial state.

### 8.2 Evidence and candidate records

Add a small evidence/candidate model rather than placing unreviewed evidence in financial columns:

- evidence kind, normalized reference, amount/date/name hints, note, source, content hash or external reference;
- candidate student/invoice/payment links with score/explanation and an explicit accepted/rejected decision;
- RLS/FORCE RLS and indexes by organization, case, payment, reference, and created time.

Do not add a single `payments.student_id` as a shortcut: one payment can legitimately cover multiple students, and allocations already provide the authoritative invoice relationship.

### 8.3 Optional import staging

If discovery supplies actual bank statements or a provider contract, add import batches and immutable raw/normalized rows separately from payments. The first M10 implementation should not create a bank-specific schema based only on the generic `webhook_events` table.

### 8.4 Existing financial tables

No M10 migration should rewrite invoice totals, payment balances, allocation status, receipt status, or reminder snapshots. Any needed indexes on current payment status/date/reference and active allocation lookups must be additive and verified against RLS and query plans.

All new tables must receive:

- tenant auto-stamping;
- RLS and FORCE RLS;
- runtime-role grants limited to intended operations;
- append-only or state-transition triggers where the record is evidence/audit;
- migration preflight and direct runtime-role tests.

## 9. Required API changes

### 9.1 Queue/read surfaces

- `GET /api/reconciliation/queue`
  - filters: case status/kind, payment status, method, date range, amount range, assigned user, term/student where derivable;
  - cursor pagination, deterministic order, stable totals/as-of timestamp;
  - no client-supplied organization ID.
- `GET /api/reconciliation/[id]`
  - payment, allocation, invoice/student candidates, evidence, audit timeline, and allowed next actions.
- `GET /api/reconciliation/[id]/candidates`
  - explainable candidates only; no opaque “AI matched” assertion.

### 9.2 Explicit action surfaces

- `POST /api/reconciliation/[id]/confirm` — confirm a pending payment with evidence/reason; no allocation unless a separate explicit allocation plan is included and accepted by policy.
- `POST /api/reconciliation/[id]/match` — accept a tenant-local candidate or supply explicit invoice/student IDs; does not allocate by implication.
- `POST /api/reconciliation/[id]/allocate` — call the existing allocation service, supporting one or multiple invoices with a deterministic total.
- `POST /api/reconciliation/[id]/duplicate` — link suspected duplicate to original and choose a non-financial review outcome; any rejection/reversal uses the existing financial transition path.
- `POST /api/reconciliation/[id]/flag` — record a reason/follow-up state with no financial mutation.
- `POST /api/reconciliation/[id]/resolve` — close a case only with a permitted resolution and complete audit metadata.

Every mutation must use:

- centralized authorization and CSRF;
- required idempotency key with scope, method, path, and request hash;
- transaction-local case/payment locking;
- audit event and durable replay response.

### 9.3 Consistency surfaces

- Extend `GET /api/payments` with server-side cursor/date/method/unallocated filters or make the reconciliation queue the only operational queue and remove contradictory promises from `docs/API_CONTRACTS.md`.
- Make dashboard unresolved counts derive from the same queue predicate rather than counting only `PENDING`.
- Keep existing payment routes as compatibility primitives, but either route them through the reconciliation service or explicitly document why their behavior differs.

### 9.4 Provider/import boundary

A later provider-specific route may be added only after real provider/sample evidence:

- verify signature/event identity before tenant context;
- persist the provider event idempotently;
- stage and validate the event;
- create/update a queue case;
- do not auto-confirm or auto-allocate an ambiguous event.

## 10. Required UI and workflow changes

### 10.1 Reconciliation queue

Replace the current read-only `/reconcile` snapshot with a real queue:

- tabs or filters for pending confirmation, unallocated, duplicate review, unmatched, flagged, and resolved history;
- server-side pagination and date/method/amount filters;
- amount, payer/reference, age, current status, proposed match, and next action visible in one row;
- queue totals that agree with dashboard and payment register;
- clear empty/loading/error states suitable for low-cost Android devices and unstable Nigerian networks.

### 10.2 Case detail/review

A finance officer should be able to:

1. inspect the payment and source context;
2. record evidence/reference/note;
3. see explainable student/invoice candidates;
4. confirm or reject the candidate;
5. allocate explicitly across one or more invoices;
6. resolve duplicate/flagged cases without deleting financial history;
7. see the immutable case/payment/audit timeline;
8. issue/open a receipt only through the existing explicit receipt path.

### 10.3 Entry-flow improvements

- Preserve the manual payment form for cash, POS, transfer, and other methods.
- Make “pending/unverified” versus “confirmed” explicit at entry.
- Preserve the same idempotency key across browser retry and network retry.
- Add a controlled link from public payment submissions and payment-detail pages into the queue.
- Do not hide an unresolved payment simply because the initial list is capped.

### 10.4 Optional import UX

Only after actual bank/provider samples are obtained:

- upload/receive a statement into a preview-only stage;
- show row errors, duplicate rows, amount/date/reference, and proposed matches;
- require explicit commit;
- never make upload itself a financial mutation.

## 11. Authorization model

Recommended initial matrix:

| Operation | OWNER | SCHOOL_ADMIN | FINANCE_OFFICER | STAFF |
|---|---:|---:|---:|---:|
| Read reconciliation queue/cases | yes | yes | yes | no |
| Add evidence/notes | yes | yes | yes | no |
| Confirm known pending payment | yes | yes | yes | no |
| Accept match and allocate | yes | yes | yes | no |
| Flag case | yes | yes | yes | no |
| Resolve duplicate as legitimate | yes | policy decision | yes | no |
| Reject/financially reverse duplicate | yes | policy decision | existing financial permission only | no |
| Commit external import batch | yes | policy decision | yes | no |
| Read-only platform support | existing platform support capability | n/a | n/a | n/a |

The implementation must not silently broaden or narrow the existing `payment.confirm`, `payment.allocate`, `payment.reverse`, or `payment.refund` permissions. If a new `reconciliation.manage` action is added, it must be mapped explicitly per role and tested with wrong-role, cross-tenant, and support-mode cases.

High-risk actions should retain separate permission and reason requirements even when initiated from the same queue. A queue case is not a permission bypass.

## 12. Tenant and RLS implications

- Every case, candidate, evidence, import batch, and raw row must carry organization context derived from the authenticated session or verified provider mapping.
- Client input may identify a payment/invoice/student, but never an organization.
- Cross-tenant payment/case IDs must return the existing safe not-found/forbidden behavior without leaking existence.
- New RLS policies must be tested under `scolaira_app`, not only under the owner/superuser migration principal.
- FORCE RLS must remain enabled for all new tenant tables.
- Evidence notes may contain payer PII. Do not expose them through public payment-link routes or broad dashboard aggregates.
- Public payment-link submissions remain restricted to creating `PENDING` payments and must not gain queue read or reconciliation mutation access.
- If webhooks/imports are added, the provider boundary must use a narrow signature/event resolver and cannot rely on a caller-supplied tenant ID.

## 13. Idempotency and concurrency implications

M10 must close the existing financial-route idempotency gap without changing financial truth.

- Require a key for every new reconciliation mutation and for confirm/allocate/reverse mutations when they are moved behind the reconciliation service.
- Validate key scope, organization/user, method, path, and request hash; replay the original status/body.
- Lock the reconciliation case and payment row before a transition.
- Confirm versus duplicate-review versus reverse must serialize on the same payment.
- Allocation must retain the existing deterministic payment/invoice lock order and trigger enforcement.
- Two operators accepting the same candidate must produce one accepted match and one durable replay/conflict, not two allocations.
- Two imports of the same provider event or source row must create at most one payment/case effect.
- Retry after an interrupted transaction must be safe whether the case row was committed or not.
- A late event for a reversed/refunded payment must create a flagged case and must not reopen the financial status.
- Queue ordering and pagination must be stable under concurrent case creation; use a cursor, not client-side array slicing.

## 14. Financial-boundary implications

M10 is a control-plane milestone, not a second ledger.

- Queue creation, evidence capture, candidate generation, and flagging have no financial side effect.
- Confirmation uses the existing payment state transition and audit path.
- Allocation uses the existing allocation repository and database triggers; M10 does not write `invoice.paid_kobo` or `payments.unallocated_kobo` directly.
- Duplicate resolution does not silently void, reverse, refund, or merge records. Those remain explicit financial actions with their existing permissions and reasons.
- Receipt issuance remains downstream of confirmed active allocations and the existing one-issued-receipt guard.
- No bank import or webhook event is allowed to auto-create an issued invoice, allocation, receipt, refund, or credit balance without an explicit accepted policy.
- Reminder snapshots remain immutable; reconciliation never edits an already-sent reminder.
- Term close/rollover and carry-forward remain separate policy-controlled operations. M10 may expose “reconciliation ready/not ready,” but must not invent carry-forward semantics.

## 15. Adversarial attack surface

M10 verification must include at least:

1. unauthenticated queue/action access;
2. missing and forged CSRF tokens;
3. wrong-role actions for STAFF, FINANCE_OFFICER, SCHOOL_ADMIN, and platform support mode;
4. cross-tenant case/payment/invoice/student/evidence IDs;
5. client-supplied organization IDs or forged tenant context;
6. idempotency-key reuse across method/path/body/scope and concurrent retries;
7. two operators confirming, matching, allocating, flagging, reversing, or resolving the same payment;
8. a duplicate reference with a different amount/payer and a different payment with a legitimate shared reference;
9. negative, zero, oversized, malformed, future-dated, and timezone-edge payment evidence;
10. allocation overpayment, duplicate allocation, cross-term allocation, and allocation to VOID/DRAFT/PAID invoices;
11. duplicate/replayed import rows or provider events;
12. late success/refund/reversal events after terminal payment states;
13. evidence and candidate PII leakage through queue filters, URLs, public links, logs, and dashboard totals;
14. CSV formula/path/name injection if file import is later approved;
15. pagination omissions/duplicates while queue rows are inserted or resolved;
16. direct SQL attempts through `scolaira_app` to bypass case status, tenant, financial, or append-only guards.

## 16. End-to-end acceptance criteria

M10 should not be considered complete until the following route-driven workflow passes against a fresh and upgraded real migrated database.

### Core known-payment workflow

1. Use the M9 workflow to create a current term, roster, fees, and an explicit M8 billed invoice set.
2. Record a bank-transfer/POS/cash payment as `PENDING` with payer/reference evidence and no allocation.
3. The payment appears exactly once in the reconciliation queue with the correct age, amount, tenant, and action state.
4. A finance officer records/attaches review evidence and confirms the payment in one audited transaction.
5. The queue exposes explainable invoice/student candidates without asserting an automatic match.
6. The operator explicitly accepts a candidate and allocates to one or more invoices through existing financial triggers.
7. `payment.unallocated_kobo`, invoice paid/outstanding/status, debtor balances, dashboard counts, and queue state agree in direct SQL and API responses.
8. A receipt is available only after confirmed allocation and follows the existing receipt/idempotency rules.
9. A retry with the same key returns the same response; a changed request shape is rejected.

### Unresolved/duplicate workflow

10. A public payment-link submission creates a `PENDING` payment and opens a queue case; no invoice/payment balance changes before confirmation/allocation.
11. A payment with a suspected duplicate reference is flagged without deletion or financial reinterpretation.
12. The operator can link the suspected duplicate to the original, mark it legitimate, or route it to the approved rejection/reversal action; every outcome is audited.
13. A flagged/unknown payment remains visible until an explicit resolution; no “empty queue” claim hides it.

### Concurrency/security workflow

14. Concurrent confirmations resolve to one financial transition.
15. Concurrent accepted matches create at most one active allocation effect.
16. Concurrent duplicate/import retries create one durable case/payment effect.
17. Foreign-tenant, wrong-role, unauthenticated, CSRF-failed, and forged-key requests fail without data leakage.
18. New reconciliation tables have RLS/FORCE RLS and runtime-role privilege tests.
19. Dashboard, payment register, and reconciliation queue use the same unresolved predicate and reconcile their totals.
20. Existing M5–M9 regression, TypeScript, production build, migration upgrade, `git diff --check`, and M8 concurrency verification remain passing.

### Provider/import boundary

Provider webhook or bank-statement acceptance is **not** part of the core acceptance gate until actual provider credentials/sample statements and a signed product decision exist. If included later, it requires separate preview/commit/replay acceptance and must not be hidden behind the manual workflow tests.

## 17. Explicit non-goals

- No new billing engine, fee model, invoice ledger, or parallel balance ledger.
- No academic roster rebuild; M9 is frozen and remains the source of academic truth.
- No automatic allocation heuristics presented as authoritative matching.
- No bank-specific CSV parser or Paystack production integration without real sample/provider evidence.
- No wallet, credit balance, installment plan, or cross-term carry-forward policy.
- No term close, session close, rollover, or prior-term carry-forward mutation.
- No guardian/contact CRUD, external SMS/email/WhatsApp dispatch, or parent portal.
- No multi-currency or offline-first mobile app.
- No AI/fuzzy match whose reasoning cannot be explained and audited.
- No audit-log redesign; only the case timeline/evidence needed for reconciliation.
- No changes to public payment-link read/submit boundaries.
- No unrelated cleanup, refactor, or changes to M5–M9 frozen history.

## 18. Open product-policy questions

These require founder/finance-officer or pilot-school evidence; they must not be guessed in implementation:

1. What evidence is sufficient to confirm a bank transfer, POS settlement, or cash payment: bank-alert reference, statement row, teller number, receipt book number, attached file, or a combination?
2. May a finance officer confirm a payment without a bank/evidence reference when the school physically received cash?
3. Which roles may mark a payment as legitimate after duplicate suspicion, and which roles may reject or reverse it?
4. Should one parent payment covering siblings be represented as one payment with multiple allocations, and what minimum payer/relationship data is needed?
5. When a payment reference is missing or reused, what matching hints are acceptable and what must remain manual?
6. Should `PENDING` payment confirmation and invoice allocation be separate operator steps or a reviewed two-step action with one final commit?
7. What exact Nigerian bank/POS statement formats are used by the first pilot school, and how often are statements exported?
8. Should import staging retain the original file, row text, or only a content hash plus normalized fields, considering NDPR and retention requirements?
9. How should wrong-account payments and payments intended for another school be recorded without contaminating the tenant ledger?
10. What unresolved-payment threshold and owner acknowledgement should be required before a future term-close/rollover action?
11. Should the queue support assignment to a named finance officer, and what SLA/aging buckets matter operationally?
12. When a confirmed payment is later found to be wrong, is the approved action reversal, refund, correction, or a new replacement payment?
13. Should receipt issue remain a separate explicit action, or may a fully allocated confirmed payment offer a clearly separate receipt action from the queue?
14. What retention, redaction, and access rules apply to evidence notes, payer phone numbers, and uploaded statement rows?

No customer interviews, bank statements, provider credentials, live school workflow observations, or production analytics are available in this repository. These questions are therefore open rather than silently resolved by assumption.

## 19. Deliberately deferred work and rationale

- **Bank/Paystack ingestion:** deferred until provider contracts, credentials, settlement timing, and actual statement samples exist. The generic `webhook_events` table is not evidence that a provider integration is ready.
- **Term close/rollover/carry-forward:** deferred until reconciliation readiness and owner policy are explicit; closing an unresolved term can create irreversible operational ambiguity.
- **Guardian/contact and outbound communications:** deferred because the current reminder model is print-first and no field evidence establishes the next channel or contact workflow.
- **Payment-link management UI:** deferred as a narrow intake-surface improvement; its resulting PENDING payments are part of the selected queue problem.
- **CSV student/history import:** deferred because M9 intentionally chose controlled manual roster mutation and bulk import needs a validation/rollback policy.
- **Audit viewer:** deferred as a separate surface; M10 should expose the reconciliation case timeline and preserve the existing audit stream.
- **Wallet, carry-forward, multi-currency, parent portal, mobile app, AI matching, and reporting expansion:** remain outside the dependency path and retain their existing deferral rationale.

## 20. Reconnaissance conclusion

The codebase does not need another foundation milestone. It needs the missing operational control plane that turns payment records into reviewed, explainable, tenant-safe financial outcomes without weakening M5–M9 truth.

The selected M10 capability is therefore **reconciliation control**, beginning with a queue/evidence/matching/resolution workflow for known payments and leaving provider-specific ingestion behind explicit discovery and policy gates.

READY FOR M10 BUILD
