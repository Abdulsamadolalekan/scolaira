# Audit Model

> Audit history must answer: WHO did WHAT WHEN to WHICH RECORD, with BEFORE/AFTER snapshots and the WHY (reason).

Every financially significant event produces an append-only `audit_events` row. The application database role has INSERT-only on `audit_events`; UPDATE/DELETE are not granted. Platform admins cannot delete audit entries.

---

## I. What Constitutes a Financially Significant Event

An event is financially significant if it affects:

- Who owes money (invoices, billing changes)
- How much is owed (invoice amounts, fee assignments used for billing)
- Who paid money (payments)
- Where money is allocated (allocations)
- What has been reversed/refunded (reversals)
- What evidence of payment was issued (receipts)
- What payment channels were created/revoked (payment links)
- What financial communications were sent (to verify collection actions)
- Who can perform these actions (permission changes)
- What changed a student's financial history (affects balances and exposure)

### II. Required Event Types (Minimum Set)

Per founder item 12:

| Event                                  | Actor                       | Recorded when                                                                                                  |
| -------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `invoice.created`                      | user                        | DRAFT invoice created (manual or billing run)                                                                  |
| `invoice.issued`                       | user                        | DRAFT → ISSUED                                                                                                 |
| `invoice.voided`                       | user                        | ISSUED/DRAFT → VOID (reason required)                                                                          |
| `invoice.line_added`                   | user                        | Line added to DRAFT invoice                                                                                    |
| `invoice.line_removed`                 | user                        | Line removed from DRAFT invoice                                                                                |
| `invoice.paid`                         | system                      | Invoice state → PAID                                                                                           |
| `invoice.partially_paid`               | system                      | Invoice state → PARTIALLY_PAID                                                                                 |
| `invoice.reopened`                     | system                      | PAID → PARTIALLY_PAID/ISSUED due to reversal                                                                   |
| `payment.created`                      | user or system              | Payment row inserted (with initial status)                                                                     |
| `payment.confirmed`                    | user or system              | PENDING → CONFIRMED                                                                                            |
| `payment.flagged_duplicate`            | system or user              | Payment → DUPLICATE_SUSPECT                                                                                    |
| `payment.reversed`                     | user                        | CONFIRMED → REVERSED (reason required; links to reversal)                                                      |
| `payment.refunded`                     | user                        | CONFIRMED → REFUNDED (reason required; links to refund)                                                        |
| `payment.rejected`                     | user                        | DUPLICATE_SUSPECT/PENDING → REJECTED (reason)                                                                  |
| `payment.failed`                       | system                      | → FAILED (online payment failed)                                                                               |
| `allocation.created`                   | system or user              | Allocation inserted                                                                                            |
| `allocation.reversed`                  | user                        | Allocation → REVERSED (reason required)                                                                        |
| `receipt.issued`                       | system or user              | Receipt ISSUED (channel recorded)                                                                              |
| `receipt.voided`                       | user or system              | Receipt → VOID (reason, often tied to reversal)                                                                |
| `payment_link.created`                 | user                        | Link created                                                                                                   |
| `payment_link.revoked`                 | user                        | ACTIVE → REVOKED (reason)                                                                                      |
| `payment_link.paid`                    | system                      | Link → PAID                                                                                                    |
| `payment_link.expired`                 | system                      | Link → EXPIRED (info-level)                                                                                    |
| `communication.queued`                 | user or system              | Message queued                                                                                                 |
| `communication.sent`                   | system                      | Message accepted by provider                                                                                   |
| `communication.delivered`              | system                      | Delivery confirmed                                                                                             |
| `communication.failed`                 | system                      | Delivery failed (error recorded)                                                                               |
| `communication.opt_out`                | guardian (via link) or user | Opt-out recorded                                                                                               |
| `membership.role_changed`              | OWNER                       | Staff role changed (new/old role recorded)                                                                     |
| `membership.invited`                   | OWNER/ADMIN                 | Staff invited                                                                                                  |
| `membership.disabled`                  | OWNER/ADMIN                 | Staff access revoked                                                                                           |
| `student.created`                      | user                        | Student created                                                                                                |
| `student.updated`                      | user                        | Student demographic/class fields changed                                                                       |
| `student.archived`                     | user                        | → ARCHIVED (reason)                                                                                            |
| `student.withdrawn`                    | user                        | → WITHDRAWN (reason)                                                                                           |
| `student.graduated`                    | user                        | → GRADUATED                                                                                                    |
| `student.financial_adjustment`         | user                        | Any change to a student that affects balances (e.g., waiver, scholarship, discount, manual balance adjustment) |
| `fee_assignment.created`               | user                        | Fee assignment created                                                                                         |
| `fee_assignment.edited`                | user                        | Edits before billing                                                                                           |
| `fee_assignment.activated`             | user                        | → ACTIVE                                                                                                       |
| `fee_assignment.archived`              | user                        | → ARCHIVED                                                                                                     |
| `term.billed`                          | user or system              | Term marked BILLED (after billing run)                                                                         |
| `term.closed`                          | OWNER                       | Term CLOSED (with acknowledgement of unreconciled items if any)                                                |
| `billing.run_executed`                 | user                        | Billing run executed (counts, totals recorded)                                                                 |
| `csv_import.completed`                 | user                        | CSV import (students or payments) completed with summary stats                                                 |
| `csv_import.failed`                    | user or system              | Import rejected/failed (errors recorded)                                                                       |
| `settings.changed`                     | OWNER/ADMIN                 | Org settings changes that affect finance (currency, receipt template, reminder policies)                       |
| `auth.login.success`                   | system                      | (security event) Login success                                                                                 |
| `auth.login.failed`                    | system                      | (security event) Login failure                                                                                 |
| `auth.password_reset`                  | user                        | Password reset completed                                                                                       |
| `auth.session_revoked`                 | user                        | Logout / "logout all devices"                                                                                  |
| `platform_admin.impersonation_started` | PLATFORM_ADMIN              | Audited support impersonation began                                                                            |
| `platform_admin.impersonation_ended`   | PLATFORM_ADMIN              | Audited support impersonation ended                                                                            |
| `security.cross_tenant_attempt`        | system                      | Detected cross-tenant access attempt (security)                                                                |

