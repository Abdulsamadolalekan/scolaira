# M11 Implementation — Collections Workbench and Case Control Plane

**Status:** implementation complete — awaiting freeze; not frozen
**Baseline:** M10 frozen at `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`
**Migration:** `0037_m11_collections_cases.sql`
**Scope:** tenant-scoped collections operations only

## 1. Bounded capability

M11 adds an authenticated Collections Workbench for staff who already have
accounts-receivable visibility. It is deliberately not a debt ledger, CRM,
payment gateway, bank integration, automated debt collector, portal, wallet,
installment engine, or reporting replacement.

The workbench supports:

- a tenant-scoped queue of operational collection cases;
- filters by lifecycle state, priority, and whether closed cases are shown;
- case creation only when the live authoritative invoice/student debt is
  outstanding;
- ownership/assignee changes;
- operational notes and actions, optionally linked to an existing immutable
  reminder;
- explicit, server-enforced lifecycle transitions;
- live invoice/debt detail;
- payment/allocation history, receipt and reversal context, and linked M10
  reconciliation context;
- append-only case history plus normal audit events.

No M11 endpoint accepts an organization ID as authority. The organization is
derived by `withAuthorizedRoute()` from the authenticated session and
`set_tenant_context()`.

## 2. Financial boundary

`collections_cases` stores workflow context only:

- tenant and student linkage;
- optional focused invoice linkage;
- state, priority, reason, assignee, next-action timestamp;
- server-maintained resolution/closure attribution;
- optimistic `version` and timestamps.

It does **not** store `total_kobo`, `paid_kobo`, outstanding balances,
payment amounts, allocation amounts, receipt amounts, reversal/refund amounts,
or reconciliation decisions.

The repository reads current financial truth from the existing `students`,
`invoices`, `payment_allocations`, `payments`, `receipts`, `reversals`, and M10
`reconciliation_cases` tables. The queue computes outstanding amounts from the
existing trigger-maintained invoice columns at read time. A financial action
is not implemented in M11; any future payment, allocation, reversal, refund,
or receipt action must call its existing authoritative service rather than
mutating a case or financial column directly.

## 3. Durable model and invariants

### `collections_cases`

- `organization_id` is mandatory and RLS/FORCE RLS protected.
- `student_id` is mandatory and must belong to the same tenant.
- `invoice_id`, when present, must belong to the same tenant and student.
- An open case may exist once per focused invoice, or once per student for an
  aggregate student case. Closed obligations may be reopened as a new
  operational case.
- State is constrained to `OPEN`, `IN_PROGRESS`, `ESCALATED`, `RESOLVED`, or
  `CLOSED`.
- Priority is constrained to `LOW`, `NORMAL`, `HIGH`, or `URGENT`.
- New cases must be `OPEN` at version zero.
- Creation linkage is immutable. Updates must advance `version` exactly once.
- Closed cases are terminal and immutable.
- Assignee, creator, resolver, and closer must be active members of the tenant
  when the case is written; historical assignee references are retained.

### `collections_case_events`

Events are append-only. Supported event types are `CREATED`, `ASSIGNED`,
`UNASSIGNED`, `NOTE`, `ACTION`, `STATE_CHANGE`, `RESOLVED`, `CLOSED`, and
`REOPENED`. Each event is tenant-checked, actor-attributed, linked to its case,
and can reference only a reminder belonging to the same case student or
focused invoice.

### Lifecycle

The allowed transition graph is:

```text
OPEN        -> IN_PROGRESS | ESCALATED | RESOLVED
IN_PROGRESS -> OPEN | ESCALATED | RESOLVED
ESCALATED   -> IN_PROGRESS | RESOLVED
RESOLVED    -> OPEN | IN_PROGRESS | CLOSED
CLOSED      -> (terminal)
```

Transitions require a non-empty server-validated note. `RESOLVED` requires
resolver and resolution time. `CLOSED` is possible only from `RESOLVED` and
requires closer and closure time. Reopening clears resolution/closure
attribution and records a `REOPENED` event.

## 4. HTTP surfaces

All routes use `withAuthorizedRoute()`, which provides authentication,
centralized authorization, CSRF for unsafe methods, tenant context, validation,
and error normalization.

| Method | Path                              | Action                   | Idempotency |
| ------ | --------------------------------- | ------------------------ | ----------- |
| GET    | `/api/collections`                | `collections.read`       | n/a         |
| POST   | `/api/collections`                | `collections.create`     | required    |
| GET    | `/api/collections/:id`            | `collections.read`       | n/a         |
| POST   | `/api/collections/:id/assign`     | `collections.assign`     | required    |
| POST   | `/api/collections/:id/events`     | `collections.note`       | required    |
| POST   | `/api/collections/:id/transition` | `collections.transition` | required    |

Mutation request bodies require an `Idempotency-Key`. The shared M9
reservation/replay helper scopes keys by organization and authenticated user,
checks the request shape, and returns the committed response on retry.

## 5. Authorization

`OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` receive the five explicit
collections actions. `STAFF` receives none. Platform support may read through
the existing explicit platform-support read policy but cannot create, assign,
write events, or transition cases. Support mode remains dependent on the
existing authenticated platform context; a forgeable client GUC is not a
permission source.

## 6. Concurrency and audit

Every mutable case operation:

1. locks the case row inside a transaction;
2. compares the caller's expected version with the locked current version;
3. performs a version-predicate update;
4. appends the operational event; and
5. writes an audit event with before/after workflow snapshots.

The database transition trigger independently rejects invalid state changes,
version skips, tenant/linkage rewrites, resolution/closure shape violations,
and post-closure updates. A trigger and least-privilege grants reject updates
or deletes to case history.

## 7. Migration and least privilege

`0037_m11_collections_cases.sql` is forward-only and creates only M11 objects.
It creates both tables, indexes, tenant/actor/linkage guards, transition and
append-only triggers, RLS and FORCE RLS policies, and comments documenting the
financial boundary. The migration journal now ends at index 36. The production
migration runner and the test migration bootstrap reapply M11 grants after the
existing broad bootstrap grant:

- runtime can read/insert cases and history;
- runtime cannot delete cases or update/delete history;
- runtime can update only case workflow columns;
- runtime cannot alter tenant, student, invoice, creator, or creation time
  linkage.

M9 and M10 migration files and their tags remain untouched.

## 8. Verification record

Final verification completed before closeout:

- `tsc --noEmit`: pass.
- `npm run lint`: pass; existing repository warnings only (`any` and unused variables), no lint errors.
- Targeted M11 integration suites: `9/9` passing after migration reset/replay setup (`5` DB, `4` route).
- M11 authorization suite: `2/2` passing.
- Unit suite: `4` files / `30` tests passing.
- Full Vitest suite: `31` files / `273` tests passing.
- Fresh migration path: `new=37`, `total=37`.
- Replay path: `new=0`, `total=37`.
- Upgrade path through migration `0036` then `0037`: `new=1`, `total=37`.
- Runtime privilege/RLS audit: pass; `scolaira_app` remains `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`, `NOBYPASSRLS`; M11 tables are RLS and `FORCE ROW LEVEL SECURITY` protected.
- Native `argon2` load/rebuild: pass.
- `next build`: pass; `48/48` static pages generated.
- `git diff --check`: pass.
- Playwright E2E suite: `32/32` pass on the clean final rerun. A preceding run had two mobile screenshot timeout flakes; neither reproduced on rerun and no application assertion failed.
- Targeted M11 Prettier verification: pass for changed M11 tests and documentation after final edits.

The implementation is complete and the closeout report records the implementation commit. No M11 tag or freeze is authorized by this document.
