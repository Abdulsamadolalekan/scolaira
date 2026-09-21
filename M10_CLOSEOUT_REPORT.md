# SCOLAIRA M10 CLOSEOUT REPORT — RECONCILIATION CONTROL PLANE

**Date:** 2026-09-21 (Africa/Lagos)
**Status:** Implemented and verified against the migrated application and test databases
**Selected capability:** Reconciliation control plane over the existing authoritative financial system
**Final implementation tree verified:** `783ad2b7d76c4ce1c19c551183e88ae4e0359ff8`

This closeout records the M10 implementation, the real-database verification performed for it, the exact regression/build evidence, and the remaining product-policy limitations. It does not claim bank/provider ingestion, automatic matching, or a new source of financial truth.

## 1. Executive result

M10 adds a tenant-safe, authorization-controlled reconciliation workflow for known payment records:

- a cursor-paginated operational queue;
- explicit `UNMATCHED`, `FLAGGED`, `RECONCILED`, and `ALLOCATED` case states;
- append-only human-entered evidence;
- explicit human student/invoice candidates;
- durable case history and audit timelines;
- guarded confirm, match, allocate, flag, unflag, and resolve operations;
- a dashboard/queue detail surface with payment identity, amount/date/method/reference, allocation context, evidence, prior cases, and permitted actions;
- integration with the authoritative payment-recording path for new pending/unallocated payments; and
- no reconciliation-owned payment, allocation, invoice, receipt, reversal, refund, or balance totals.

Financial effects remain in the existing payment, allocation, invoice, reversal, refund, and receipt repositories/triggers. M10 only records operational decisions and delegates the actual allocation/confirmation behavior to existing financial mechanisms.

The final full regression passed **28 test files and 257 tests**. TypeScript, production build, formatting checks, targeted M10 tests, migration upgrade/idempotency, RLS/tenant isolation, runtime-role restrictions, and the frozen M5–M9 suite all passed as described below.

## 2. Frozen milestone lineage and exact SHA evidence

No M1–M9 commit was amended, rebased, rewritten, or reopened.

| Milestone | Frozen commit / target | Tag or evidence |
| --- | --- | --- |
| M5 | `0c66618e29e6179c80052a82c40f669979cef6b` | `M5-FROZEN` |
| M6 | `3668854682e39c7ef5ce1ec2647f85d6c6b8ced9` | Frozen M6 target |
| M7 | `86beba9742c31bcb3ce01d96934b06e9e4a7d445` | M7 closeout target |
| M8 | `9989e6334c51ca61f43af4cd938a146c24fd054e` | `m8-controlled-term-billing` resolves to this commit |
| M9 implementation | `ce4b9230e60f15dbc0cca1e8c5d6ecc25e2a6b7e` | M9 implementation |
| M9 freeze | `791b6e09ad211eac470e6011e28172b1ff925575` | `m9-academic-control-layer` resolves to this commit |
| M10 primary implementation | `6082a1fa84878d1de2047a811584bfbee0bf2155` | `M10: add reconciliation control plane` |
| M10 authorization coverage | `87baf05549203b4190163bb035d259475d9aaa83` | `M10: cover reconciliation authorization policy` |
| M10 dashboard contract clarification | `512a82a9b602e6e42b1fefb90fdf954da7e3f14f` | `M10: clarify paged reconciliation summaries` |
| M10 concurrency-test hardening | `783ad2b7d76c4ce1c19c551183e88ae4e0359ff8` | `M10: verify concurrent candidate decisions` |

The closeout documentation commit is intentionally separate from the implementation SHA recorded above. The final authorized closeout commit is the commit that adds this report; its exact SHA is recorded in the final `git log`/`git rev-parse HEAD` evidence after the report is staged.

## 3. Implementation inventory

### 3.1 Database and schema

- `lib/db/migrations/0023_m10_reconciliation_control_plane.sql`
  - creates `reconciliation_cases`, `reconciliation_evidence`, and `reconciliation_candidates`;
  - adds one-open-case-per-payment uniqueness;
  - adds tenant-reference guards for payment, case, student, invoice, and assignee relationships;
  - adds database transition/shape guards;
  - adds append-only evidence enforcement;
  - enables and **forces** RLS on all three tables;
  - adds tenant policies and operational indexes; and
  - leaves monetary fields out of all M10 tables.
