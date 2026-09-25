# M11 Implementation — Collections Workbench and Case Control Plane

**Status:** implementation complete — awaiting freeze
**Baseline:** M10 frozen at `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`
**Migration:** `0037_m11_collections_control_plane.sql`
**Scope:** student-level collections operations only

## 1. Bounded capability

M11 adds an authenticated Collections Workbench for staff who already have
accounts-receivable visibility. It is deliberately not a debt ledger, CRM,
payment gateway, bank integration, automated debt collector, portal, wallet,
installment engine, or reporting replacement.

The workbench supports:

- a tenant-scoped queue of student-level operational collection cases;
- filters by lifecycle state, priority, assignee, and whether closed episodes
  are shown;
- case creation only when the live authoritative student account has an
  outstanding obligation;
- one active/open case per student collection episode;
- ownership/assignee changes and next-action scheduling;
- operational notes and actions linked to existing same-account reminders;
- explicit, server-enforced lifecycle transitions;
- live student account, invoice/debt, payment/allocation, receipt/reversal,
  and linked M10 reconciliation context;
- append-only case history plus normal audit events; and
- correction of the existing reminder contract so unsupported channels remain
  `PENDING` until a provider actually delivers them. `PRINT` remains the
  synchronously delivered channel in this milestone.

No M11 endpoint accepts an organization ID as authority. The organization is
derived by `withAuthorizedRoute()` from the authenticated session and
`set_tenant_context()`.

## 2. Financial boundary

`collections_cases` stores workflow context only:

- tenant and student linkage;
- state, priority, reason, assignee, next-action timestamp;
- server-maintained resolution/closure attribution;
- optimistic `version`; and
- timestamps.

It contains no invoice ID and no `total_kobo`, `paid_kobo`, outstanding,
payment, allocation, receipt, reversal/refund, or reconciliation-decision
column. A case is never invoice-level and cannot be simultaneous with a
student-level case for the same student.

The repository reads current financial truth from the existing `students`,
`invoices`, `payment_allocations`, `payments`, `receipts`, `reversals`, and M10
`reconciliation_cases` tables. The queue and account detail compute current
student debt from the existing trigger-maintained invoice columns at read time.
Candidate-linked M10 context includes confirmed but unallocated payment state
when an M10 candidate identifies the student. A financial action is not
implemented in M11; any future payment, allocation,
reversal, refund, or receipt action must call its existing authoritative service
rather than mutating a case or financial column directly.

## 3. Durable model and episode invariant

### `collections_cases`

- `organization_id` and `student_id` are mandatory and tenant-guarded.
- State is constrained to `OPEN`, `IN_PROGRESS`, `ESCALATED`, `RESOLVED`, or
  `CLOSED`.
- Priority is constrained to `LOW`, `NORMAL`, `HIGH`, or `URGENT`.
- New cases must be `OPEN` at version zero.
- Creation linkage is immutable. Updates must advance `version` exactly once.
- Closed cases are terminal, immutable historical episodes.
- Assignee, creator, resolver, and closer must be active members of the tenant
  when written.
- A partial unique index permits exactly one case for a student while the case
  is not `CLOSED`; after closure, a later collection episode creates a new
  case and does not reopen or rewrite the old episode.

### `collections_case_events`

Events are append-only. Supported event types are `CREATED`, `ASSIGNED`,
`UNASSIGNED`, `NOTE`, `ACTION`, `STATE_CHANGE`, `RESOLVED`, `CLOSED`, and
`REOPENED`. Each event is tenant-checked, actor-attributed, linked to its case,
and can reference only a reminder belonging to the same student account. A
reminder remains a relationship to the authoritative reminder row; its balance
snapshot is not copied into the case/event.

### Lifecycle

The allowed transition graph is:

```text
OPEN        -> IN_PROGRESS | ESCALATED | RESOLVED
IN_PROGRESS -> OPEN | ESCALATED | RESOLVED
ESCALATED   -> IN_PROGRESS | RESOLVED
RESOLVED    -> OPEN | IN_PROGRESS | CLOSED
CLOSED      -> (terminal)
```

