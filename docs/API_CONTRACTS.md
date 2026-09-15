# SCOLAIRA — API Contracts

> One contract. One meaning. One source of truth.

- All API responses are JSON (except CSV/PDF exports and parent payment pages which are HTML).
- All monetary values in API are **Naira strings**, e.g. `"150000.00"` (regex: `^\d{1,15}\.\d{2}$`).
- Internal to the service, values are integer kobo.
- All authenticated endpoints require a valid session cookie + CSRF token for mutating requests.
- All tenant endpoints enforce `organization_id` membership; cross-tenant access returns 404 (not 403, to avoid existence leaks where appropriate; 403 is fine for authenticated intra-tenant permission failures).
- Every mutation is idempotent via `Idempotency-Key` header (UUID string); retries with same key within 24h return original response.
- Errors are deterministic: `{ "error": { "code": "ERROR_CODE", "message": "human readable", "detail": {...} } }` with appropriate HTTP status.
- Pagination: cursor-based for large lists (`cursor`, `limit`); response includes `nextCursor`.

## I. Error Codes (Initial Set)

| HTTP | Code | Meaning |
|---|---|---|
| 400 | VALIDATION_ERROR | Request body/params invalid; details include field errors. |
| 401 | UNAUTHENTICATED | No/invalid session. |
| 403 | FORBIDDEN | Authenticated but not allowed for this action. |
| 404 | NOT_FOUND | Resource not found or not accessible in this tenant. |
| 409 | CONFLICT | State conflict (e.g., duplicate idempotency key; invoice already issued; allocation exceeds outstanding). |
| 409 | INVARIANT_VIOLATION | Financial invariant would be broken; transaction rolled back. |
| 410 | EXPIRED | Resource expired (e.g., payment link). |
| 422 | UNPROCESSABLE_ENTITY | Semantically valid request cannot be performed (e.g., voiding an invoice with non-reversed allocations). |
| 429 | RATE_LIMITED | Too many requests; `Retry-After` header present. |
| 500 | INTERNAL_ERROR | Unexpected error; logged with request id. |

## II. Endpoint Groups

### A. Authentication (`/api/auth/*`)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/auth/login` | Email/password login; sets session cookie. | public (rate-limited) |
| POST | `/api/auth/logout` | Invalidate session. | any |
| POST | `/api/auth/refresh` | Refresh session (internal). | session |
| POST | `/api/auth/forgot-password` | Request reset email. | public (rate-limited) |
| POST | `/api/auth/reset-password` | Consume reset token & set new password. | public |
| GET  | `/api/auth/me` | Current user + memberships. | authenticated |

### B. Organization / Onboarding (`/api/orgs*`, `/api/onboarding*`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/orgs` | Create organization (signup flow; caller becomes OWNER). |
| GET/PATCH | `/api/orgs/:id` | View/update organization (OWNER/SCHOOL_ADMIN per matrix). |
| GET | `/api/onboarding/state` | Current onboarding progress. |
| POST | `/api/onboarding/complete-step` | Mark step complete (with validation). |

### C. Sessions & Terms (`/api/sessions*`, `/api/terms*`)

Standard CRUD + set-current. List responses include counts (students, billed amount).

### D. Classes (`/api/classes*`)

Standard CRUD. Includes `students_count` and rollover helper (copy classes from prior session).

### E. Students (`/api/students*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/students` | List/search students; filters: class, status, term, search. Cursor paginated. |
| POST | `/api/students` | Create student + guardians. |
| GET | `/api/students/:id` | Detail + guardians + financial summary per term. |
| PATCH | `/api/students/:id` | Update (audited). |
| POST | `/api/students/:id/archive` | Archive (reason required). |
| POST | `/api/students/:id/withdraw` | Withdraw (reason required; handles outstanding balance policy). |
| POST | `/api/students/import` | CSV import: expects multipart; returns job with dry-run results. |
| GET | `/api/students/import/:jobId` | Import job status and per-row errors. |

### F. Fee Catalog (`/api/fees*`, `/api/fee-assignments*`)

CRUD for fee definitions and per-class/per-term assignments.

### G. Billing (`/api/billing*`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/billing/preview` | Preview billing run (term, classes) — who will be billed, total amount, exceptions. |
| POST | `/api/billing/run` | Execute billing: creates DRAFT invoices per student for assigned fees. Transactional; idempotent per (term_id, class_id, billing_run_id). |
| POST | `/api/billing/issue` | Issue selected DRAFT invoices → ISSUED. |
| POST | `/api/billing/void-invoice` | Void an invoice (requires reason; only if no non-reversed allocations or after reversal). |

### H. Invoices (`/api/invoices*`)

List, detail, PDF/print. Detail response includes lines, allocations, receipts, outstanding, payments.

### I. Payments (`/api/payments*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/payments` | List; filters: method, status, student, date range, unreconciled flag. |
| POST | `/api/payments` | Record a payment (cash/transfer/POS/manual). Body includes amount (naira string), method, student, paid_at, reference, allocations (optional — if omitted, deterministic auto-allocation runs). |
| GET | `/api/payments/:id` | Detail + allocations + receipt. |
| POST | `/api/payments/:id/confirm` | Confirm a PENDING payment (e.g., after reviewing bank alert). |
| POST | `/api/payments/:id/reverse` | Reverse/refund (reason required; amount can be partial). |
| POST | `/api/payments/:id/allocate` | Manual allocation or reallocation. |
| POST | `/api/payments/:id/receipt` | Issue/reissue receipt (channel: PRINT/EMAIL/WHATSAPP). |
| GET | `/api/payments/unreconciled` | Queue: PENDING + DUPLICATE_SUSPECT + unmatched (student_id null). |

