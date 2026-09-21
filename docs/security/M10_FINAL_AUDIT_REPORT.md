# M10 Independent Adversarial Freeze-Readiness Audit

**Audit date:** 2026-09-21 (Africa/Lagos)
**Audited baseline commit:** `43b406962f05b2cb83af94b4b296f47fb3f76878` (`M10: close out reconciliation control plane`)
**M9 freeze boundary:** tag `m9-academic-control-layer`, commit `791b6e09ad211eac470e6011e28172b1ff925575`
**M10 database state:** real migrated database at `0036_m10_terminal_linkage_guards`
**Audit posture:** independent and adversarial; `M10_CLOSEOUT_REPORT.md` was not used as evidence.

## 1. Decision

### Scoped M10 decision: **PASS — freeze-ready**

The M10 reconciliation control plane is freeze-ready as a forward extension of the frozen M1–M9 financial/application boundary. The final working tree has passed the required focused, full, database, type, build, formatting, migration, and browser verification described below.

This decision is scoped and operationally explicit:

- No implementation or closeout commit was created by this audit. The repository remains dirty for authorized review.
- The approved database state is the complete forward sequence through `0036`; deployment must not expose application traffic to an intermediate `0023`–`0035` state.
- M10 remains a control plane. Payment, allocation, invoice, reversal, refund, receipt, and balance truth remains in the existing authoritative financial paths.
- No M11 work should begin until the exact working-tree remediation set is reviewed and authorized.

## 2. Freeze lineage and exact change surface

The M9 boundary remains frozen. The M9 tag resolves to commit `791b6e09…`; no M1–M9 historical commit was amended, rewritten, merged away, or financially reinterpreted. The standing freeze points remain unchanged, including M5 `0c66618e…`, M6 `36688546…`, M7 `86beba9…`, and M8 tag `m8-controlled-term-billing` at `9989e633…`.

`git diff --name-status m9-academic-control-layer..HEAD` identifies the committed M10 surface: reconciliation UI/queue, eight reconciliation API paths, reconciliation schema/repository/service code, M10 permissions/documentation, migration-runner updates, and M10 DB/auth tests. The current audit working tree adds the forward-only hardening and regression surface:

- Migrations `0025`–`0036` and journal entries through `0036`.
- Runtime-shape, actor-attribution, candidate-state, platform-context, terminal-linkage, and allocation-terminal guards.
- Queue/detail tenant-join corrections, open-case/history selection, derived-work corrections, deterministic microsecond cursor ordering, and legacy ISO-cursor compatibility.
- Deterministic audit/evidence/candidate/history ordering; audit writes use the database clock so multiple audit records in one PostgreSQL transaction do not receive the same transaction-scoped `now()` timestamp.
- Focused adversarial DB/auth regressions, including a successful authoritative allocation-to-terminal-case path.
- `docs/security/M10_FINAL_AUDIT_REPORT.md` (this report).

The E2E working-tree corrections are also explicit: the accessibility tests target the intentionally public preview Command Center, while the root health test asserts the current authentication redirect; the unknown-route test uses the preview path. These corrections align the harness with the current auth/security contract rather than weakening M10 authorization.

## 3. Migration ordering, reproducibility, replay, and non-destructive design

The forward sequence is:

