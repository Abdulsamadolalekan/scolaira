# Receipt State Machine

Entity: `receipts`

## Valid States
- `ISSUED` — receipt issued and available to parent/school.
- `VOID` — receipt voided (e.g., because payment was reversed); does NOT mean payment itself is invalid — it means this particular receipt document is no longer authoritative. A new receipt for corrected state can be issued.

## Allowed Transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| (none) | ISSUED | system (on payment confirm/allocation) or finance officer (manual reissue) | Receipt generated with unique receipt number |
| ISSUED | VOID | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | Void receipt (reason required); typically triggered automatically when the underlying payment is fully reversed |
| VOID | (terminal) | — | Re-issue creates a new ISSUED receipt; never edit-revive a voided receipt |

## Database Changes Per Transition

- ISSUED: INSERT receipts; receipt_number generated from org-sequential sequence; amount_kobo set to total allocated amount at time of issue (for the payment/invoice context).
- VOID: UPDATE status, set voided_at; audit event.

## Audit Events
- `receipt.issued` (channel: PRINT/EMAIL/WHATSAPP/SMS_LINK)
- `receipt.voided` (with reason)

## Failure Behavior

- Attempt to issue receipt for unconfirmed payment → 422 `PAYMENT_NOT_CONFIRMED`.
- Duplicate receipt on same payment in same channel within short window → return existing receipt (idempotent), not a new one, unless user explicitly requests reissue.

## Invariant Notes

- Receipts are evidence of a transaction; they are not the transaction itself. Voiding a receipt does not alter financial truth — it only retires that document.
- A receipt is always issued for a payment and reflects the state at issuance; subsequent reversals void the original receipt and a corrected receipt can be issued reflecting the reversal.
- Receipt numbers are unique per organization and sequentially assigned (no gaps visible to parents; gaps are allowed only on voided/never-sent drafts).