- `lib/db/migrations/0024_m10_decision_shape_guards.sql`
  - requires closed cases to have a terminal state, resolver, and resolution time;
  - requires allocated cases to be closed; and
  - requires decided candidates to retain a decision actor/time and prevents decided-candidate state mutation.
- `lib/db/schema/reconciliation.ts` contains the Drizzle control-plane types/relations.
- `lib/db/repo/reconciliation.ts` contains tenant-scoped case/evidence/candidate access and queue SQL. Its queue union covers both explicit cases and unresolved legacy payments that predate M10.

### 3.2 Service and route boundary

- `lib/reconciliation/index.ts` owns payment locking, evidence requirements, explicit candidate decisions, optimistic case-state updates, and delegation to authoritative allocation behavior.
- `app/api/reconciliation/queue/route.ts` validates all filters with Zod: `state`, `kind`, `paymentStatus`, `unallocatedOnly`, `limit`, and `cursor`.
- `app/api/reconciliation/payments/[id]/route.ts` returns payment identity, integer-kobo amount fields, allocations, current case, evidence, candidates, audit timeline, and earlier case summaries.
- The mutation routes are:
  - `POST /api/reconciliation/payments/:id/evidence`
  - `POST /api/reconciliation/payments/:id/confirm`
  - `POST /api/reconciliation/payments/:id/match`
  - `POST /api/reconciliation/payments/:id/allocate`
  - `POST /api/reconciliation/payments/:id/flag`
  - `POST /api/reconciliation/payments/:id/resolve`
- `app/api/payments/route.ts` now opens an explicit `UNMATCHED` case for newly recorded `PENDING` or unallocated payments. The queue still derives unresolved payments created before M10, so no historical record must be rewritten to become visible.
- The confirm route calls the existing `payRepo.confirm` state-machine repository. The allocate route calls the existing invoice/payment allocation repository and therefore retains the existing financial triggers and race protections.

### 3.3 Dashboard and queue

- `app/(app)/reconcile/page.tsx` is a permission-gated server dashboard.
- `app/(app)/reconcile/reconciliation-queue.tsx` provides expandable detail, evidence entry, confirm/match/allocate/flag/unflag/resolve controls, cursor loading, and “Earlier cases”.
- Summary cards are explicitly labelled as describing the currently loaded page; they do not pretend that a 50/100-row page is a global count.
- The queue consistently classifies a confirmed payment with positive `unallocatedKobo` as `TO_MATCH`, not `TO_ALLOCATE`.

## 4. No shadow ledger / authoritative financial boundary

M10 does **not** create or maintain a second financial truth.

- `reconciliation_cases` stores payment identity, state, workflow kind, actor/time, reason, resolution fields, assignment, and an optimistic version. It has no amount, balance, paid total, allocation total, invoice total, receipt total, reversal total, or refund total.
- `reconciliation_candidates` stores an explicit human-selected student/invoice context and the operator's basis. It does not copy a payment or invoice balance.
- `reconciliation_evidence` stores durable evidence metadata, references, notes, optional observation time, and optional content hash. It is not a bank-ingestion ledger.
- Queue amount/status/allocation data is read from `payments`, `payment_allocations`, `invoices`, and `students`.
- Confirming a payment uses the existing payment repository/state machine.
- Allocating uses the existing allocation repository and database triggers; M10 never writes invoice paid/outstanding totals or payment unallocated totals.
- Reversal, refund, receipt, and correction consequences remain on their existing routes and state machines. M10 resolve explicitly returns `financialAction: "none"`.
- No destructive correction path, record merge, silent delete, or financial reinterpretation was introduced.

## 5. State model, actors, preconditions, and concurrency

### 5.1 States and transitions

