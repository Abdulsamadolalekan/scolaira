# Payment Allocation State Machine

Entity: `payment_allocations`

## Valid States

- `ACTIVE` — current allocation; contributes to invoice's paid_kobo; reduces outstanding.
- `REVERSED` — allocation undone by a reversal; no longer contributes to paid_kobo; history preserved.

## Allowed Transitions

| From   | To       | Actor                                                  | Trigger                                                                     |
| ------ | -------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| (none) | ACTIVE   | system (auto) or finance officer (manual)              | Allocation created (either at payment confirm or manually)                  |
| ACTIVE | REVERSED | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER (with permission) | Reversal of allocation (reason required); or full payment reversal cascades |

## Database Changes Per Transition

- Create (ACTIVE): INSERT payment_allocations; INSERT occurs inside a transaction that:
  1. Locks payment row (`SELECT FOR UPDATE`).
  2. Locks target invoice row (`SELECT FOR UPDATE`).
  3. Checks Σ(existing ACTIVE allocations for payment) + new amount ≤ payment.amount_kobo (F3).
  4. Checks Σ(existing ACTIVE allocations for invoice) + new amount ≤ invoice.total_kobo (F4).
  5. Inserts allocation.
  6. Updates invoice.paid_kobo (via trigger).
  7. Recomputes invoice state (ISSUED → PARTIALLY_PAID → PAID).
- ACTIVE → REVERSED: INSERT reversals record; UPDATE allocation.reversed_by_id to point to reversal; UPDATE invoice.paid_kobo via trigger; recompute invoice state.

## Audit Events

- `allocation.created`
- `allocation.reversed` (with reason)

## Failure Behavior

- Would exceed payment amount → 409 `ALLOCATION_EXCEEDS_PAYMENT`.
- Would exceed invoice outstanding → 409 `ALLOCATION_EXCEEDS_OUTSTANDING`.
- Invoice is VOID → 422 `INVOICE_VOID`.
- Payment not CONFIRMED → 422 `PAYMENT_NOT_CONFIRMED`.
- Concurrent allocations: row locking + constraint; one wins, one fails cleanly with a retryable error (finance officer can retry after refresh).
- If any step fails, the entire transaction rolls back — no partial allocation.

## Invariant Notes

- F3 and F4 are enforced both by triggers and by service-layer checks.
- Allocation amounts are in integer kobo; no fraction-of-kobo. For split payments, remainder is handled by the deterministic allocator (largest-first with explicit remainder rule).
- Reversing an allocation does not delete the row; it marks it reversed for full traceability.