| Migration                                    | Audited purpose                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0023_m10_reconciliation_control_plane.sql`  | Creates cases, evidence, candidates, indexes, tenant/transition/timestamp guards, RLS/FORCE RLS, and runtime-role restrictions.        |
| `0024_m10_decision_shape_guards.sql`         | Adds decision-shape checks and direct-SQL transition guards.                                                                           |
| `0025_m10_runtime_shape_guards.sql`          | Preflights existing rows and hardens required payment/actor/content shapes, evidence-on-decision, version, and open-case requirements. |
| `0026_m10_case_history_guards.sql`           | Adds closed-case/history immutability behavior as a forward migration.                                                                 |
| `0027_m10_actor_attribution_guards.sql`      | Prevents cross-tenant actor attribution.                                                                                               |
| `0028_m10_actor_attribution_trigger_fix.sql` | Corrects the shared actor trigger for table-specific optional actor columns.                                                           |
| `0029_m10_actor_identity_guards.sql`         | Requires the authenticated actor, not merely any tenant member, for runtime attribution.                                               |
| `0030_m10_candidate_case_guards.sql`         | Blocks candidate writes/decisions for flagged, allocated, or terminal cases.                                                           |
| `0031_m10_rls_platform_auth_fix.sql`         | Replaces the forgeable platform-admin GUC policy branch with centralized authorization.                                                |
| `0032_m10_actor_identity_null_fix.sql`       | Allows valid nullable resolver/decision fields on open/proposed records while checking present actors.                                 |
| `0033_m10_flag_restore_guard_fix.sql`        | Forward-only `RECONCILED -> FLAGGED -> RECONCILED` restoration fix.                                                                    |
| `0034_m10_control_plane_auth_hardening.sql`  | Adds backend-bound platform authorization tokens and rejects public-context access to M10 records.                                     |
| `0035_m10_allocation_terminal_guard.sql`     | Makes `ALLOCATED` a reflection of fully allocated authoritative payment state and an accepted candidate.                               |
| `0036_m10_terminal_linkage_guards.sql`       | Blocks closed-case history rewrites and decided-candidate case-linkage rewrites.                                                       |

Migration evidence executed against the real and throwaway databases:

- Real `npm run db:migrate` replay: **`new=0 total=36`**.
- Fresh test database: all **36** migrations applied successfully in numeric order.
- Temporary upgrade fixture: applied `0000`–`0024`, inserted a valid pre-existing payment/case/evidence set, then applied `0025`–`0036`; final result was `{"migration":"0024 -> 0036","cases":"1","evidence":"1","invalid":"0"}`. No record repair, deletion, merge, or financial reinterpretation was performed.
- The migration runner records filename tags, sorts the zero-padded migration names, and commits each migration file in its own transaction. Deployment must gate application traffic until the complete sequence is applied.

The M10 tables intentionally contain operational control data only. They do not duplicate payment amounts, payment balances, allocation amounts, invoice balances, reversal/refund amounts, receipt amounts, or financial status truth. Organization deletion cascades with the tenant; payment/case/evidence/candidate financial references use restrictive deletes where preservation is required.

## 4. Schema, constraints, indexes, relationships, and live catalog evidence

### Control-plane tables

- `reconciliation_cases`: payment-linked operational case state, kind, reason, assignment, optimistic version, attribution, resolution, and timestamps; no amount/balance columns.
- `reconciliation_evidence`: durable bank/provider/operator evidence, optional observed time, content hash/metadata, attribution, and timestamps; immutable after insertion.
- `reconciliation_candidates`: human-reviewed student/invoice candidate, basis, decision state, decision actor/time, and timestamps; it does not allocate money.

### Intentional protections

- Partial unique `m10_reconciliation_one_open_payment_idx`: at most one open case per payment.
- Partial unique `m10_reconciliation_one_accepted_candidate_idx`: at most one accepted candidate per case.
- Organization/state, organization/kind, payment, assignee, case/evidence, evidence-reference, candidate/invoice, and candidate/student indexes.
- Organization foreign keys on all three tables.
- Tenant-matching guards for payment/case, case/evidence, case/student/invoice candidate linkage, and active-member attribution.
- Required `payment_id` and `created_by` runtime shapes.
- Evidence must contain a reference or note; candidate must contain a student or invoice and non-blank basis.
- Closed cases must be `RECONCILED` or `ALLOCATED` and carry resolver/time; allocated cases must be closed.
- Decided candidates must carry decision actor/time.
- Versions cannot decrease; closed history and decided linkage cannot be rewritten.

### Real live catalog at migration 0036

- `scolaira_app`: `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, `NOBYPASSRLS`.
- All three M10 tables: RLS enabled and FORCE RLS enabled.
- Exactly three M10 tenant policies; final policy expressions call `auth_is_platform_admin_authorized()` or require valid authenticated tenant context, rather than trusting a caller-set platform flag.
- Fourteen M10 table indexes in the live catalog, including the two partial unique indexes.
- Twenty-nine M10 table constraints in the live catalog, including checks, primary keys, and foreign keys.
- Thirty-two M10 trigger entries covering the three tables, backed by sixteen guard/timestamp functions; the runtime role cannot directly bypass the trigger boundary.
- Runtime privileges are least-privilege constrained: the migration runner reapplies column-level reconciliation update grants and revokes delete/truncate/references/trigger access.

