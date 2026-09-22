# SCOLAIRA M11 CLOSEOUT REPORT — COLLECTIONS WORKBENCH

**Date:** 2026-09-22 (Africa/Lagos)
**Status:** **M11 IMPLEMENTATION COMPLETE — AWAITING FREEZE**
**Baseline:** M10 frozen at `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`
**Implementation commit:** `a4d421c0062f7589bf1ebd7517ae8b6a328f3862`
**Migration:** `0037_m11_collections_control_plane.sql`
**Freeze/tag status:** no M11 tag or freeze has been created or authorized

This report records the M11 implementation, security and financial-integrity
boundaries, migration evidence, verification results, staging implications, and
lineage confirmation. It deliberately does not claim provider/bank ingestion,
automated debt collection, CRM, accounting replacement, a second ledger, or any
other excluded capability.

## 1. Result and bounded capability

M11 adds a tenant-scoped Collections Workbench for operational follow-up of
outstanding obligations. It is a durable work queue and case-control plane over
existing authoritative financial records; it is not a financial ledger.

Delivered capabilities:

- authenticated `/collections` workbench with queue filters for state, priority,
  and closed-case visibility;
- tenant-scoped student-level case creation for a live outstanding account;
- one active/open case per student per collection episode; closed episodes are
  immutable and a later episode creates a new case;
- live authoritative invoice/debt display;
- payment, allocation, receipt, reversal/refund context and linked M10
  reconciliation context;
- explicit ownership/assignee changes and next-action dates;
- append-only notes and actions, including same-tenant reminder linkage;
- explicit state transitions with transition-specific requirements;
- durable case history and ordinary audit events;
- optimistic version protection for mutable workflow operations; and
- organization-scoped idempotency replay for every M11 mutation route.

M11 creates no payment, allocation, invoice, receipt, reversal, refund,
reconciliation, or balance shadow. No M11 route performs a financial effect.
Any future financial effect must call the existing authoritative financial
service and must not mutate a collections case or financial column directly.

## 2. State model and durable records

`collections_cases` contains only workflow context:

- tenant and student linkage only; no invoice-level case linkage;
- `OPEN`, `IN_PROGRESS`, `ESCALATED`, `RESOLVED`, or `CLOSED` state;
- `LOW`, `NORMAL`, `HIGH`, or `URGENT` priority;
- reason, assignee, next-action timestamp, actor attribution, and timestamps;
- optimistic `version`; and
- resolution/closure attribution.

Tenant/linkage/creator fields are immutable. Every mutable update advances the
version exactly once. Closed cases are terminal and immutable. Active tenant
membership is required for actors and assignees.

`collections_case_events` is append-only and supports `CREATED`, `ASSIGNED`,
`UNASSIGNED`, `NOTE`, `ACTION`, `STATE_CHANGE`, `RESOLVED`, `CLOSED`, and
`REOPENED`. Events are tenant-checked, actor-attributed, and may reference only
same-account reminder context linked to the case student.

The permitted lifecycle is:

```text
OPEN        -> IN_PROGRESS | ESCALATED | RESOLVED
IN_PROGRESS -> OPEN | ESCALATED | RESOLVED
ESCALATED   -> IN_PROGRESS | RESOLVED
RESOLVED    -> OPEN | IN_PROGRESS | CLOSED
CLOSED      -> (terminal)
```

Every transition requires a non-empty server-validated note. `RESOLVED`
requires resolver and resolution time. `CLOSED` is permitted only from
`RESOLVED` and requires closer and closure time. Reopening clears resolution and
closure attribution and appends a `REOPENED` event.

## 3. HTTP, authorization, and tenant boundary

All routes use the centralized authorized-route boundary for authentication,
action authorization, CSRF, validation, tenant context, and normalized errors.
Organization context is derived from the authenticated session and database
context; no M11 route accepts a client-supplied organization ID as authority.

