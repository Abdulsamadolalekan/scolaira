# Communication Event State Machine

Entity: `communication_events`

## Valid States

- `PENDING` — queued for sending.
- `SENT` — dispatched to provider; awaiting delivery confirmation.
- `DELIVERED` — provider confirmed delivery (where supported).
- `FAILED` — provider returned failure or timeout.

## Allowed Transitions

| From      | To         | Actor                                                                   | Trigger                                                                  |
| --------- | ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| (none)    | PENDING    | OWNER, SCHOOL_ADMIN, FINANCE_OFFICER, system (e.g., automated reminder) | User sends or system queues communication                                |
| PENDING   | SENT       | system                                                                  | Provider accepted message                                                |
| PENDING   | FAILED     | system                                                                  | Provider rejected immediately (e.g., invalid phone, insufficient credit) |
| SENT      | DELIVERED  | system                                                                  | Delivery receipt received (WhatsApp/some SMS)                            |
| SENT      | FAILED     | system                                                                  | Timeout or permanent failure after SENT                                  |
| FAILED    | PENDING    | system or user                                                          | Retry (manual or automatic with backoff)                                 |
| DELIVERED | (terminal) | —                                                                       | Delivered is final (read/response tracking out of scope for pilot)       |

## Database Changes Per Transition

- PENDING: INSERT communication_events; body stored plaintext (SMS/WhatsApp length limits enforced at send time); recipient_address normalized.
- PENDING → SENT: UPDATE status; set sent_at, provider_message_id.
- → DELIVERED: UPDATE status.
- → FAILED: UPDATE status; set error message; increment retry_count; schedule retry if retries remaining.

## Audit Events

- `communication.queued`
- `communication.sent`
- `communication.delivered`
- `communication.failed`
- `communication.suppressed` (when rate/frequency/cap rules prevent send; logged for audit)

## Failure Behavior

- Invalid recipient (bad phone/email format) → 400 at queue time; does not create event.
- Provider API error → FAILED state with retry (max 3 retries with exponential backoff; then requires manual re-send).
- Rate/cap limits → suppressed, not FAILED; UI surfaces "not sent due to per-parent frequency cap."
- Opt-out → suppress silently (honor opt-out list; audit the suppression).

## Invariant Notes

- Every send against a specific guardian is rate-limited per channel (max N reminders per week per parent per type, defaults set by org policy).
- Opt-out list per (organization, guardian, channel) is honored; opt-out is itself an auditable event.
- Messages are plaintext; no HTML in SMS/WhatsApp; email uses pre-built safe templates.
- Messages are NEVER sent to guardians outside the organization (enforced by organization_id scoping + recipient join).