Evidence is durable and tenant-scoped. Evidence update/delete is both privilege-restricted and trigger-rejected. Closed cases remain as retained history; they are not deleted or merged into a newer case. Candidate decisions and linkage are similarly protected.

## 5. End-to-end financial truth and bypass review

Every M10 workflow was traced to its authoritative path:

| Workflow           | M10 behavior                                                                                                                     | Authoritative boundary                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue/detail reads | Reads payment status/amount/unallocated amount, allocations, invoice/student joins, case/evidence/candidates, and audit history. | Tenant-scoped server queries; no financial write or shadow ledger.                                                                         |
| Add evidence       | Appends one evidence record, then records an audit event.                                                                        | M10 evidence table; immutable after insert.                                                                                                |
| Confirm            | Confirms pending/duplicate-suspect payment only under evidence and valid case state.                                             | Existing payment repository and payment status/balance triggers.                                                                           |
| Match              | Records an accepted human candidate and advances control state; does not allocate.                                               | Candidate constraints and tenant-valid student/invoice lookups.                                                                            |
| Flag/unflag        | Records exception state and prior state; unflag restores the recorded `UNMATCHED` or `RECONCILED` state.                         | M10 transition trigger plus optimistic version update.                                                                                     |
| Resolve            | Closes a reviewed exception with code/note and explicitly returns `financialAction: none`.                                       | No payment/invoice/allocation/reversal/refund/receipt mutation.                                                                            |
| Allocate           | Validates accepted candidate and invoice agreement, then calls the existing allocation repository.                               | Existing payment-allocation/invoice financial triggers; case closes `ALLOCATED` only after authoritative unallocated balance reaches zero. |

No M10 route directly updates payment balances, invoice balances, payment allocations, reversals, refunds, or receipts. Existing payment confirmation, allocation, reversal/refund, and receipt endpoints remain authoritative. Public payment submission/payment-link contexts cannot confirm, match, allocate, resolve, or write M10 evidence.

The allocation route locks the payment, validates each amount and the aggregate as a safe integer, validates the authoritative remaining balance, uses the existing allocation repository, rereads the authoritative post-allocation balance, and closes the case only when that balance is zero. A focused successful regression now proves invoice issuance → accepted candidate → authoritative full allocation → closed `ALLOCATED` case.

The detail route prefers an open case over closed history, exposes derived current work after a prior case close when the payment still has authoritative work, retains all closed cases in history, and aggregates payment plus every retained-case audit event. Fully allocated payments do not receive a false derived `UNMATCHED` state.

## 6. Reconciliation state machine, actors, preconditions, invalid behavior, and races

### Supported transitions

- Open `UNMATCHED -> FLAGGED`.
- `FLAGGED -> UNMATCHED` or `FLAGGED -> RECONCILED`, restoring the recorded prior state.
- Open `UNMATCHED -> RECONCILED` after evidence and a valid match/decision.
- Open `RECONCILED -> FLAGGED`, followed by reviewed restoration to `RECONCILED`.
- `RECONCILED -> ALLOCATED` only through the allocation workflow and only when authoritative payment allocation is complete; allocation closes the case.
- `ALLOCATED` and any closed case are terminal. Terminal cases cannot be reopened, edited, or given late evidence/candidates.

