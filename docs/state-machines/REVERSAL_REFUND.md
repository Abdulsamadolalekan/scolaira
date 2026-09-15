# Reversal / Refund Model

Entities: `reversals` (append-only)

## Note on Modeling

Reversals and Refunds are **append-only records** — they do not have meaningful lifecycle states once created (they are RECORDED and that is their permanent state). Any "cancellation" of a reversal is a new corrective entry (e.g., a new payment) rather than an undo.

## Types

- `REVERSAL` — internal correction (e.g., payment recorded in error, wrong student, duplicate resolved by removing). May be full or partial.
- `REFUND` — money returned to payer (e.g., Paystack refund initiated, cash handed back). Requires an external settlement action tracked separately.
- `CORRECTION` — accounting correction (rare; used to fix an allocation error without implying money movement).

## Creation Rules

- Created only by OWNER, SCHOOL_ADMIN, or FINANCE_OFFICER (permissions matrix).
- `reason` is REQUIRED (free text, non-empty).
- Must reference either a payment, an allocation, or both.
- `amount_kobo` must be positive.
- Total reversed amount against a payment cannot exceed payment.amount_kobo.
- Total reversed against an allocation cannot exceed allocation.amount_kobo.
- A refund must reference a payment whose provider supports refund (e.g., Paystack online payments); for cash/transfer refunds, the refund is recorded manually with reference to the cash-handover or bank transfer.

## Database Effects

On insert (transactional):

1. Insert reversals row.
2. If reversing specific allocations: mark those allocations reversed (link to reversal).
3. If reversing entire payment: mark all ACTIVE allocations for the payment reversed; set payment status to REVERSED or REFUNDED.
4. Update invoice.paid_kobo via triggers (decrement by reversed amount).
5. Recompute invoice state (PAID → PARTIALLY_PAID → ISSUED).
6. Void any receipts that are now invalid; audit.

## Audit Events

- `payment.reversed` / `payment.refunded`
- `allocation.reversed`
- `receipt.voided` (if triggered by reversal)

## Failure Behavior

- Reversal without reason → 400.
- Reversal exceeds reversible amount → 422.
- User without permission → 403.
- Concurrent reversals: row lock on payment; second reversal sees post-first-reversal state and is bounded by remaining amount; if two reversals would together exceed, the second fails with 409.
- Refund via Paystack that fails at provider: reversal record is NOT created until we confirm provider-side success; webhook confirmation triggers the reversal.

## Invariant Notes

- Reversals are the ONLY way to decrease COLLECTED totals (F6, F7).
- Reversals do not delete payment records (F5).
- Partial reversals leave payment in CONFIRMED state with reduced allocated amount (so invoice re-opens appropriately). Full reversals set payment to REVERSED/REFUNDED.
- A refund always involves actual money movement; a reversal may be bookkeeping-only (e.g., duplicate resolution with no money movement because the duplicate was never real).
