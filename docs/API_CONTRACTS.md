# SCOLAIRA — API Contracts

> One contract. One meaning. One source of truth.

- All API responses are JSON (except CSV/PDF exports and parent payment pages which are HTML).
- Existing financial APIs return integer `*Kobo` fields (for example `amountKobo`, `unallocatedKobo`); the UI formats those values as Naira. This is the implemented contract, not the earlier aspirational Naira-string example.
- All authenticated endpoints require a valid session cookie + CSRF token for mutating requests.
- All tenant endpoints derive `organization_id` from the authenticated tenant context; clients never choose the organization.
- M10 reconciliation mutations require an `Idempotency-Key` header; retries with the same key within 24h return the original response. Legacy payment routes retain their documented compatibility behavior until separately migrated.
- Errors are deterministic: `{ "error": { "code": "ERROR_CODE", "message": "human readable", "detail": {...} } }` with appropriate HTTP status.
- Pagination: cursor-based for large lists (`cursor`, `limit`); response includes `nextCursor`.

## I. Error Codes (Initial Set)

| HTTP | Code                 | Meaning                                                                                                   |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| 400  | BAD_REQUEST          | Request body/params invalid; details may include field errors.                                            |
| 401  | UNAUTHENTICATED      | No/invalid session.                                                                                       |
| 403  | FORBIDDEN            | Authenticated but not allowed for this action.                                                            |
| 404  | NOT_FOUND            | Resource not found or not accessible in this tenant.                                                      |
| 409  | CONFLICT             | State conflict (e.g., duplicate idempotency key; invoice already issued; allocation exceeds outstanding). |
| 409  | INVARIANT_VIOLATION  | Financial invariant would be broken; transaction rolled back.                                             |
| 410  | EXPIRED              | Resource expired (e.g., payment link).                                                                    |
| 422  | UNPROCESSABLE_ENTITY | Semantically valid request cannot be performed (e.g., voiding an invoice with non-reversed allocations).  |
| 429  | RATE_LIMITED         | Too many requests; `Retry-After` header present.                                                          |
| 500  | INTERNAL_ERROR       | Unexpected error; logged with request id.                                                                 |

**H-4 additions (auth lifecycle).** `EMAIL_TAKEN`, `SLUG_TAKEN` and `CONFLICT` are the
registration refusals: a signup whose email or school address already exists is refused
`409` with the offending field named, and never with the constraint name, SQLSTATE or any
other internal detail. `RESET_INVALID` (unknown, already used, or retired because a sibling
token was consumed or the password was changed) and `RESET_EXPIRED` are the password-reset
refusals. `CSRF_MISSING` / `CSRF_INVALID` (`403`) are also returned by `POST /api/auth/logout`,
which accepts the double-submit token either as `x-csrf-token` or as a `_csrf` form field, so
the app-shell sign-out form keeps working without JavaScript. A failed registration leaves
**no** rows behind (account, school, membership, credential and session commit or roll back
together) and publishes no cookies.

**H-2 additions.** `PERIOD_OVERLAP`, `PERIOD_HAS_UNRESOLVED_PAYMENTS`,
`PERIOD_HAS_UNALLOCATED_PAYMENTS` travel in the normal error envelope
(`{error:{code,message,details}}`), so a caller branches on the reason instead of parsing
prose; the measured counts ride in `details`. A malformed pagination cursor is
`400 BAD_REQUEST`.

## II. Endpoint Groups

### A. Authentication (`/api/auth/*`)

| Method | Path                        | Purpose                                    | Auth                  |
| ------ | --------------------------- | ------------------------------------------ | --------------------- |
| POST   | `/api/auth/login`           | Email/password login; sets session cookie. | public (rate-limited) |
| POST   | `/api/auth/logout`          | Invalidate session.                        | any                   |
| POST   | `/api/auth/refresh`         | Refresh session (internal).                | session               |
| POST   | `/api/auth/forgot-password` | Request reset email.                       | public (rate-limited) |
| POST   | `/api/auth/reset-password`  | Consume reset token & set new password.    | public                |
| GET    | `/api/auth/me`              | Current user + memberships.                | authenticated         |

