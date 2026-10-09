# Payment State Machine

Entity: `payments`

## Valid States

- `PENDING` — recorded but not confirmed. For online payments: webhook received but not yet signature-verified or bank-side confirmed. For manual payments: finance officer may mark PENDING while awaiting cash handover / bank confirmation.
- `CONFIRMED` — verified as received; eligible for allocation; counts toward COLLECTED.
- `DUPLICATE_SUSPECT` — suspected duplicate of an existing payment (same external reference and/or same amount+student+window); held for review; NOT allocated until resolved.
- `REVERSED` — fully reversed; no longer contributes to collected totals.
- `REFUNDED` — money returned to payer; treated like reversal in totals but kept distinct for reporting.
- `FAILED` — payment attempt failed (online payment declined, or webhook confirms failure); no financial effect.
- `REJECTED` — a payment attempt rejected before it becomes authoritative collected money. The M10 reconciliation control plane does not invent a duplicate-to-rejected transition; duplicate financial consequences use the existing reversal/refund mechanisms.

## Allowed Transitions

| From                              | To                | Actor                                                  | Trigger                                                                                                                          |
| --------------------------------- | ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| (none)                            | CONFIRMED         | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER                   | Record payment (cash/transfer/POS/manual) — default path because officer is confirming at entry                                  |
| (none)                            | PENDING           | system / finance officer                               | Online payment initiated; or manual entry marked as provisional (e.g., "parent says they transferred but we haven't seen alert") |
| (none)                            | FAILED            | system                                                 | Webhook confirms charge failure                                                                                                  |
| PENDING                           | CONFIRMED         | system (webhook) or finance officer                    | Webhook confirms success; or officer verifies bank/cash                                                                          |
| PENDING                           | FAILED            | system (webhook)                                       | Charge failed; timeout with no success event                                                                                     |
| PENDING                           | DUPLICATE_SUSPECT | system / finance officer                               | Duplicate detection fires during verification                                                                                    |
| CONFIRMED                         | REVERSED          | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER (with permission) | Full reversal with reason                                                                                                        |
| CONFIRMED                         | REFUNDED          | OWNER, SCHOOL_ADMIN (with permission)                  | Refund processed (Paystack refund or cash refund); reason required                                                               |
| CONFIRMED                         | DUPLICATE_SUSPECT | OWNER, FINANCE_OFFICER                                 | User manually flags as possible duplicate (rare after initial confirm)                                                           |
| DUPLICATE_SUSPECT                 | CONFIRMED         | OWNER, FINANCE_OFFICER                                 | After review: confirmed legitimate (e.g., different siblings/same ref)                                                           |
| DUPLICATE_SUSPECT                 | REVERSED          | OWNER, FINANCE_OFFICER                                 | After review: duplicate and money needs reversal/refund; use the existing reversal/refund path                                   |
| PENDING                           | REJECTED          | OWNER, FINANCE_OFFICER                                 | Unmatched / unowned payment rejected (e.g., wrong school)                                                                        |
| REVERSED/REFUNDED/FAILED/REJECTED | (terminal)        | —                                                      | Corrections done via new payment records, not by reopening (to preserve history)                                                 |

**Note:** Overpayments/underpayments do NOT create new payment states; they are allocation outcomes (surplus becomes `unallocated_kobo` on the payment; shortfall leaves invoice outstanding).

## Database Changes Per Transition

- Record (initial): INSERT payments with status per above. For manual (cash/transfer/POS), default CONFIRMED. For online, initial PENDING.
- PENDING → CONFIRMED: UPDATE status; insert any missing audit; trigger allocations if payment links to a known invoice/student (auto-allocation rules in `/docs/FINANCIAL_INVARIANTS.md` §V).
- CONFIRMED → REVERSED/REFUNDED: INSERT reversals (append-only); reverse allocations (mark allocations reversed); recompute invoice states; update payment status.
- DUPLICATE_SUSPECT → CONFIRMED: only after human evidence and only when the existing unallocated balance is positive; the M10 route delegates to the existing payment status trigger and then leaves allocation to the existing allocation path. Fully allocated duplicate-suspect payments are not re-confirmed because the legacy timestamp trigger must not reinitialize `unallocated_kobo`.
- M10 `DUPLICATE_REVIEWED` resolution records a durable reconciliation decision without changing payment money. If money must be undone, the operator uses the existing reversal/refund endpoint.
- All state changes happen inside a transaction; if any allocation/invoice update fails, the payment state does not change.

## Audit Events

- `payment.created` (with initial status, method, amount_kobo, actor)
- `payment.confirmed`
- `payment.flagged_duplicate` (with matching payment id(s))
- `payment.reversed` (with reason, reversal id)
- `payment.refunded` (with reason, refund id)
- `payment.rejected` (with reason)
- `payment.failed` (system, with provider failure reason)

## Failure Behavior

- Invalid state transition (e.g., FAILED → CONFIRMED) → 409.
- Reversal with no reason → 400.
- Reversal amount greater than payment's allocated amount → 422 ("Cannot reverse more than has been confirmed/allocated").
- Concurrent confirmations: idempotency key + row locking prevents double-confirm.
- Late webhook for already-REFUNDED payment: state-machine blocks direct state change; routes to reconciliation queue as `FLAGGED` for human review; does NOT silently re-confirm.

## Invariant Notes

- Amount is strictly positive (F2); reversals/refunds are separate rows (never negative payment).
- CONFIRMED payments never disappear (F5).
- REVERSED/REFUNDED payments do not contribute to COLLECTED (F7).
- Duplicate external references are handled via unique constraint + DUPLICATE_SUSPECT state (F8).
- Webhook idempotency: state machine + idempotency table (F9).
- A payment without allocations shows as `UNALLOCATED` in reconciliation, regardless of status (as long as CONFIRMED).