| Method | Path                              | Capability               | Idempotency |
| ------ | --------------------------------- | ------------------------ | ----------- |
| GET    | `/api/collections`                | `collections.read`       | n/a         |
| POST   | `/api/collections`                | `collections.create`     | required    |
| GET    | `/api/collections/:id`            | `collections.read`       | n/a         |
| POST   | `/api/collections/:id/assign`     | `collections.assign`     | required    |
| POST   | `/api/collections/:id/events`     | `collections.note`       | required    |
| POST   | `/api/collections/:id/transition` | `collections.transition` | required    |

`OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` receive all five collections
capabilities. `STAFF` receives none. Platform support may use the existing
explicit read-only support policy for queue/detail reads and cannot mutate
cases. Public-link and unauthenticated contexts cannot access the workbench.
All unsafe mutations require CSRF and an `Idempotency-Key`; same-key changed
payloads are rejected by the shared idempotency hash boundary.

Database defense in depth includes tenant guards, RLS, FORCE RLS, actor and
linkage checks, authenticated actor attribution, and least-privilege runtime
grants. Direct SQL cannot rewrite case linkage, forge same-tenant creator or
resolution actors, skip versions, change append-only history, or mutate a
terminal case through the runtime principal.

## 4. Concurrency, auditability, and financial integrity

Mutable case operations lock the case row in a transaction, compare the caller's
expected version, perform a version-predicate update, append the operational
event, and write an audit event containing before/after workflow snapshots.
Concurrent reassignment and closure attempts therefore converge to one winner;
stale requests fail rather than silently overwriting the winner.

Focused tests and database guards cover:

- duplicate idempotency replay without duplicate history;
- changed-payload reuse of an idempotency key;
- invalid and stale transitions;
- concurrent reassignment and closure races;
- tenant/linkage mismatch and cross-tenant reads/writes;
- forged tenant/platform context and unauthorized `STAFF` access;
- CSRF rejection; and
- append-only event and closed-case mutation attempts.

The workbench reads current truth from the existing invoice, allocation,
payment, receipt, reversal, and M10 reconciliation records. Candidate-linked
M10 reconciliation context also exposes confirmed but unallocated payment state
when an M10 candidate identifies the student. No amount, paid,
outstanding, balance, allocation, refund, reversal, receipt, or reconciliation
decision column was added to the M11 model. Existing trigger-maintained
financial truth, payment/allocation services, public payment-link boundaries,
receipt behavior, and M10 control-plane semantics remain the authority.

## 5. Reminder lifecycle correction

M11 corrects the pre-existing reminder contract without rewriting historical
rows. New `PRINT` reminders are recorded as `SENT` with a delivery timestamp;
unsupported `SMS`, `EMAIL`, `WHATSAPP`, and other external channels are recorded
as `PENDING` with no delivery timestamp until a real provider exists. The
repository behavior and migration insert guard agree, and focused DB coverage
proves both the repository and direct-SQL boundaries.

## 6. Migration and least privilege

`0037_m11_collections_control_plane.sql` is forward-only, deterministic, and
transactional per migration runner. It creates the two M11 tables, the one-open-
student uniqueness boundary, indexes, tenant/linkage/actor guards, lifecycle
and append-only triggers, RLS/FORCE RLS policies, and financial-boundary
comments. It does not rewrite or delete prior records. It also adds
authenticated actor-attribution guards and a non-destructive insert guard so
unsupported future reminder channels cannot be recorded as delivered.

The migration runner, test bootstrap, and concurrency verification harness
reapply M11 restrictions after the existing broad bootstrap grant:

- runtime can read/insert cases and events;
- runtime can update only allowed workflow columns on cases;
- runtime cannot update/delete events;
- runtime cannot delete cases; and
- tenant, student, creator, and creation-time linkage cannot be rewritten by the
  runtime role.

Migration journal entry `0037_m11_collections_control_plane` is terminal index `36`.

## 7. Verification evidence

