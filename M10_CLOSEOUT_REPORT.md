# SCOLAIRA M10 CLOSEOUT REPORT — RECONCILIATION CONTROL PLANE

**Freeze date:** 2026-09-21 (Africa/Lagos)
**Status:** M10 accepted as PASS and ready for immutable freeze
**Capability:** Tenant-safe reconciliation control plane over the existing authoritative financial system
**M10 implementation baseline before final freeze:** `43b406962f05b2cb83af94b4b296f47fb3f76878`
**Authoritative freeze tag:** `m10-reconciliation-control-plane`
**Authoritative closeout commit:** the exact SHA is recorded by the post-commit `git rev-parse` verification and final freeze handoff below.

This closeout records the final M10 implementation, adversarial audit, regression evidence, database evidence, freeze lineage, and the remaining operational condition. It does not claim bank/provider ingestion, automatic or heuristic matching, AI matching, a new financial ledger, or any other M10 non-goal.

## 1. M10 scope and result

M10 adds a human-controlled reconciliation layer for known payment records:

- a tenant-scoped, cursor-paginated queue and payment detail surface;
- explicit `UNMATCHED`, `FLAGGED`, `RECONCILED`, and `ALLOCATED` case states;
- durable operator/provider evidence;
- explicit human student/invoice candidates;
- retained case history and audit timelines;
- guarded confirm, match, allocate, flag, unflag, and resolve operations;
- server-truth payment, allocation, invoice, student, evidence, candidate, and history display; and
- integration with existing authoritative payment confirmation/allocation paths without creating a second financial truth.

M10 does not add bank/provider ingestion, automatic or heuristic matching, AI matching, guardian/student portals, term rollover, wallets/credit, installments, multi-currency, or unrelated reporting expansion.

**Freeze decision:** PASS. No M1–M9 historical commit was amended, rewritten, reopened, or financially reinterpreted. No M11 work is authorized.

## 2. Frozen lineage and exact repository surface

The frozen milestone references remain unchanged:

| Milestone | Frozen commit                              | Tag/evidence                 |
| --------- | ------------------------------------------ | ---------------------------- |
| M5        | `0c66618e29e6179c80052a82c40f669979cef6b`  | `M5-FROZEN`                  |
| M6        | `3668854682e39c7ef5ce1ec2647f85d6c6b8ced9` | frozen M6 target             |
| M7        | `86beba9742c31bcb3ce01d96934b06e9e4a7d445` | M7 closeout target           |
| M8        | `9989e6334c51ca61f43af4cd938a146c24fd054e` | `m8-controlled-term-billing` |
| M9        | `791b6e09ad211eac470e6011e28172b1ff925575` | `m9-academic-control-layer`  |

The committed M10 history begins at `6082a1f` and includes authorization, dashboard-contract, and concurrency-test hardening commits through baseline `43b4069`. The final freeze commit adds the audit remediation, forward migrations `0025`–`0036`, finalized regression tests, and both security/closeout reports as one authorized M10 closeout.

The final M10 surface consists only of reconciliation control-plane implementation, its tenant/auth/database hardening, the related dashboard/queue/API contract corrections, M10 adversarial tests, the E2E security-contract corrections needed for complete verification, migration metadata, and M10 closeout documentation. No unrelated cleanup or refactoring was introduced.

## 3. Reconciliation state model

Supported case states are `UNMATCHED`, `FLAGGED`, `RECONCILED`, and `ALLOCATED`.

- `UNMATCHED -> FLAGGED` records an exception and reason.
- `FLAGGED -> UNMATCHED` restores the recorded prior state.
- `FLAGGED -> RECONCILED` is permitted only after reviewed restoration of a reconciled case.
- `UNMATCHED -> RECONCILED` requires evidence and a valid human decision/candidate.
- `RECONCILED -> FLAGGED -> RECONCILED` preserves the prior state through the forward-only `0033` guard fix.
- `RECONCILED -> ALLOCATED` is only the allocation workflow's reflection of a fully allocated authoritative payment and accepted candidate; it closes the case.
- `ALLOCATED` and all closed cases are terminal. Closed cases cannot be reopened, edited, or given late evidence/candidates.

Invalid transitions, forged prior states, stale versions, missing evidence, terminal updates, and allocated-open shapes are rejected by the service and/or database boundary. The database state machine remains authoritative against direct SQL bypass.

## 4. Evidence model and durable history

`reconciliation_evidence` is a tenant-scoped, durable append-only record with:

- explicit kind: `BANK_REFERENCE`, `CASH_RECEIPT`, `POS_SLIP`, `OPERATOR_NOTE`, or `PROVIDER_EVENT`;
- reference and/or non-empty note;
- optional observed time, content hash, and metadata;
- authenticated creator and database-maintained creation time; and
- restrictive linkage to its reconciliation case.

Evidence update/delete is blocked by runtime privileges and an immutable database trigger. Decisions require evidence. Case history is retained rather than deleted or merged. Closed-case state, resolution actor/time, resolution code/note, and linkage are protected by forward terminal-history guards. Candidate decisions retain actor/time and decided candidates cannot be moved to another case.

Audit events cover evidence, payment confirmation, candidate acceptance, case transitions, allocation, and resolution. Before/after state, actor, request/correlation context, reason, and payment/case linkage are retained. Audit writes use the database clock for deterministic newest-first history when multiple rows are created in one transaction.

## 5. Candidate model

`reconciliation_candidates` records an explicit human-selected student and/or invoice plus a non-empty human basis. It does not allocate money or copy a financial balance.

- Candidate student/invoice relationships are tenant-checked in service joins and database triggers.
- A candidate cannot be inserted or accepted for a flagged, allocated, or closed case.
- Only one accepted candidate is allowed per case through `m10_reconciliation_one_accepted_candidate_idx`.
- Candidate decisions are audited and immutable after decision.
- Decided candidate linkage cannot be rewritten by direct SQL (`0036`).

No fuzzy, heuristic, confidence-scored, AI, provider, or automatic matching path exists.

## 6. Queue, dashboard, and server-truth workflow

The queue exposes authoritative payment number, status, method, amount, unallocated amount, dates, payer/reference context, allocations, case kind/state, assignment, evidence count, and accepted candidate context. Explicit open cases suppress duplicate derived rows. Confirmed payments with positive authoritative unallocated balance derive `TO_MATCH`; pending and duplicate-suspect payments derive their appropriate work; fully allocated payments do not receive false derived work.

The detail API:

- prefers an open case over closed history;
- exposes derived current work after a previous case closes if the payment still needs work;
- returns all retained closed cases as history;
- joins allocations to tenant-matching invoices and students;
- aggregates payment audits and audits for every retained reconciliation case; and
- exposes actions based on server-returned state, not client-supplied financial truth.

Queue pagination uses a PostgreSQL epoch-microsecond sort key plus payment UUID. Previously issued canonical ISO cursors are accepted at millisecond precision; malformed cursors remain a 400. Queue summaries are explicitly page-scoped rather than falsely presented as global counts.

## 7. Tenant/RLS and authorization boundaries

M10 mutations use the centralized authorization wrapper and require authentication, tenant membership, capability authorization, CSRF, validated input, transaction scope, idempotency, and audit coverage. `OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` receive the reconciliation capabilities; `STAFF`, public-link contexts, and platform-support read-only contexts cannot mutate reconciliation.

Organization context is derived from authenticated tenant context. No M10 endpoint accepts a client organization ID to establish scope. Repository queries repeat organization predicates in joins and filters; the database adds tenant-matching triggers and RLS.

Against the real migrated database at `0036`:

