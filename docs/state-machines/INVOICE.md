# Invoice State Machine

Entity: `invoices`

## Valid States
- `DRAFT` — being built; editable; does not contribute to BILLED totals.
- `ISSUED` — finalized, sent/visible; contributes to BILLED; lines are effectively frozen (corrections go through credit/adjustment lines or reversal).
- `PARTIALLY_PAID` — at least one non-reversed allocation exists; outstanding > 0.
- `PAID` — outstanding == 0.
- `VOID` — zeroed out via audit-approved void; net-zero contribution to BILLED; history preserved.

## Allowed Transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| (none) | DRAFT | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | Billing run creates draft, or manual create |
| DRAFT | ISSUED | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | "Issue invoice" action (sends or finalizes) |
| DRAFT | VOID | OWNER, SCHOOL_ADMIN | "Discard draft" (before issuing) — reason required in UI but always safe since not billed |
| ISSUED | PARTIALLY_PAID | system (on allocation) | First allocation applied to invoice |
| ISSUED | PAID | system (on allocation) | Single allocation fully pays invoice |
| ISSUED | VOID | OWNER | Void issued invoice (only permitted if NO non-reversed allocations exist; otherwise credit-note/reversal path must be used) — reason required |
| PARTIALLY_PAID | PAID | system (on allocation) | Final allocation brings outstanding to 0 |
| PARTIALLY_PAID | ISSUED | system (on allocation reversal) | Full reversal of allocations returns to ISSUED state (issued but no paid amount) |
| PAID | PARTIALLY_PAID | system (on reversal) | A full/partial reversal reopens outstanding |
| VOID | (terminal) | — | Cannot transition out of VOID; create a new invoice if needed |

**Note:** Transitions between ISSUED/PARTIALLY_PAID/PAID are SYSTEM-DRIVEN (derived from allocations). Users do not manually set these states. Only DRAFT→ISSUED and →VOID are user-initiated state changes.

## Database Changes Per Transition

- Create (DRAFT): INSERT invoice; INSERT invoice_lines; `total_kobo` computed and set by trigger (sum of lines); `paid_kobo = 0`.
- DRAFT → ISSUED: UPDATE status; set `issue_date`; create audit event; invoice lines frozen (service layer prevents edits; DB trigger prevents direct line mutation once status != DRAFT).
- On allocation (system): INSERT payment_allocation; UPDATE invoice.paid_kobo via trigger; recompute state: if paid == total → PAID; else if paid > 0 → PARTIALLY_PAID.
- On reversal (system): INSERT reversal; UPDATE payment_allocation (mark reversed) or insert compensating allocation record; UPDATE invoice.paid_kobo via trigger; recompute state.
- ISSUED → VOID: UPDATE status, set voided_at/voided_reason; create audit; VOID invoices do not contribute to BILLED aggregations. Trigger blocks VOID on invoices with non-reversed allocations.

## Audit Events
- `invoice.created` (DRAFT)
- `invoice.issued`
- `invoice.voided` (with reason)
- `invoice.line_added` (only in DRAFT state)
- `invoice.line_removed` (only in DRAFT state)
- `invoice.paid` (system; fires on transition to PAID)
- `invoice.partially_paid` (system; fires on transition to PARTIALLY_PAID, once per lifecycle to avoid noise)
- `invoice.reopened` (system; fires if reversal brings from PAID back to PARTIALLY_PAID/ISSUED)

## Failure Behavior

- Issue with invalid/missing required fields → 400.
- Void of invoice with non-reversed allocations → 422 ("Cannot void an invoice with recorded payments. Reverse payments first or issue a credit note.").
- Line edit on non-DRAFT invoice → 422 ("Invoice is no longer a draft; issue a credit note or adjustment instead.").
- Concurrent allocation handled via row locking (see /docs/CONCURRENCY_DESIGN.md).
- Any failure rolls back the entire transaction; audit event is only written if the state change commits (or a failure event is logged at error level).

## Invariant Notes

- `total_kobo = Σ(invoice_lines.amount_kobo)` always (F1, trigger enforced).
- `paid_kobo = Σ(non-reversed payment_allocations.amount_kobo)` for this invoice (derived via trigger, not directly editable).
- `outstanding_kobo = total_kobo − paid_kobo` (computed in views/services; not stored).
- VOID invoices do not contribute to BILLED, COLLECTED, or OUTSTANDING (net zero).
- Re-opening a PAID invoice due to reversal is a financially significant event — surfaced in audit and in Command Center exceptions for a brief period.
