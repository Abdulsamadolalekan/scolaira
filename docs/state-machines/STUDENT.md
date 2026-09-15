# Student Lifecycle State Machine

Entity: `students`

## Valid States
- `ACTIVE` — enrolled and participating in current term billing.
- `ARCHIVED` — historical record; student no longer actively attending but records retained.
- `GRADUATED` — completed full program (subset of archived for reporting).
- `WITHDRAWN` — left the school before completion; may have outstanding balances.

> **Note:** "GRADUATED" is added after founder review to distinguish completions from generic archival; if founder prefers to keep this as a status flag rather than a state, we will collapse it into ARCHIVED with a `graduated_at` date. RECOMMENDATION: keep as state for reporting clarity but note as DECISION PENDING until founder confirms.

## Allowed Transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| (none) | ACTIVE | OWNER, SCHOOL_ADMIN | Create student |
| ACTIVE | ARCHIVED | OWNER, SCHOOL_ADMIN | Archive (reason required) |
| ACTIVE | WITHDRAWN | OWNER, SCHOOL_ADMIN | Withdraw (reason required + date; balance handling per policy) |
| ACTIVE | GRADUATED | OWNER, SCHOOL_ADMIN | Mark graduated (end of session) |
| ARCHIVED | ACTIVE | OWNER | Re-admit (new enrollment; financial history preserved) |
| WITHDRAWN | ACTIVE | OWNER | Re-admit |
| GRADUATED | ACTIVE | OWNER | Re-enroll (rare, e.g., re-taking) |

## Database Changes Per Transition

- On create: INSERT into students (status='ACTIVE'); INSERT into student_class_enrollments for current term/class.
- On archive/withdraw/graduate: UPDATE status; set `archived_at`/`withdrawn_at`/`graduated_at`; close current enrollment (set `left_on`); do NOT touch invoices/payments/allocations.
- On re-admit: UPDATE status to ACTIVE; create new enrollment for current term/class; preserve all prior financial history.
- **Hard delete:** EXCEPTIONALLY rare (e.g., student created in error before any financial records); only OWNER; blocked by database trigger if any invoices/payments/allocations/audit events reference the student; audit event required with reason.

## Audit Event

- `student.created`
- `student.archived` (with reason)
- `student.withdrawn` (with reason)
- `student.graduated`
- `student.readmitted`
- `student.updated` (for non-lifecycle edits: name, class, contact info)
- `student.deleted` (exceptional, before any financial history; reason required)

Audit event shape: actor, action, student_id, before/after snapshot, reason, timestamp, request_id.

## Failure Behavior

- If transition is invalid (e.g., ARCHIVED → WITHDRAWN): return `409 CONFLICT` with explanation ("Student is already archived; withdraw is not a valid transition from archived state.").
- If attempting to hard-delete a student with financial records: return `422 UNPROCESSABLE_ENTITY` with explanation ("Cannot delete a student with invoices/payments. Archive or withdraw instead to preserve financial history.").
- If reason is required and missing: return `400 VALIDATION_ERROR`.
- All transitions are transactional; if audit write fails, the whole transaction rolls back (no state change without audit).

## Invariant Notes

- Archiving/withdrawing a student does NOT erase or zero out invoices; outstanding balances remain visible in "prior-term exposure" and reports.
- A withdrawn student with outstanding balance continues to appear in the Action Centre under "prior-term / unresolved accounts" until resolved.
- Changing a student's class mid-term is a normal operational UPDATE (not a state transition); the `student_class_enrollments` table records historical membership so financial attribution by class is preserved.