| Gate                           | Result                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Targeted M11 DB integration    | **10/10 passed**                                                                                         |
| Targeted M11 route integration | **5/5 passed**                                                                                           |
| M11 authorization suite        | **2/2 passed**                                                                                           |
| Unit suite                     | **4 files / 30 tests passed**                                                                            |
| Explicit M10 regression        | **11/11 tests passed**                                                                                   |
| Full Vitest suite              | **31 files / 279 tests passed**                                                                          |
| TypeScript                     | `tsc --noEmit` passed                                                                                    |
| Lint                           | `npm run lint` passed; existing non-fatal `any`/unused-variable warnings only                            |
| Production build               | `npm run build` passed; **48/48** static pages generated                                                 |
| Full Playwright suite          | **32/32 passed** on the clean final rerun                                                                |
| Fresh migration                | **`new=37 total=37`**                                                                                    |
| Migration replay               | **`new=0 total=37`**                                                                                     |
| Upgrade path                   | `0000`–`0036`: **`new=36 total=36`**; then `0037`: **`new=1 total=37`**                                  |
| Runtime role/RLS catalog audit | passed; role attributes, RLS/FORCE RLS, policies, privileges, and shadow-column check verified           |
| Native `argon2` load/rebuild   | passed                                                                                                   |
| `git diff --check`             | passed                                                                                                   |
| Targeted Prettier check        | passed for all new M11 source, tests, schema/repository, migration metadata, and M11 documentation files |

Earlier local attempts encountered disposable-browser dependency and two
transient mobile screenshot timeout issues; after installing the browser/system
dependencies, the clean final rerun passed all 32 tests with no application
assertion failure. The repository's pre-existing formatted-file baseline still
contains unrelated Prettier warnings in older files; no M11-new file has a
formatting failure.

The full Vitest output continues to show existing PostgreSQL `25001`/`25P01`
transaction-state cleanup warnings in older harness paths. They are non-blocking
warnings; the complete suite passed and no M11 test failed.

## 8. Runtime security evidence

Final catalog checks against the migrated database returned:

- `scolaira_app`: `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`,
  `NOBYPASSRLS`;
- `collections_cases` and `collections_case_events`: RLS enabled and FORCE
  RLS enabled;
- one tenant-isolation policy on each M11 table;
- runtime case delete denied; runtime event update/delete denied;
- runtime case linkage-column update denied while allowed workflow-column update
  remained available;
- one-open-student unique index present and reminder delivery guard installed; and
- zero M11 columns matching financial shadow patterns (`kobo`, `amount`,
  `balance`, `paid`, `outstanding`, `allocated`, `refund`, `receipt`, or
  `reversal`).

The focused adversarial suites additionally exercised cross-tenant data,
forged context, invalid roles, CSRF, duplicate requests, stale versions,
concurrent updates, closure/reassignment races, and direct financial-boundary
attacks.

## 9. Independent adversarial findings and remediation

The final audit found and corrected the following defects before freeze
readiness was assessed:

1. **Medium — duplicate open-case API conflict mapping.** Two different
   idempotency keys attempting to open a second case for the same student hit
   the database unique index, but Drizzle exposed PostgreSQL `23505` through
   `error.cause`, so the route initially returned `500` instead of a safe
   `409 CONFLICT`. `app/api/collections/route.ts` now unwraps the PostgreSQL
   code, and the route test proves the safe conflict response.
2. **High — direct runtime actor attribution.** The initial M11 database guard
   checked that creator/resolver/closer/event actors were active tenant
   members, but did not require them to equal the authenticated `app.user_id`.
   A same-tenant direct SQL write could therefore forge an active member as the
   actor. `0037_m11_collections_control_plane.sql` now enforces authenticated
   creator, resolver, closer, and event actors, with bootstrap-only exceptions;
   direct SQL adversarial tests cover forged event and resolution actors.