#### A.1 Authentication lifecycle contract (H-4)

| Concern | Contract |
| ------- | -------- |
| Registration atomicity | `POST /api/auth/register` is one unit of work: user, organization, OWNER membership, credential **and the auto-login session** commit or roll back together. On failure nothing is created, the email/slug stay free, no session cookie is set, and the caller gets an actionable error. |
| Registration conflicts | `409 EMAIL_TAKEN` / `409 SLUG_TAKEN` (column identified from the database's own constraint/key names — never from user-supplied values); any other uniqueness collision is `409 CONFLICT`. Retrying a successful signup is refused with the same codes and creates no second account. |
| Auto-login failure paths | A failure while minting the session rolls the whole registration back; cookies are published only after the transaction commits, so a rolled-back session can never reach the browser. |
| Password reset lifecycle | Consuming a token retires **all** outstanding tokens for that user, revokes every session, and refuses reuse with `RESET_INVALID`; an authenticated password change retires outstanding reset tokens as well. Expired tokens answer `RESET_EXPIRED` and cannot retire a live sibling. |
| Session/logout lifecycle | `POST /api/auth/logout` revokes the presented session and clears the session, CSRF and active-org cookies. CSRF is required when a valid session cookie is presented; a request with no session is a no-op that clears cookies. |
| Rate-limit identity | Client identity for the public auth endpoints is derived by `lib/http/client-ip.ts`: `x-forwarded-for` is **ignored** unless the deployment sets `TRUSTED_PROXY_HOPS=n` (n ≥ 1), in which case the n-th entry from the right is used. Unset/0 ⇒ one shared bucket (`unknown`) and a null client address in audit rows — fail-closed by design, never attacker-chosen. |
| Active organization | The `sc_org` cookie is a signed preference (bound to the user id), never an authority source: membership is re-validated on every request, and an unsigned or tampered value is ignored. |
| Error disclosure | Auth endpoints never echo internal error text, SQLSTATEs, constraint/index names or stack frames. Internal detail is logged server-side only. |

### B. Organization / Onboarding (`/api/orgs*`, `/api/onboarding*`)

| Method    | Path                            | Purpose                                                   |
| --------- | ------------------------------- | --------------------------------------------------------- |
| POST      | `/api/orgs`                     | Create organization (signup flow; caller becomes OWNER).  |
| GET/PATCH | `/api/orgs/:id`                 | View/update organization (OWNER/SCHOOL_ADMIN per matrix). |
| GET       | `/api/onboarding/state`         | Current onboarding progress.                              |
| POST      | `/api/onboarding/complete-step` | Mark step complete (with validation).                     |

### C. Sessions & Terms (`/api/sessions*`, `/api/terms*`)

Standard CRUD + set-current. List responses include counts (students, billed amount).

### D. Classes (`/api/classes*`)

Standard CRUD. Includes `students_count` and rollover helper (copy classes from prior session).

### E. Students (`/api/students*`)

| Method | Path                          | Purpose                                                                       |
| ------ | ----------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/students`               | List/search students; filters: class, status, term, search. Cursor paginated. |
| POST   | `/api/students`               | Create student + guardians.                                                   |
| GET    | `/api/students/:id`           | Detail + guardians + financial summary per term.                              |
| PATCH  | `/api/students/:id`           | Update (audited).                                                             |
| POST   | `/api/students/:id/archive`   | Archive (reason required).                                                    |
| POST   | `/api/students/:id/withdraw`  | Withdraw (reason required; handles outstanding balance policy).               |
| POST   | `/api/students/import`        | CSV import: expects multipart; returns job with dry-run results.              |
| GET    | `/api/students/import/:jobId` | Import job status and per-row errors.                                         |

### F. Fee Catalog (`/api/fees*`, `/api/fee-assignments*`)

CRUD for fee definitions and per-class/per-term assignments.

### G. Billing (`/api/billing*`)

| Method | Path                        | Purpose                                                                                                                                   |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/billing/preview`      | Preview billing run (term, classes) — who will be billed, total amount, exceptions.                                                       |
| POST   | `/api/billing/run`          | Execute billing: creates DRAFT invoices per student for assigned fees. Transactional; idempotent per (term_id, class_id, billing_run_id). |
| POST   | `/api/billing/issue`        | Issue selected DRAFT invoices → ISSUED.                                                                                                   |
| POST   | `/api/billing/void-invoice` | Void an invoice (requires reason; only if no non-reversed allocations or after reversal).                                                 |

### H. Invoices (`/api/invoices*`)

List, detail, PDF/print. Detail response includes lines, allocations, receipts, outstanding, payments.

### I. Payments (`/api/payments*`)

| Method | Path                         | Purpose                                                                                                                                                                                         |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/payments`              | List; filters: method, status, student, date range, unreconciled flag.                                                                                                                          |
| POST   | `/api/payments`              | Record a payment (cash/transfer/POS/manual). Body includes amount (naira string), method, student, paid_at, reference, allocations (optional — if omitted, deterministic auto-allocation runs). |
| GET    | `/api/payments/:id`          | Detail + allocations + receipt.                                                                                                                                                                 |
| POST   | `/api/payments/:id/confirm`  | Confirm a PENDING payment (e.g., after reviewing bank alert).                                                                                                                                   |
| POST   | `/api/payments/:id/reverse`  | Reverse/refund (reason required; amount can be partial).                                                                                                                                        |
| POST   | `/api/payments/:id/allocate` | Manual allocation or reallocation.                                                                                                                                                              |
| POST   | `/api/payments/:id/receipt`  | Issue/reissue receipt (channel: PRINT/EMAIL/WHATSAPP).                                                                                                                                          |
| GET    | `/api/reconciliation/queue`  | Canonical reconciliation queue; replaces the earlier undocumented `/api/payments/unreconciled` concept.                                                                                         |

**POST /api/payments body example (implemented kobo contract):**

```json
{
  "method": "CASH",
  "amountKobo": 10000000,
  "paidAt": "2026-09-15T10:30:00+01:00",
  "reference": null,
  "notes": "Paid in person at bursary",
  "allocations": [{ "invoiceId": "uuid", "amountKobo": 10000000 }]
}
```

### J. Reconciliation control plane (`/api/reconciliation*`)

Reconciliation is an operational control plane over the existing authoritative financial tables. It never stores payment, allocation, invoice, receipt, reversal, or refund totals. `paymentId` is the resource identity; the organization is always derived from the authenticated session.

| Method | Path                                               | Permission               | Purpose                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/reconciliation/queue`                        | `reconciliation.read`    | Cursor-paginated queue of derived unresolved payments and open cases. Filters: `state`, `kind`, `paymentStatus`, `unallocatedOnly`.                                                                                                                            |
| GET    | `/api/reconciliation/payments/:paymentId`          | `reconciliation.read`    | Payment detail plus authoritative allocations, the latest reconciliation case, append-only evidence, explicit candidates, and audit history.                                                                                                                   |
| POST   | `/api/reconciliation/payments/:paymentId/evidence` | `reconciliation.review`  | Append one human-entered evidence item. Requires an Idempotency-Key and reference or note. Evidence cannot be edited or deleted.                                                                                                                               |
| POST   | `/api/reconciliation/payments/:paymentId/confirm`  | `reconciliation.review`  | Require evidence, then use the existing payment state machine for `PENDING → CONFIRMED` (or a safe `DUPLICATE_SUSPECT → CONFIRMED` when an unallocated balance exists). Fully allocated duplicate-suspect payments must use the existing reversal/refund path. |
| POST   | `/api/reconciliation/payments/:paymentId/match`    | `reconciliation.review`  | Require evidence and record one explicit human student/invoice candidate; transitions the case to `RECONCILED`. No matching heuristic or automatic decision is performed.                                                                                      |
| POST   | `/api/reconciliation/payments/:paymentId/allocate` | `reconciliation.review`  | Require an accepted candidate, then call the existing allocation repository/triggers. A fully allocated case becomes closed `ALLOCATED`; no balance is written by reconciliation.                                                                              |
| POST   | `/api/reconciliation/payments/:paymentId/flag`     | `reconciliation.review`  | Transition `UNMATCHED` or `RECONCILED` to `FLAGGED`, or return a flagged case to its previous review state. Reason required.                                                                                                                                   |
| POST   | `/api/reconciliation/payments/:paymentId/resolve`  | `reconciliation.resolve` | Close a reviewed exception as `RECONCILED` with a resolution code and note, explicitly recording that reconciliation performed no financial action.                                                                                                            |

All POST endpoints require the existing session, CSRF, centralized authorization, tenant RLS, audit event, and M10 idempotency protections. The authoritative payment-recording path opens an explicit `UNMATCHED` case for new `PENDING` or unallocated payments; the queue also derives legacy unresolved payments that predate a case. Financial consequences remain on the existing payment/allocate/reverse/refund/receipt paths; bank ingestion, fuzzy matching, confidence scores, and automatic financial decisions are out of scope.

### K. Payment Links (`/api/payment-links*`)

| Method | Path                                    | Permission              | Purpose                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/payment-links`                    | `payment_link.create`   | Create a link for an invoice (or a standalone amount).                                                                                                                                                                                                                             |
| PATCH  | `/api/payment-links/:token`             | `payment_link.revoke`   | Revoke a link.                                                                                                                                                                                                                                                                     |
| GET    | `/api/payment-links`                    | `payment_link.read`     | List the tenant's links.                                                                                                                                                                                                                                                            |
| POST   | `/api/payment-links/:token/rotate`      | `payment_link.rotate`   | **H-5.** (OWNER only.) Retire the link's bearer token and issue a new one. The link, its binding and every payment already attributed keep their provenance; the old URL stops authorizing anything immediately. Returns the new URL only. Audited (`payment_link.rotate`) and recorded as a `link_rotated` signal. |
| GET    | `/api/payment-links/exposure`           | `payment_link.read`     | **H-5.** Tenant-scoped exposure report: which of the tenant's links still has its token in stored rows, how many, and the recommended action (`ROTATE` while ACTIVE). Never returns the token.                                                                                     |
| GET    | `/api/payment-links/signals?since=&limit=` | `payment_link.read`  | **H-5.** Tenant-scoped, append-only, secret-free operational feed (refusals, abuse, rotation, pruning) with severities. The interval is validated and clamped server-side.                                                                                                          |

Public lookup/use is handled by separate public endpoints under `/payment-links/*` (JSON) and `/p/*` (SSR pages, not JSON API). Operator maintenance that must bypass tenant RLS (the exposure/remediation reports, the replay-cache report and prune) is **not** HTTP: it is the owner-only CLI `scripts/public-surface-ops.ts`, documented in `docs/security/H5_OPERATIONAL_HARDENING_CLOSEOUT.md`.

### L. Communication (`/api/comms*`)

| Method | Path                       | Purpose                                                                           |
| ------ | -------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/api/comms/send-reminder` | Send payment reminder to a guardian (channel, template, invoice/payment context). |
| POST   | `/api/comms/send-receipt`  | Send receipt (email/WhatsApp).                                                    |
| GET    | `/api/comms/events`        | List communication events; per-student history.                                   |

### M. Reports (`/api/reports*`)

All reports accept `term_id` (required) plus optional `class_id`, `date_range`. Every response indicates data_as_of timestamp.

| Path                                 | Returns                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `/api/reports/summary`               | Billed/Collected/Outstanding/Overdue/Unreconciled/Collection rate + deltas. |
| `/api/reports/outstanding`           | List of outstanding accounts with aging buckets.                            |
| `/api/reports/aging`                 | Aging buckets (0-30, 31-60, 61-90, 90+) total and per class.                |
| `/api/reports/collection-by-class`   | Per-class collection rate and totals.                                       |
| `/api/reports/fee-line-recovery`     | Per-fee-definition recovery rate.                                           |
| `/api/reports/payment-methods`       | Totals by method over period.                                               |
| `/api/reports/prior-term-exposure`   | Students with prior-term balances.                                          |
| `/api/reports/reconciliation-status` | Unreconciled/duplicate/flagged counts and amounts.                          |
| `/api/reports/export`                | CSV/PDF export of any of the above (streamed).                              |

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

### U. Scoping & Financial Periods (`/api/scoping/*`, `/api/financial-periods*`) — H-2

- `GET /api/scoping/settings` (`org.settings.read`) →
  `{scope: <declaration>, options: [{value,label}], default}` where the declaration is
  `{scope, label, isDefault, setting, termId, termName, cutoverOn, asOf}`.
- `PUT /api/scoping/settings` (`org.settings.update`; OWNER / SCHOOL_ADMIN only) →
  `{scope, changed}`; writing the same value is a no-op and writes no audit event; a
  change writes exactly one `scope.invoice_scope.update` event.
- `GET /api/financial-periods` → `{periods, page (surface "financial-periods"), asOf}`.
- `POST /api/financial-periods` (requires `Idempotency-Key`) →
  `201 {period}`; `409 PERIOD_OVERLAP` when the inclusive-day window touches an existing
  period; `400` when it ends before it starts.
- `GET /api/financial-periods/{id}` → `{period, valuation:{buckets, allTerm, labels}, scope}`.
- `POST /api/financial-periods/{id}/close` (requires `Idempotency-Key`) →
  `201 {period, alreadyClosed:false, valuation}`; `200 {alreadyClosed:true}` on replay
  (the frozen report is returned unchanged); `409` with
  `PERIOD_HAS_UNRESOLVED_PAYMENTS` or `PERIOD_HAS_UNALLOCATED_PAYMENTS` and the counts in
  `details`. A closed period cannot be rewritten (database-enforced), and the runtime role
  has no `DELETE` on either new table.

## III. Pagination, Filtering & Sorting Conventions

- List endpoints accept `?cursor=...&limit=50&sort=field:dir&filter[status]=CONFIRMED`.
- Sort fields are whitelisted per endpoint.
- Date filters: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, Africa/Lagos date interpretation).

**H-2 supersedes the former global "max limit = 100" rule.** Caps are declared **per
surface** and repeated in every response, so no endpoint can truncate silently:

```json
"page": { "surface": "invoices", "limit": 200, "cap": 200, "capSource": "FIXED",
          "returned": 200, "total": 505, "hasMore": true, "nextCursor": "…" }
```

Invariants: `returned ≤ limit ≤ cap`; `hasMore ⇒ nextCursor` is present; a terminal page
has `nextCursor: null`; `total` is `null` only where a surface cannot count cheaply (the
union reconciliation queue, which declares overflow through `hasMore`/`nextCursor`).

| surface | default / cap |
| --- | --- |
| invoices, payments | 100 / 200 |
| students | 200 / 1000 |
| debtors | 200 / 500 |
| payment-links | 100 / 100 |
| collections, `reconciliation-queue`, `audit-events` | 50 / 100 |
| invoice reminders | 20 / 20 |
| student reminders | 15 / 50 |
| financial periods | 50 / 100 |

Cursors are opaque base64url `{v:1, s:<surface>, k:[…]}`. A cursor is bound to its
surface, and its key shape is validated before it reaches SQL: a foreign-surface,
wrong-shaped or non-base64 cursor is `400 BAD_REQUEST`. Timestamp keys are **microsecond**
integers (an ISO millisecond cursor cannot separate rows written in the same millisecond
and would skip them between pages).

## IV. Idempotency

- Header: `Idempotency-Key: <uuid>` is required on M10 reconciliation mutations and on the existing payment-recording path; other frozen legacy mutations retain their route-specific compatibility behavior.
- Repeated requests with the same key return the stored response (status + body) within 24h (API) or 30 days (webhooks).
- If request body differs (hash mismatch), return `409 IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_BODY`.
- Webhook idempotency is additionally keyed by `(provider, event_id)`.

## V. Versioning

- API is unversioned during pilot; breaking changes use a rolling transition with dual-write and deprecation headers (`Deprecation: true`, `Sunset: <date>`).
- Once out of pilot, formal `/api/v1/` prefix will be introduced.

## VI. Open Questions (for founder/architecture decision)

1. Exact pagination: cursor vs offset for report lists? (Recommend cursor for large student/payment lists; offset acceptable for small config lists.)
2. PDF receipt generation client-side vs server-side? (Recommend server for signed records.)
3. Bulk actions: batch endpoint for issuing invoices / sending reminders? (Defer to Phase 2.)