| Transition / action | Actor and precondition | Durable evidence/audit | Concurrency behavior |
| --- | --- | --- | --- |
| Case creation → `UNMATCHED` | Authenticated authorized reviewer or authoritative payment-recording path; payment is tenant-visible. | `created_by`/`created_at`; later case/evidence decisions are audited. | Partial unique index permits only one open case per payment; `ensureOpenCase` converges concurrent creators. |
| `UNMATCHED → FLAGGED` | `reconciliation.review`; required reason. | Case audit with before/after state and reason. | Case row is versioned and updated with a compare-and-swap predicate. |
| `FLAGGED → UNMATCHED` | `reconciliation.review`; explicit unflag request and reason. | `reconciliation.unflag` audit; previous state is preserved/cleared deterministically. | Closed cases cannot be reopened; stale update returns conflict. |
| `FLAGGED/UNMATCHED/RECONCILED → RECONCILED` | Evidence is required. Either an explicit human candidate is accepted or an exception is explicitly resolved. | Candidate audit plus case transition audit, or resolve audit with code/note. | State update checks current version and open-case status. |
| `PENDING → CONFIRMED` payment | `reconciliation.review`; evidence required; flagged cases must first be unflagged. | Existing `payment.confirm` audit plus `reconciliation.confirm` case audit. | Existing payment lock/state-machine behavior is retained. |
| `RECONCILED/UNMATCHED → ALLOCATED` | Confirmed payment, accepted human candidate, valid existing invoice allocation request, and evidence. | Existing `payment.allocate` audit plus `reconciliation.allocate` case audit. | Existing allocation/invoice locking and financial race protections remain authoritative; an allocated case is closed. |
| `RECONCILED → FLAGGED` | Authorized reviewer with a reason. | `reconciliation.flag` audit. | Versioned case update; closed cases are rejected. |
| Open exception → closed `RECONCILED` | `reconciliation.resolve`, evidence, resolution code, and non-empty note. No financial action is performed. | `reconciliation.resolve` audit with `financialAction: none`, actor, code, and note. | Database shape guard requires resolver/time/terminal state; closed case cannot change. |

Database triggers reject invalid transitions, allocated-open shapes, closed-nonterminal shapes, cross-tenant references, candidate state mutation after decision, and backward case versions. The service layer adds authorization, evidence, idempotency, and audit requirements.

`confirm` deliberately does not invent a reconciliation state transition merely because a payment status changed: it updates the authoritative payment and changes the operational kind to `TO_MATCH` or `TO_ALLOCATE` while retaining the case's review state. `match` is the explicit human decision that establishes `RECONCILED`; `allocate` closes a fully allocated case as `ALLOCATED`.

### 5.2 Evidence and candidate rules

- Evidence requires a human-entered reference or note and is inserted append-only.
- Evidence kinds are explicit: `BANK_REFERENCE`, `CASH_RECEIPT`, `POS_SLIP`, `OPERATOR_NOTE`, and `PROVIDER_EVENT`.
- No file upload, provider parser, fuzzy match, confidence score, AI score, or automatic financial decision exists.
- A candidate requires a student or invoice and a non-empty human basis. Invoice/student tenant and identity consistency are checked in both service and database guards.
- One accepted candidate per case is enforced by a partial unique index. Candidate decisions are audited and immutable after decision.

## 6. API and dashboard contract

### 6.1 Contract decisions

- Existing financial APIs use integer `*Kobo` fields; the UI formats those values as Naira. M10 documents the implemented contract rather than the earlier aspirational Naira-string example.
- Organization context is always derived from the authenticated tenant context. No M10 route accepts a client-selected organization ID.
- GET queue filters are schema-validated and cursor-paginated.
- Queue rows expose payment number, status, method, amount, unallocated balance, payment/reference dates, payer/reference context, allocation context, evidence count, case kind/state, and assignment.
- Detail returns current and earlier reconciliation cases so a closed prior decision does not disappear from operational history.
- Mutations return deterministic JSON error envelopes and use the existing centralized auth/CSRF boundary.

### 6.2 Authorization matrix

`lib/authz/permissions.ts` adds three explicit actions:

- `reconciliation.read`
- `reconciliation.review`
- `reconciliation.resolve`

`OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` receive the three actions. `STAFF` receives none. Platform support mode is read-only and cannot invoke reconciliation mutations. The route layer uses `withAuthorizedRoute`; the test-only plain `Request` query fallback in `lib/authz/index.ts` preserves the same schema validation when Next's `nextUrl` is absent.

## 7. Tenant isolation, RLS/FORCE RLS, and runtime role

The direct PostgreSQL catalog audit was run against the migrated application database after M10 migration application.

### 7.1 Role attributes

```text
ROLE|scolaira_app|false|false|false|false|false
```