**POST /api/payments body example:**
```json
{
  "student_id": "uuid",
  "method": "CASH",
  "amount": "100000.00",
  "paid_at": "2026-09-15T10:30:00+01:00",
  "external_reference": null,
  "notes": "Paid in person at bursary",
  "allocations": [
    { "invoice_id": "uuid", "amount": "100000.00" }
  ]
}
```

### J. Reconciliation (`/api/reconciliation*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/reconciliation/queue` | Payments TO CONFIRM / TO ALLOCATE / DUPLICATE_SUSPECT / FLAGGED. |
| POST | `/api/reconciliation/:id/confirm` | Confirm a pending payment (matching bank evidence). |
| POST | `/api/reconciliation/:id/match-student` | Attach student to an unmatched transfer (suggestions shown based on amount/ref/name). |
| POST | `/api/reconciliation/:id/resolve-duplicate` | Mark as duplicate (link to original) or not duplicate. |
| POST | `/api/reconciliation/:id/allocate` | Allocate (same as payments/:id/allocate but in reconciliation context). |
| POST | `/api/reconciliation/:id/flag` | Flag for follow-up with reason. |

### K. Payment Links (`/api/payment-links*`)

Create, revoke, list. Public lookup/use is handled by separate public endpoints under `/pay/*` (SSR pages, not JSON API).

### L. Communication (`/api/comms*`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/comms/send-reminder` | Send payment reminder to a guardian (channel, template, invoice/payment context). |
| POST | `/api/comms/send-receipt` | Send receipt (email/WhatsApp). |
| GET | `/api/comms/events` | List communication events; per-student history. |

### M. Reports (`/api/reports*`)

All reports accept `term_id` (required) plus optional `class_id`, `date_range`. Every response indicates data_as_of timestamp.

| Path | Returns |
|---|---|
| `/api/reports/summary` | Billed/Collected/Outstanding/Overdue/Unreconciled/Collection rate + deltas. |
| `/api/reports/outstanding` | List of outstanding accounts with aging buckets. |
| `/api/reports/aging` | Aging buckets (0-30, 31-60, 61-90, 90+) total and per class. |
| `/api/reports/collection-by-class` | Per-class collection rate and totals. |
| `/api/reports/fee-line-recovery` | Per-fee-definition recovery rate. |
| `/api/reports/payment-methods` | Totals by method over period. |
| `/api/reports/prior-term-exposure` | Students with prior-term balances. |
| `/api/reports/reconciliation-status` | Unreconciled/duplicate/flagged counts and amounts. |
| `/api/reports/export` | CSV/PDF export of any of the above (streamed). |

### N. Command Center (`/api/command-center*`)

- `GET /api/command-center/overview` → the "WHERE IS OUR MONEY" payload.
- `GET /api/command-center/actions` → priority action list (overdue high-value, unreconciled, duplicates, prior-term, missed commitments) with explainable priority rationales.

### O. Audit History (`/api/audit*`)

List (OWNER/SCHOOL_ADMIN with permission); filter by entity, actor, action, date range. Append-only; no update/delete endpoints.

### P. Staff & Permissions (`/api/staff*`, `/api/memberships*`)

Invite staff, set role, disable, resend invite. OWNER-only for OWNER role changes.

### Q. Settings (`/api/settings*`)

Org profile, term/session defaults, communication preferences, receipt template branding.

### R. Platform Admin (`/api/admin/*`)

Separate route segment; requires PLATFORM_ADMIN role; every request audited.
- `/api/admin/schools` list/view
- `/api/admin/schools/:id/subscription`
- `/api/admin/schools/:id/support-session` (start/end audited access)
- `/api/admin/metrics` platform-wide
- `/api/admin/audit` platform audit log

### S. Public / Parent Payment Pages (SSR, not JSON)

- `GET /pay/:token` — public payment page (mobile-first, shows balance + itemization + payment methods).
- `POST /pay/:token/initiate` — server-side initiates Paystack transaction or records non-online method.
- `GET /pay/:token/success` — success page (after return from Paystack or after manual confirmation).
- `GET /pay/:token/receipt/:receiptId` — public receipt view (signed token, limited time).

### T. Webhooks (`/api/webhooks/*`)

- `POST /api/webhooks/paystack` — Paystack webhook endpoint. Signature-verified, idempotent, raw body.

## III. Pagination, Filtering & Sorting Conventions

- List endpoints accept `?cursor=...&limit=50&sort=field:dir&filter[status]=CONFIRMED`.
- Max `limit` = 100; default = 20 for detail-heavy lists, 50 for simple lists.
- Sort fields are whitelisted per endpoint.
- Date filters: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, Africa/Lagos date interpretation).

## IV. Idempotency

- Header: `Idempotency-Key: <uuid>` recommended on all POST/PATCH/PUT/DELETE.
- Repeated requests with same key return the stored response (status + body) within 24h (API) or 30 days (webhooks).
- If request body differs (hash mismatch), return `409 IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_BODY`.
- Webhook idempotency is additionally keyed by `(provider, event_id)`.

## V. Versioning

- API is unversioned during pilot; breaking changes use a rolling transition with dual-write and deprecation headers (`Deprecation: true`, `Sunset: <date>`).
- Once out of pilot, formal `/api/v1/` prefix will be introduced.

## VI. Open Questions (for founder/architecture decision)

1. Exact pagination: cursor vs offset for report lists? (Recommend cursor for large student/payment lists; offset acceptable for small config lists.)
2. PDF receipt generation client-side vs server-side? (Recommend server for signed records.)
3. Bulk actions: batch endpoint for issuing invoices / sending reminders? (Defer to Phase 2.)
