# Fee Definition & Fee Assignment State Machines

Entities: `fee_definitions`, `fee_assignments`

## Fee Definitions (catalog entries, e.g., "Tuition")

### Valid States
- `ACTIVE` — available for assignment.
- `ARCHIVED` — no longer assignable to new terms; existing assignments/invoices referencing it remain valid.

### Transitions
- Create → ACTIVE.
- ACTIVE → ARCHIVED (OWNER/SCHOOL_ADMIN): "retire fee type."
- ARCHIVED → ACTIVE (OWNER/SCHOOL_ADMIN): "restore fee type."

Fee definitions are never hard-deleted if referenced by assignments/invoices (audit/history).

## Fee Assignments (an instance of a fee for a class/term with an amount)

### Valid States
- `DRAFT` — created, not yet billed against; editable (amount, due date, class).
- `ACTIVE` — finalized and used (or usable) for billing in the term.
- `ARCHIVED` — no longer active (e.g., replaced, term ended).

### Transitions
- Create → DRAFT.
- DRAFT → ACTIVE (OWNER/SCHOOL_ADMIN/FINANCE_OFFICER with permission): finalized; billing can use it.
- ACTIVE → ARCHIVED (OWNER/SCHOOL_ADMIN): remove from future billing runs.
- ARCHIVED → ACTIVE (OWNER/SCHOOL_ADMIN): restore.

### Editing Rules
- While DRAFT: all fields editable.
- Once ACTIVE: amount/due date/class CAN be edited BEFORE any invoice is issued using this assignment; after invoices exist, changes are blocked and a new fee assignment version must be created (to keep historical invoices consistent).
- After billing: edits are blocked; adjustments are done via credit/adjustment invoice lines.

## Audit Events
- `fee_definition.created`, `fee_definition.archived`, `fee_definition.restored`
- `fee_assignment.created`, `fee_assignment.activated`, `fee_assignment.edited` (only allowed while DRAFT or pre-billing ACTIVE), `fee_assignment.archived`

## Failure Behavior

- Edit ACTIVE assignment that has been used in invoices → 422 ("This fee has been billed. Create a new assignment or use an adjustment invoice line instead.").
- Archive fee definition with active assignments → warn; archive cascades a warning but existing assignments/invoices remain untouched.