## III. Audit Record Shape

Every audit_event row contains:

| Field           | Type                     | Description                                                                                                      |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| id              | UUID PK                  |                                                                                                                  |
| organization_id | UUID FK (nullable)       | Tenant (null for platform-wide events)                                                                           |
| actor_user_id   | UUID FK users (nullable) | Acting user (null for system/webhook)                                                                            |
| actor_type      | TEXT                     | 'user' / 'system' / 'webhook' / 'platform_admin'                                                                 |
| action          | TEXT                     | One of the event types above                                                                                     |
| entity_type     | TEXT                     | 'invoice', 'payment', 'allocation', etc.                                                                         |
| entity_id       | UUID                     | The record                                                                                                       |
| before          | JSONB                    | Snapshot of changed fields before the mutation (null on create)                                                  |
| after           | JSONB                    | Snapshot after mutation (null on delete — but we never delete financial records; included for exceptional cases) |
| reason          | TEXT                     | Required for reversals, voids, revokes, role changes, student archive/withdraw                                   |
| metadata        | JSONB                    | Context: channel, provider, ip, request_id                                                                       |
| request_id      | TEXT                     | For tracing across logs                                                                                          |
| ip              | INET                     | For user-initiated actions                                                                                       |
| user_agent      | TEXT                     |                                                                                                                  |
| created_at      | TIMESTAMPTZ              | Immutable                                                                                                        |

## IV. The Seven Questions, Per Record

- **WHO** = actor_user_id (resolved to name via users table) + actor_type (e.g., "system via Paystack webhook").
- **DID WHAT** = action (machine-readable event name; displayed in friendly English).
- **WHEN** = created_at (displayed in Africa/Lagos timezone with exact timestamp).
- **TO WHICH RECORD** = entity_type + entity_id, shown as a clickable link to the record (if user has access).
- **BEFORE** = before JSONB (sensitive fields redacted in UI view for non-owners where appropriate).
- **AFTER** = after JSONB (diff-highlighted against BEFORE).
- **WHY** = reason (required for all correction-type actions; optional but encouraged for others).

## V. Audit Integrity

- **Append-only:** `audit_events` has no UPDATE/DELETE grants to the application DB role.
- **Referential integrity:** Audits are not the source of financial truth and do not block deletion of the referenced entity — but our policy is that financial entities are never hard-deleted, so references remain valid.
- **Tamper evidence (DEFERRED):** Pilot does not implement cryptographic chaining (hash chains). The append-only-only guarantee is acceptable at pilot. Post-pilot, add a hash chain where each audit event includes `prev_hash = hash(prev_event.hash + event.fields)` for tamper evidence.
- **Retention:** Indefinite for financial audit events (aligned with 7+ year financial retention).
- **Access:** OWNER can view full audit; SCHOOL_ADMIN can view a subset (e.g., operational but not security/permission changes? RECOMMENDATION: allow full audit to SCHOOL_ADMIN as well — this is a SCHOOL decision; default to OWNER-only for security/permission events and broader for finance events — flagged as DECISION PENDING for founder.)

## VI. Audit UI Requirements

- Filter by: entity_type, entity_id, actor, action, date range.
- For each event show: human-readable description ("Chidi Okoro recorded a cash payment of ₦100,000.00 from Bola Adebayo on invoice INV-2025-0312 at 15 Sep 2026, 10:32 WAT").
- Expandable details show before/after diff and reason.
- CSV export for OWNER with integrity (sanitized against formula injection).
- Sensitive fields (e.g., guardian phone) redacted in UI for users without permission to see them.

## VII. Logging Distinction

Audit events are NOT the same as application logs:

- **Audit events** are permanent, business-meaningful, shown in UI, exported to proprietors.
- **Application logs** are for engineering troubleshooting; they are NOT the audit trail and must not contain sensitive data (per `/docs/OPERATIONS.md`).

Every financial mutation produces BOTH: an audit_event (permanent, visible) AND a log line (operational, request-scoped, no PII).