Invalid direct transitions, forged prior states, missing evidence, invalid attribution, unsuitable candidate decisions, closed-case edits, candidate linkage rewrites, and `ALLOCATED` without fully allocated confirmed payment are rejected by the service and/or database boundary. The database guard, not only the UI/service, enforces the financial terminal precondition.

### Actor and permission rules

- All M10 mutations use `withAuthorizedRoute` and require authentication, tenant membership, CSRF, body validation, request correlation, and an authorized action.
- `OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` have the centralized `reconciliation.read`, `reconciliation.review`, and/or `reconciliation.resolve` capabilities defined by the existing permission matrix. `STAFF` and unauthenticated/public-link/platform-support contexts cannot mutate M10 records.
- Evidence is required before confirmation, matching/decision, resolution, or allocation.
- Matching requires a confirmed payment with positive unallocated amount, tenant-valid target, and non-empty human basis.
- Allocation requires confirmed/non-flagged payment, evidence, one accepted candidate, candidate/invoice agreement, valid invoice state, and an amount within authoritative unallocated balance.
- Resolution closes a non-allocated case and is explicitly non-financial.

### Concurrency and replay

- Payment workflows lock the authoritative payment row.
- Case updates use an organization/version/open-case predicate and return conflict on stale writers.
- The open-case partial unique index plus conflict recovery converges concurrent case creation to one case.
- The accepted-candidate partial unique index makes concurrent accepted decisions converge to one winner; the loser receives a conflict and no stray accepted candidate remains.
- Required idempotency keys are scoped by operation/path and payload. Replayed evidence/resolve/allocation/match/confirm requests return the cached response without duplicating the mutation.
- Existing financial concurrency tests cover competing authoritative allocations and prevent invoice over-allocation. M10 tests cover concurrent case creation and candidate decisions.

Queue cursors now use PostgreSQL epoch microseconds plus payment UUID as the hidden sort key. Previously issued canonical ISO cursors are accepted and converted at millisecond precision instead of being rejected; malformed cursors remain a 400. A focused regression covers this compatibility path.

## 7. Tenant isolation, authentication, CSRF, validation, idempotency, and audit coverage

The adversarial tests covered:

- Queue/dashboard/detail reads and pagination.
- Evidence and candidate reads/writes.
- Cross-tenant payment, case, evidence, candidate, student, invoice, and actor payloads.
- Manipulated organization IDs and direct database payloads.
- Forged `app.is_platform_admin=1` plus a forged platform-admin UUID.
- Public payment-link context and missing tenant context.
- Direct SQL inserts/updates/deletes under the runtime role.
- Concurrent case creation, candidate decisions, repeated evidence, stale transitions, terminal updates, and allocation linkage races.

Every M10 mutation route is protected by the centralized auth wrapper, Zod schemas, UUID path validation, CSRF, idempotency, transaction boundaries, and explicit audit writes. The route never accepts a client organization ID to establish context; organization scope comes from authenticated context and is repeated in repository joins/where clauses. Audit rows include actor/correlation/request metadata, before/after data, case/payment linkage, and reasons where applicable.

The original M10 policy branch that trusted the raw platform-admin GUC was identified and removed by `0031`; `0034` further binds platform authorization to a backend token and excludes public context. The real runtime smoke test produced:

- forged platform context: `authorized = false`, visible reconciliation cases `0`;
- public context: visible reconciliation cases `0`.

The real database currently contains no active tenant membership/data fixture, so the legitimate tenant/platform positive-path RLS smoke was exercised on the fully migrated test database instead; the real database migration/catalog/negative-boundary checks still ran against the live database.

## 8. Evidence, history, attribution, timestamps, linkage, and UI/API truth

Evidence and history controls were verified at both API/service and DB boundaries:

- Evidence is tenant-scoped, attributed to the authenticated actor, timestamped, durable, linked to a case, and immutable after insertion.
- Case resolution/closure carries actor/time and remains retained in history.
- Candidate decisions carry actor/time and cannot be rewritten after decision; decided candidates cannot be moved to another case.
- Closed case linkage to payment and candidate linkage to case/student/invoice are protected by restrictive relationships and forward terminal-linkage guards.
- Audit ordering is deterministic even for multiple records created in one transaction; the database clock preserves meaningful newest-first history.

The reconciliation UI consumes server queue/detail responses for payment status, amounts, allocation counts, candidates, evidence, actions, and history. The detail response derives current work only from authoritative payment state and presents closed cases as history. No client organization ID or client-provided financial amount is used as server truth.

## 9. Verification executed

| Verification                         | Result                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Focused M10 DB/auth                  | **2 files, 11/11 tests passed**.                                                |
| Full Vitest                          | **28 files, 262/262 tests passed**.                                             |
| `npm run typecheck`                  | Passed (`tsc --noEmit`).                                                        |
| `npm run build`                      | Passed; optimized Next build and static generation completed.                   |
| `npm run lint`                       | Passed; existing repository `any`/unused-variable warnings remain non-fatal.    |
| Prettier and `git diff --check`      | Passed on the final working-tree source/report set.                             |
| Real migration replay                | **`new=0 total=36`**.                                                           |
| Fresh 36-migration test DB           | Passed.                                                                         |
| `0024 -> 0036` upgrade fixture       | Passed; `cases=1`, `evidence=1`, `invalid=0`.                                   |
| Full Playwright harness              | **32/32 passed**.                                                               |
| Existing financial concurrency tests | Passed; allocation contention cannot over-allocate authoritative invoice state. |

The full Vitest output continues to show legacy PostgreSQL `25001`/`25P01` transaction-state warnings from frozen M5–M8 test harnesses; the associated assertions pass. They are test-harness notices, not M10 integrity failures.

## 10. Findings closed by this audit

1. **Forgeable platform-admin GUC in initial M10 RLS policy** — replaced by centralized platform authorization and backend-bound platform context (`0031`, `0034`).
2. **Runtime rows could bypass required payment/actor/content shapes** — forward preflight and guards (`0025`, `0027`–`0029`, `0032`).
3. **Cross-tenant or non-authenticated actor attribution** — database actor-tenant and authenticated-actor guards.
4. **Candidate insertion/acceptance after flagged/terminal case state** — candidate-case guard (`0030`) plus service preconditions.
5. **Reconciled flag restoration path** — corrected forward-only in `0033`; previously applied `0026` source was not rewritten.
6. **`ALLOCATED` could be represented without authoritative full allocation** — terminal guard (`0035`) and successful allocation regression.
7. **Closed-case reason/kind/resolution and decided-candidate linkage could be rewritten through direct SQL** — terminal/linkage guards (`0036`).
8. **False derived detail state after a prior close** — open-case preference, retained history, and authoritative derived-work corrections.
9. **Unsafe JavaScript allocation totals** — safe-integer and authoritative post-allocation checks.
10. **Millisecond/ISO cursor and same-timestamp history ordering ambiguity** — PostgreSQL microsecond cursor key, legacy cursor acceptance, deterministic tie-breaks, and database-clock audit timestamps.

No open M10 control-plane defect was found in the final verification set.

## 11. Freeze conditions and handoff

1. Review and authorize the exact dirty working-tree remediation and report set; this audit intentionally created no commit.
2. Deploy all migrations through `0036` as one forward-only, maintenance-gated sequence, then verify the journal, role attributes, RLS/FORCE RLS, policies, constraints, indexes, triggers, and runtime grants.
3. Preserve M1–M9 tags/history and do not reopen frozen financial semantics.
4. Treat the empty real-database tenant fixture as an environment limitation: exercise one legitimate tenant and one legitimate platform-support positive path in staging before production, while retaining the demonstrated negative forged/public-context checks.
5. Do not start M11 until the M10 working-tree authorization and deployment evidence are recorded.
