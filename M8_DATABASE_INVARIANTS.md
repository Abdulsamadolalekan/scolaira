# SCOLAIRA M8 — Database Invariant Resolution

Status: **approved for implementation by the M8 build authorization**

This document resolves the financial and lifecycle invariants that must hold at the database boundary before migration `0020_term_billing.sql` is applied. The database remains the final authority; UI checks and TypeScript checks are advisory only.

## 1. Duplicate billing: the exact key

The billable fact is:

```text
(organization_id, student_id, term_id, fee_assignment_id)
```

`invoice_lines` already carries `invoice_id` and `fee_assignment_id`, but PostgreSQL cannot build a unique index across the parent invoice's `student_id` and `term_id`. A join-dependent unique index is not expressible directly. The smallest safe schema change is therefore to add two denormalized, nullable guard columns to `invoice_lines`:

- `billing_student_id uuid`
- `billing_term_id uuid`

They are populated only for fee-assignment-backed term-billing lines. Ad-hoc invoice lines leave both columns NULL. A `BEFORE INSERT OR UPDATE` trigger enforces that, whenever `fee_assignment_id` is non-NULL:

1. both guard columns are non-NULL;
2. they equal the parent invoice's `student_id` and `term_id`;
3. the line's `organization_id` equals the invoice's organization;
4. the fee assignment belongs to the same organization and its `term_id` equals `billing_term_id`.

The database then owns the uniqueness rule:

```sql
CREATE UNIQUE INDEX invoice_lines_term_fee_student_unique_idx
  ON invoice_lines (organization_id, billing_student_id, billing_term_id, fee_assignment_id)
  WHERE fee_assignment_id IS NOT NULL;
```

The index is intentionally not released when an invoice is voided. A void is an audit-preserving correction, not permission for an automatic reissue. Rebilling a voided fee requires a future explicit correction/add-fee workflow; M8 must not silently turn a void into a second obligation. This makes the invariant stronger and avoids a partial-index predicate that would need to inspect a parent row (which PostgreSQL indexes cannot do).

Consequences under concurrency:

- two transactions trying to issue the same key cannot both commit; one blocks on the unique index and then fails with `23505`;
- two bill runs for one term serialize on the term row lock as an additional control, but correctness does not depend on that lock;
- a client retry, browser refresh, or timeout-after-commit sees the existing key and creates no duplicate;
- an enrollment added after the first commit has a different student key and is safely handled by the next top-up run.

## 2. Effective fee assignment and cohort completeness

A school-wide assignment (`class_id IS NULL`) applies to every enrollment. A class-specific assignment for the same fee definition and term overrides the school-wide assignment for students in that class; this avoids charging a student twice for one named fee when a class price is intentionally configured. The database permits one school-wide assignment per `(organization, fee_definition, term)` and the existing class-scoped uniqueness plus the M8 effective-assignment index prevents duplicate configuration rows. Fee assignment writes are blocked after billing, so a later run cannot silently change an already-issued student's fee structure.

`billTerm` runs inside one database transaction. It first locks the target term with `SELECT ... FOR UPDATE`. Structural writes that can change the billable population or fee structure (`class_enrollments` and `fee_assignments`) take a conflicting `FOR SHARE` lock on their term in a database trigger. Consequently:

- writes that committed before billing are visible to the bill run;
- writes that arrive while billing holds the term lock wait until billing commits, then are handled as a post-billing change;
- a failed run rolls back invoices, lines, waivers, audit rows, idempotency completion, and the term transition together;
- no half-created cohort can be visible after a failure.

Before changing `ACTIVE → BILLED`, the transaction verifies all of the following from the database:

1. the term is `ACTIVE` and `billed = false`;
2. there is at least one active enrollment;
3. there is at least one active, positive-value fee assignment;
4. every active enrollment has at least one applicable active assignment (after class-specific assignments override school-wide assignments);
5. every applicable `(student, assignment)` key exists on an `ISSUED`, `PARTIALLY_PAID`, or `PAID` invoice line in the same term; a `DRAFT` or `VOID` line is surfaced as a blocked exception and rejects the run because its unique key cannot be silently reused;
6. every generated invoice is `ISSUED` and has the trigger-maintained total expected from its lines;
7. all waiver constraints are satisfied and every generated invoice has a positive total (M8 does not issue zero-total invoices; a full scholarship is deferred to a credit/waiver design that can represent a zero obligation without a zero invoice).

If any check fails, the transaction raises a typed business error and leaves the term `ACTIVE` and unbilled. An empty enrollment set, no active fee assignments, or an enrollment with no applicable fee is therefore a controlled rejection, not a successful empty bill.

