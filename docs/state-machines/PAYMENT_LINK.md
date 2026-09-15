# Payment Link State Machine

Entity: `payment_links`

## Valid States

- `ACTIVE` — link can be viewed and used for payment.
- `PAID` — link has been used to complete a payment (terminal for the link; receipt shown).
- `EXPIRED` — link passed its expiry timestamp without payment; shows expired page.
- `REVOKED` — school revoked the link (e.g., invoice corrected); shows revoked page.

## Allowed Transitions

| From         | To         | Actor                                | Trigger                                                                                                                                                              |
| ------------ | ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)       | ACTIVE     | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | Create payment link (for an invoice or a student)                                                                                                                    |
| ACTIVE       | PAID       | system                               | Payment successfully recorded for this link (Paystack success webhook matched OR cash/transfer confirmed against link)                                               |
| ACTIVE       | EXPIRED    | system (cron/on-access check)        | expires_at < now() and not PAID                                                                                                                                      |
| ACTIVE       | REVOKED    | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | Manual revoke (e.g., invoice voided, parent requested new link)                                                                                                      |
| EXPIRED      | ACTIVE     | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER | Resend/extend (creates a new link? or reactivates? RECOMMENDATION: create a new link with new token to avoid confusion; old link stays EXPIRED. Decision: new link.) |
| REVOKED/PAID | (terminal) | —                                    | New link must be created; never reuse a paid/revoked token                                                                                                           |

## Database Changes Per Transition

- Create (ACTIVE): INSERT payment_links; token = 256-bit crypto-random URL-safe string; expires_at set (default: 30 days; shorter for reminder links).
- ACTIVE → PAID: UPDATE status; set paid_at, paid_payment_id; a payment (and allocations) must already exist before this transition.
- ACTIVE → EXPIRED: UPDATE status; no financial effect.
- ACTIVE → REVOKED: UPDATE status; audit event; any future access returns 410 GONE page.

## Audit Events

- `payment_link.created`
- `payment_link.paid` (system)
- `payment_link.expired` (system; debug-level; not always surfaced to user)
- `payment_link.revoked` (with reason)

## Failure Behavior

- Access link that doesn't exist → 404 (not 403, to avoid confirming existence — though token is 256-bit random, so brute force is infeasible).
- Access EXPIRED link → 410 with clear "This link has expired" page and CTA to request new one from school.
- Access REVOKED link → 410 with "This link is no longer valid" page.
- Access PAID link → show receipt/confirmation page (idempotent).
- Tampered/modified token (signed) → rejected by signature check; returns 404.
- Concurrent access/payment attempts: link row locked on payment matching; only one payment can set PAID; subsequent attempts treat payment as duplicate and route to reconciliation.

## Invariant Notes

- Token is unguessable (256 bits from crypto-safe RNG).
- Token-only access exposes minimal data: student first name, class, invoice lines owed, total, school name/logo — does not expose other students, other invoices, school financial totals, guardian PII beyond the specific guardian context.
- Link expiry is enforced server-side, not just in UI.
- Revoking a link does NOT void the underlying invoice; invoice remains payable via other channels or a new link.