3. **Medium — incomplete unallocated M10 account context.** The initial detail
   query followed only allocated payments, omitting an unallocated payment
   whose M10 candidate explicitly identified the student. The read path now
   includes candidate-linked M10 cases and authoritative payment status,
   amount, and unallocated projection without writing M10 or financial truth.
   A focused test proves the case remains open and the payment remains
   unallocated.

All three findings were corrected in implementation commit
`a4d421c0062f7589bf1ebd7517ae8b6a328f3862`; the expanded concurrent/terminal
adversarial tests are in `05f81f84ad00b5851ef963e1692c109dfb32769d`. They are
covered by the final verification counts. No material implementation finding
remains.

## 10. Files and migration surface

The implementation commit contains the following M11 surface:

- `app/(app)/collections/collections-workbench.tsx`
- `app/(app)/collections/page.tsx`
- `app/(app)/layout.tsx`
- `app/api/collections/route.ts`
- `app/api/collections/[id]/route.ts`
- `app/api/collections/[id]/assign/route.ts`
- `app/api/collections/[id]/events/route.ts`
- `app/api/collections/[id]/transition/route.ts`
- `lib/authz/permissions.ts`
- `lib/db/migrations/0037_m11_collections_control_plane.sql`
- `lib/db/migrations/meta/_journal.json`
- `lib/db/repo/collections.ts`
- `lib/db/schema/collections.ts`
- `lib/db/schema/index.ts`
- `scripts/migrate.ts`
- `scripts/verify-m8-concurrency.ts`
- `tests/auth/m11-collections-routes.test.ts`
- `tests/auth/m11-collections.test.ts`
- `tests/db/m11-collections.test.ts`
- `tests/global-setup-db.ts`
- `docs/architecture/M11_IMPLEMENTATION.md`
- `docs/architecture/M11_RECONNAISSANCE.md`
- `docs/security/AUTHORIZATION_MATRIX.md`
- this closeout report

No M9 or M10 implementation file or migration was changed. M11 is additive on
top of frozen M10. The M11 implementation series begins at
`4f1d2a4c0c24ebd39b41406a59af017019f0ab72`, whose exact parent is the frozen M10
commit; the final audit-hardening correction is `a4d421c0062f7589bf1ebd7517ae8b6a328f3862`.

## 11. Limitations and staging implications

M11 intentionally does not implement bank/provider integration, payment-gateway
replacement, automated debt collection, contact delivery, CRM, accounting
replacement, duplicate ledgers, heuristic/AI decisions, portals, term rollover,
wallets/credit, installments, broad reporting, or unrelated academic features.
M11 also does not add a financial action route; existing authoritative payment,
allocation, reversal/refund, and receipt services remain the only permitted
financial-effect paths.

Before staging enablement:

1. Apply `0037_m11_collections_control_plane.sql` through the migration runner as the
   migration owner, never as `scolaira_app`.
2. Verify the journal records `0037` exactly once and rerun the role/RLS/
   least-privilege catalog audit.
3. Exercise fresh, replay, and upgrade-path checks against the deployment
   fixture and run the focused M11 DB/auth suites against staging.
4. Seed a controlled tenant with outstanding obligations and verify positive
   queue/detail reads, authorized workflow mutations, audit history, and
   idempotent retries. The local final catalog audit intentionally used a
   migrated throwaway/empty tenant database, so this positive seeded staging
   smoke remains an operational deployment gate.
5. Confirm monitoring for authorization denials, idempotency conflicts, stale
   version conflicts, append-only violations, and any attempted direct
   financial mutation.

No M11 tag, freeze, or production enablement is implied by this report. Explicit
user authorization is still required for the freeze decision.

## 12. Final handoff

**M11 IMPLEMENTATION COMPLETE — AWAITING FREEZE**

Implementation commit: `a4d421c0062f7589bf1ebd7517ae8b6a328f3862`
Frozen M10 parent: `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`
M10 tag preserved: `m10-reconciliation-control-plane`

The repository is ready for explicit freeze review only. No tag or freeze action
was taken during this implementation.