- `scolaira_app` remains `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, and `NOBYPASSRLS`;
- all three M10 tables have RLS enabled and FORCE RLS enabled;
- exactly three M10 tenant policies are installed;
- policies call centralized `auth_is_platform_admin_authorized()` and require authenticated tenant context rather than trusting a caller-set platform flag;
- the live catalog contains the two partial unique indexes, fourteen M10 indexes, twenty-nine M10 constraints, and thirty-two M10 trigger entries backed by sixteen guard/timestamp functions; and
- runtime update/delete/trigger privileges are least-privilege constrained by the migration runner.

Adversarial tenant tests covered queue/detail reads, dashboard data, evidence, candidates, history, manipulated tenant IDs, cross-tenant student/invoice/payment/case payloads, forged platform context, public context, and direct SQL writes.

## 8. Authoritative financial mutation path

M10 is not a second ledger:

- payment status, amount, and unallocated balance come from `payments`;
- allocation context comes from authoritative `payment_allocations` joined to tenant-matching invoices/students;
- invoice status/balance remains in the existing invoice/allocation triggers;
- confirmation delegates to the existing payment repository/state machine;
- allocation locks the authoritative payment, validates safe integer totals and remaining balance, then calls the existing allocation repository;
- reversal/refund/receipt consequences remain on their existing authoritative routes; and
- resolve explicitly returns `financialAction: none`.

A focused successful regression proves invoice issuance → accepted human candidate → authoritative full allocation → invoice `PAID`, payment unallocated `0`, and closed `ALLOCATED` reconciliation case. Existing financial concurrency tests continue to prevent over-allocation.

## 9. Concurrency and idempotency

- Payment workflows use row locks.
- Case updates use organization, open-case, and optimistic-version predicates.
- Concurrent case creation converges through the partial unique index and conflict recovery.
- Concurrent accepted candidate decisions produce one winner and one conflict with exactly one accepted candidate.
- All six M10 mutation routes require route/path/payload-scoped idempotency keys and cache/replay the original response.
- Repeated evidence, resolve, match, confirm, and allocation requests do not duplicate their effects.
- Same-key changed-payload reuse is rejected by the existing idempotency hash boundary.

The authorized receipt uniqueness-race replay hardening remains intact.

## 10. Adversarial findings closed

1. Forgeable platform-admin GUC in the initial M10 policies — fixed by `0031` and backend-bound platform context in `0034`.
2. Missing runtime payment/actor/content shapes — forward-preflighted and constrained by `0025` and actor migrations.
3. Cross-tenant/non-authenticated actor attribution — guarded by `0027`–`0029` and `0032`.
4. Candidate writes after flagged/terminal state — guarded by `0030` and service checks.
5. Reconciled flag restoration failure — fixed forward-only in `0033`; no applied migration was rewritten.
6. `ALLOCATED` without fully allocated authoritative payment — blocked by `0035` and regression-tested.
7. Closed-case history and decided-candidate linkage rewrites — blocked by `0036`.
8. False derived detail state after case close — fixed through open-case preference and authoritative derived-work calculation.
9. Unsafe allocation totals — rejected before financial repository calls.
10. Cursor precision and same-transaction audit ordering ambiguity — fixed with microsecond cursor ordering, legacy ISO compatibility, deterministic tie-breaks, and database-clock audit timestamps.

## 11. Migration replay, fresh database, and upgrade fixture

Migration files are numeric and journaled through `0036_m10_terminal_linkage_guards`. The runner applies each file in its own transaction and reapplies least-privilege grants after bootstrap.

Executed evidence:

- Real `npm run db:migrate`: **`new=0 total=36`**.
- Fresh test database: **36/36 migrations applied successfully**.
- Temporary upgrade fixture: applied `0000`–`0024`, inserted a valid payment/case/evidence set, then applied `0025`–`0036`; final result was `cases=1`, `evidence=1`, `invalid=0`.
- No migration deleted, merged, silently repaired, or financially reinterpreted existing records.

## 12. Complete verification

| Verification                                   | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| Focused M10 DB/auth                            | 2 files, **11/11 tests passed**                    |
| Full Vitest                                    | 28 files, **262/262 tests passed**                 |
| TypeScript                                     | `npm run typecheck` passed                         |
| Production build                               | `npm run build` passed                             |
| Lint                                           | passed with existing non-fatal repository warnings |
| Formatting/diff checks                         | Prettier and `git diff --check` passed             |
| Full Playwright harness                        | **32/32 passed**                                   |
| Existing financial concurrency/security suites | passed; no hidden aggregate failure                |

Legacy PostgreSQL `25001`/`25P01` transaction-state warnings remain visible in frozen M5–M8 test harness output; all affected tests pass. They are not an M10 integrity failure.

## 13. Known operational condition

> The real database currently has no active tenant fixture for the positive tenant/platform read-path smoke test. This is an operational staging verification item, not an identified M10 implementation failure. It must be exercised against a real seeded staging tenant before production deployment.

The real database did receive migration replay, live catalog inspection, and negative boundary checks: a forged platform context returned `authorized=false` and zero visible M10 cases; public context returned zero visible M10 cases. A legitimate positive tenant/platform read-path smoke must be run against seeded staging data before production deployment.

## 14. Freeze identity

The final authorized closeout commit and tag are established only after the following checks succeed:

```text
git rev-parse m10-reconciliation-control-plane
git rev-parse HEAD
```

Both commands must return the same exact commit SHA. The final SHA is recorded in the freeze handoff and must not be replaced by an amended or rewritten M9 object.

**M10 status after successful commit/tag verification: FROZEN**