The fields are `rolsuper`, `rolinherit`, `rolcreaterole`, `rolcreatedb`, and `rolbypassrls`. Therefore `scolaira_app` remains `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, and `NOBYPASSRLS`.

### 7.2 M10 RLS catalog result

```text
reconciliation_candidates|true|true
reconciliation_cases|true|true
reconciliation_evidence|true|true
```

All three M10 tables have RLS enabled and forced. Their policies derive visibility and write checks from the authenticated tenant GUC, with the same platform-context boundary used by the existing tenant model. Cross-tenant payment/case/evidence/candidate references are also rejected by M10 trigger guards.

The same RLS/FORCE RLS result was verified on both `scolaira` and `scolaira_test` after migration setup.

### 7.3 Runtime privilege result

Table-level grants for `scolaira_app` are only:

```text
reconciliation_cases       INSERT, SELECT
reconciliation_candidates  INSERT, SELECT
reconciliation_evidence    INSERT, SELECT
```

Column-level update grants are:

```text
reconciliation_cases:
  closed_at, kind, previous_state, reason, resolution_code,
  resolution_note, resolved_at, resolved_by, state, version
reconciliation_candidates:
  decided_at, decided_by, state
reconciliation_evidence:
  none
```

The migration runner, test bootstrap, and M8 verification setup all reapply these restrictions after their broad bootstrap grants. Evidence has no runtime update/delete privilege and also has an append-only database trigger.

### 7.4 Executed isolation checks

- `tests/db/m10-reconciliation.test.ts` proves a tenant-B context sees zero tenant-A queue rows and cannot insert a case referring to tenant-A payment data.
- `tests/db/tenant-isolation.test.ts` proves cross-tenant invoice/payment/allocation denial and tenant-scoped joins.
- `tests/auth/rls-bypass-regression.test.ts` proves cold-connection default denial, invalid platform-context denial, forged platform identity denial, and runtime-role `NOBYPASSRLS` behavior.
- `tests/auth/runtime-role-safety.test.ts` passes in the final regression.

## 8. Idempotency and auditability

All six M10 mutation routes call the existing durable M9 idempotency implementation with a required `Idempotency-Key` and route-specific scope/path/payload hash.

- Same-key retries replay the original response and mark the replay header.
- Same-key changed-payload reuse is rejected by the existing idempotency hash boundary.
- Idempotency records and the financial/control writes are completed in the same transaction.
- The existing authorized `app/api/receipts/route.ts` uniqueness-race replay hardening remains untouched.
- The authoritative payment-recording path retains its existing idempotency behavior and now opens a control case without changing payment semantics.

The case/evidence/candidate workflow records:

- evidence-add audit;
- payment-confirm audit through the existing financial audit path;
- candidate acceptance audit;
- case state before/after audit with request ID/payment ID metadata;
- allocation audit through the existing payment allocation path; and
- resolution code/note and explicit no-financial-action audit.

The detail endpoint merges payment and case audit entries and exposes earlier case summaries, so previous decisions remain visible rather than being overwritten.

## 9. Adversarial and concurrency verification

### 9.1 M10-specific database tests

`tests/db/m10-reconciliation.test.ts` passed **4/4** and covers:

1. derived queue visibility without a financial shadow record; durable evidence requirement; evidence immutability; and absence of monetary columns on the case result;
2. tenant isolation and cross-tenant case-write denial;
3. illegal, closed, and malformed transition denial, including evidence-required terminal decisions; and
4. concurrent open-case creation converging to one case per payment plus concurrent accepted-candidate decisions converging to one accepted candidate.

The concurrent candidate test expects one winner and one conflict from the partial unique index, then directly verifies exactly one `ACCEPTED` candidate.

### 9.2 M10-specific HTTP tests

`tests/auth/m10-reconciliation.test.ts` passed **2/2** and covers:

- the explicit evidence → confirm → human student match workflow;
- integer-kobo response contract;
- durable evidence replay with the same key;
- missing idempotency key rejection;
- missing CSRF rejection;
- detail response with evidence, candidate, current state, and allocation balance;
- centralized role policy for owner/admin/finance and STAFF/platform-support denial; and
- the queue query-parser compatibility path for a plain test `Request`.

### 9.3 Existing financial and security adversarial suites

The final full regression also passed:

- `tests/db/financial-attacks.test.ts`: **14/14**, including negative money, invoice/payment balance trigger protection, append-only allocation/reversal checks, over-allocation denial, and reversal bounds;
- `tests/db/concurrency.test.ts`: **3/3**, including allocation contention and concurrent legitimate payments;
- `tests/db/tenant-isolation.test.ts`: **10/10**;
- `tests/auth/rls-bypass-regression.test.ts`: **9/9**;
- `tests/auth/authz.test.ts`: **29/29**;
- `tests/db/audit.test.ts`: **7/7**;
- `tests/db/idempotency.test.ts`: **5/5**; and
- `tests/auth/runtime-role-safety.test.ts`: **2/2**.

The known frozen auth-harness transaction warnings remain visible in the full run: **35** PostgreSQL `25001` (“already a transaction is in progress”) and **35** `25P01` (“there is no transaction in progress”). They are legacy M5–M8 harness behavior; all affected tests pass and no M10 financial failure is hidden behind an aggregate count.

The standalone M8 verifier result recorded in the frozen M9 closeout remains valid: concurrent billing produced exactly one invoice, one invoice line, and one `BILLED` term. M10 does not change that billing path.

## 10. Migration and database evidence

### 10.1 Upgrade/idempotency

The application database was migrated with:

```text
npm run db:migrate
[db] migrations applied. new=0 total=24
```

The final integration setup recreated/migrated the test database and reported:

```text
[test-db] migrations applied. new=24 total=24
```

A direct owner catalog query on both `scolaira` and `scolaira_test` returned:

```text
24
24|0024_m10_decision_shape_guards
23|0023_m10_reconciliation_control_plane
```

No migration was destructive. M10 migrations are forward-only and the journal contains entries through `0024_m10_decision_shape_guards`.

### 10.2 Migration safety

- Tenant references are guarded in triggers and foreign keys.
- RLS is enabled and forced within the migration.
- Runtime privilege hardening is re-applied after migration execution.
- One-open-case and one-accepted-candidate uniqueness are database-enforced.
- State-shape and evidence immutability are database-enforced.
- No existing payment, allocation, invoice, receipt, reversal, refund, academic, reminder, or public payment-link record is deleted or rewritten.

## 11. Regression, TypeScript, build, and working tree

Final commands executed against the final implementation tree:

```text
SCOLAIRA_SESSION_SECRET=<test fixture secret> \
SCOLAIRA_DEV_ECHO_RESET_TOKEN=1 npm test
→ Test Files  28 passed (28)
→ Tests       257 passed (257)