A `BILLED` term may be re-run for top-up billing. It remains `BILLED`; only missing keys for newly enrolled students (or other explicitly unbilled keys, if ever introduced by an approved correction path) are created. If there are no missing keys, the transaction returns an unchanged result and writes no financial rows.

## 3. Term state integrity

M8 uses the existing term state machine:

```text
PLANNED → ACTIVE → BILLED → CLOSED
```

The only M8 transition is `ACTIVE → BILLED`, and it is performed by the billing repository after the completeness proof above. `billed_at` and `billed_by` are written in the same update. The database adds a consistency check:

- `status = 'BILLED'` requires `billed = true`;
- `billed = true` requires `status IN ('BILLED', 'CLOSED')`.

`PLANNED` and `CLOSED` bill attempts are rejected. `BILLED` is not rejected outright: it is the explicit idempotent/top-up path described above.

Fee assignments cannot be inserted, deleted, or materially changed once their term is `BILLED` or `CLOSED`. Enrollments may be added to a `BILLED` term (the supported post-billing top-up case), but not to `CLOSED`.

## 4. Waivers / concessions

M8 supports a concession attached to one fee-assignment-backed invoice line during the bill transaction.

### Authority

Only the `term.bill` API action can create a waiver. `term.bill` is granted to `OWNER` and `FINANCE_OFFICER`; it is not granted to `SCHOOL_ADMIN`, `STAFF`, or platform support mode. The route requires the existing CSRF and tenant/authz gates. `approved_by` is the authenticated acting user and the database trigger rejects a waiver whose approver does not match `app.user_id`.

The database does not attempt to reproduce the TypeScript role matrix in a user-settable GUC. RLS, the authenticated route boundary, and audit attribution are the security controls; the database independently enforces tenant ownership, draft-only attachment, amount constraints, immutability, and invoice-line consistency.

### Shape and amount

`waivers.amount_kobo` stores the positive magnitude of the concession. It is `kobo_value`, must be greater than zero, and has a unique `invoice_line_id` (one structured concession per generated line in M8). The fixed reason enum is:

```text
SCHOLARSHIP | SIBLING_DISCOUNT | STAFF_CHILD | EARLY_PAYMENT | OTHER
```

`note` is optional and bounded. The waiver trigger requires:

- the line exists in the same tenant;
- the line has a `fee_assignment_id` and belongs to a `DRAFT` invoice;
- the line is not already attached to a waiver;
- the amount is no greater than the line's current gross amount (`unit_rate_kobo × quantity + current adjustment`);
- the resulting line amount remains non-negative.

On insert, the database applies the concession to the draft line by subtracting the positive waiver magnitude from `invoice_lines.adjustment_kobo` and recomputing `amount_kobo` from the same formula. The existing invoice-line trigger then recomputes the draft invoice total. This is still the ordinary invoice-line truth; `waivers` is an immutable explanation/approval record, not a balance ledger.

`invoice_lines.adjustment_kobo` must therefore become signed. Its existing non-negative check is removed; `amount_kobo` remains a non-negative `kobo_value`, and the existing exact formula remains mandatory:

```text
amount_kobo = unit_rate_kobo × quantity + adjustment_kobo
```

M8 rejects a waiver that would make a generated invoice total zero. A full concession is a deliberate future credit/waiver design decision, not a zero-value invoice hidden inside a bill run.

### Immutability and audit

Waivers are insert-only. RLS, revoked UPDATE/DELETE privileges, and an immutable trigger prevent edits/deletes. Their reason, amount, approver, invoice line, and timestamp remain queryable. The bill transaction also writes:

- the normal per-invoice `invoice.create` audit event;
- one `term.bill` event containing the term, actor, generated invoice count, total, and a structured waiver summary (student/assignment/amount/reason identifiers).

After invoice issuance, the existing invoice-line immutability trigger prevents changing the line or its concession. The waiver row cannot be changed independently.

## 5. Retry semantics

The bill endpoint accepts an optional `Idempotency-Key`. When present, the existing tenant-scoped idempotency table caches the committed response. A request with the same key replays that response; an in-flight key is not allowed to execute a second body.

The key is not the financial guarantee. The invoice-line unique key is. Therefore a retry without a key is also safe: the term lock and unique index return `created = 0, unchanged = N` after the original commit. If a network fails after commit, the next request observes ordinary invoices and the billed term rather than recreating them. A new enrollment creates only its own missing key and is included by a later top-up run.

## 6. What is deliberately not a database invariant in M8

- No second billing ledger or `billing_batches` table is required; the ordinary invoice/line rows plus audit events are the source of truth.
- No database role-level policy duplication is introduced; `term.bill` remains in the existing application authorization matrix.
- No bank import, allocation heuristic, carry-forward, wallet, portal, provider integration, or reporting expansion is needed to prove controlled obligation creation.