This supports identify → open → assign → act → escalate → resolve → close.
Transitions require a non-empty server-validated note. `RESOLVED` requires
resolver and resolution time. `CLOSED` is possible only from `RESOLVED` and
requires closer and closure time. Reopening a pre-closure `RESOLVED` episode
clears resolution/closure attribution and records a `REOPENED` event; a `CLOSED`
episode cannot be reopened.

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

## 5. Authorization and security

`OWNER`, `SCHOOL_ADMIN`, and `FINANCE_OFFICER` receive the five explicit
collections actions. `STAFF` receives none. Platform support may read through
the existing explicit platform-support read policy but cannot create, assign,
write events, or transition cases. Support mode remains dependent on the
existing authenticated platform context; a forgeable client GUC is not a
permission source.

Unsafe M11 mutations require authentication, authorization, CSRF, validation,
tenant-context validation, audit, and idempotency. RLS and FORCE RLS provide
database defense in depth. Assignees and actors must be active same-tenant
members.

## 6. Concurrency and audit

Every mutable case operation:

1. locks the case row inside a transaction;
2. compares the caller's expected version with the locked current version;
3. performs a version-predicate update;
4. appends the operational event; and
5. writes an audit event with before/after workflow snapshots.

The database independently rejects invalid state changes, version skips,
tenant/linkage rewrites, forged same-tenant creator/resolver/closer/event actors,
resolution/closure shape violations, and post-closure updates. The
student-level partial unique index prevents two concurrent open collection
episodes for one student. A trigger and least-privilege grants reject updates
or deletes to case history.

## 7. Reminder correction

Existing reminder rows remain immutable; M11 does not rewrite historical
`SENT` rows. Future reminder creation now records:

- `PRINT` as `SENT` with `sent_at` because print is the delivered channel in
  this milestone; and
- `SMS`, `EMAIL`, `WHATSAPP`, and other unsupported channels as `PENDING` with
  no delivery timestamp.

Migration `0037` adds an insert-shape guard so a direct future insert cannot
record an unsupported channel as `SENT`. A real provider delivery workflow is
outside M11 and may later advance a pending row through the existing delivery
state machine.

## 8. Migration and least privilege

`0037_m11_collections_control_plane.sql` is forward-only and creates only M11
objects plus authenticated actor-attribution and non-destructive future-
reminder delivery guards. Migrations `0000`–`0036` are not modified. The
migration creates both case tables, indexes, the one-open-student uniqueness
boundary, tenant/actor guards, transition and append-only triggers, RLS and
FORCE RLS policies, and comments documenting the financial boundary.

The production migration runner and the test migration bootstrap reapply M11
grants after the existing broad bootstrap grant:

- runtime can read/insert cases and history;
- runtime cannot delete cases or update/delete history;
- runtime can update only case workflow columns; and
- runtime cannot alter tenant, student, creator, or creation-time linkage.

The migration journal terminal entry is index `36` with tag
`0037_m11_collections_control_plane`.

## 9. Verification record

Final verification completed before closeout:

- targeted M11 DB integration: `10/10` passing;
- targeted M11 route integration: `5/5` passing;
- M11 authorization suite: `2/2` passing;
- unit suite: `4` files / `30` tests passing;
- full Vitest suite: `31` files / `279` tests passing;
- explicit M10 regression surface: `11/11` tests passing;
- `tsc --noEmit`: pass;
- `npm run lint`: pass with existing repository warnings only;
- `npm run build`: pass; `48/48` static pages generated;
- fresh migration: `new=37 total=37`;
- replay: `new=0 total=37`;
- upgrade through `0036`: `new=36 total=36`, then `0037`: `new=1 total=37`;
- runtime role/RLS/least-privilege and zero-shadow-column audit: pass;
- native `argon2` load/rebuild: pass;
- full Playwright: `32/32` pass on a clean final rerun;
- targeted M11 Prettier verification: pass; and
- `git diff --check`: pass.

The repository-wide Prettier baseline still has unrelated pre-existing
warnings in older files; all new M11 source, tests, migration metadata, and M11
documentation are formatted. Existing PostgreSQL `25001`/`25P01` cleanup
warnings remain non-blocking in older test harness paths; all tests pass.

No M11 tag or freeze is authorized by this document.