npm run typecheck
→ PASS (tsc --noEmit)

git diff --check
→ PASS

Prettier checks for changed M10 TypeScript/Markdown files
→ PASS

npm run build
→ Compiled successfully
→ M10 reconciliation API routes and /reconcile compiled
```

The build output contains the repository's existing warnings but no compilation failure. M10 routes compiled as dynamic server routes:

```text
/api/reconciliation/queue
/api/reconciliation/payments/[id]
/api/reconciliation/payments/[id]/evidence
/api/reconciliation/payments/[id]/confirm
/api/reconciliation/payments/[id]/match
/api/reconciliation/payments/[id]/allocate
/api/reconciliation/payments/[id]/flag
/api/reconciliation/payments/[id]/resolve
/reconcile
```

Before adding this report, `git status --short` was clean at `783ad2b7d76c4ce1c19c551183e88ae4e0359ff8`. The report is the only expected working-tree addition before the authorized closeout-documentation commit.

## 12. Explicit non-goals and limitations

The following are intentionally not implemented and are not claimed by this closeout:

- bank statement, webhook, POS, or provider ingestion;
- fuzzy, heuristic, confidence-scored, or AI matching;
- automatic financial decisions or automatic allocation;
- uploaded evidence files or a provider-specific import staging area;
- a parent/guardian portal;
- term close, session close, rollover, carry-forward, wallets, credit, installments, or multi-currency;
- a new receipt, refund, reversal, or correction semantics;
- destructive correction, record merge, or financial reinterpretation;
- unrelated reporting expansion; and
- global queue totals in the four summary cards. They are explicitly page-scoped; cursor pagination is the source for additional work.

Product-policy questions remain for a future policy-gated extension: minimum evidence by payment method, duplicate-reference disposition, wrong-account payments, role-specific rejection/reversal policy, evidence retention/redaction, assignment/SLA policy, and whether confirmation and allocation should remain two reviewed steps. M10 leaves those ambiguities visible instead of guessing.

## 13. Closeout conclusion

M10 is ready as a controlled reconciliation layer over the frozen M1–M9 system. It establishes an auditable, tenant-safe human review loop while preserving the existing authoritative financial state machines and runtime-role boundaries. The exact final implementation SHA before this report is:

```text
783ad2b7d76c4ce1c19c551183e88ae4e0359ff8
```

The authorized closeout-documentation commit must contain this report only, use the required Scolaira identity, and leave the working tree clean.
