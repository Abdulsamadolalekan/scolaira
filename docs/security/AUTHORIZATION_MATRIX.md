# AUTHORIZATION_MATRIX — SCOLAIRA M4

Every API endpoint is listed with the role(s) allowed. `—` = denied.  All
endpoints require an authenticated session with an ACTIVE membership in the
selected organization unless explicitly marked PUBLIC.

## Legend

- **OWN** — OWNER of the organization.
- **ADM** — SCHOOL_ADMIN.
- **BUR** — BURSAR (financial).
- **TCH** — TEACHER (academic staff).
- **STU** — STUDENT/GUARDIAN (own data only).
- **PUB** — Public (no session required).
- **PLT** — Platform support session (read-only unless noted; audited).

Additional constraints noted per row:

- **R** = resource must belong to the active org (verified in defense-in-depth
  above RLS; RLS alone enforces this but handlers check explicitly for clear 404
  vs 403 and for audit accuracy).
- **S** = self-only (actor can only operate on their own user/member record).
- **F** = financial state guards apply (invoice/payment/receipt state machines).
- **A** = audited with before/after snapshot.
- **I** = idempotent via Idempotency-Key.
- **!O** = explicitly cannot target an OWNER (e.g. SCHOOL_ADMIN cannot suspend OWNER).

## Auth & session

| Method | Path                        | OWN | ADM | BUR | TCH | STU | PUB | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|:---:|-------|
| POST   | /api/auth/register          | —   | —   | —   | —   | —   | ✓   | Creates user + org + OWNER membership. |
| POST   | /api/auth/login             | —   | —   | —   | —   | —   | ✓   | Issues session cookie. Rate-limited. |
| POST   | /api/auth/logout            | ✓   | ✓   | ✓   | ✓   | ✓   | —   | Invalidates session. |
| GET    | /api/auth/me                | ✓   | ✓   | ✓   | ✓   | ✓   | —   | Returns current principal; client uses for UI state, not authority. |
| POST   | /api/auth/request-password-reset | —| —  | —   | —   | —   | ✓   | Email sent; dev-only echo. Rate-limited. |
| POST   | /api/auth/reset-password    | —   | —   | —   | —   | —   | ✓   | Consumes single-use token. |
| POST   | /api/auth/change-password   | ✓   | ✓   | ✓   | ✓   | ✓   | —   | Requires current password. A |
| POST   | /api/auth/select-organization | ✓ | ✓  | ✓   | ✓   | ✓   | —   | Switches active org; server re-verifies membership. |

## Organization settings

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/org/settings           | ✓   | ✓   | ✓   | ✓   | ✓   | R |
| PATCH  | /api/org/settings           | ✓   | ✓   | —   | —   | —   | R, A |
| POST   | /api/org/transfer-owner     | ✓   | —   | —   | —   | —   | Target must be ACTIVE member in same org; atomic; A |
| DELETE | /api/org                    | ✓   | —   | —   | —   | —   | Requires zero financial balance; archives instead of hard-delete; A |

## Memberships

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/members                | ✓   | ✓   | ✓   | ✓   | —   | Returns roster; STU sees only self (future M5). |
| POST   | /api/members (invite)       | ✓   | ✓   | —   | —   | —   | Creates INVITED membership; role ∈ INVITABLE_ROLES for caller; A, !O (cannot invite a second OWNER) |
| GET    | /api/members/:id            | ✓   | ✓   | ✓   | ✓   | S   | R; STU only self. |
| PATCH  | /api/members/:id (role)     | ✓   | —*  | —   | —   | —   | R, A; *ADM can change roles of non-OWNER staff only, cannot promote to OWNER, !O. |
| POST   | /api/members/:id/suspend    | ✓   | ✓   | —   | —   | —   | R, A, !O (ADM cannot suspend OWNER). |
| POST   | /api/members/:id/reactivate | ✓  | ✓   | —   | —   | —   | R, A, !O. |
| DELETE | /api/members/:id (remove)   | ✓   | ✓   | —   | —   | —   | R, A, !O; cannot remove self if OWNER (must transfer first). |
| POST   | /api/members/accept-invite  | ✓   | ✓   | ✓   | ✓   | ✓   | Invited user claims their membership; token-bound; A. |

## Students / Guardians

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/students               | ✓   | ✓   | ✓   | ✓*  | S   | R; *TCH only students in own classes (M5 refinement — currently sees all; tracked). |
| POST   | /api/students               | ✓   | ✓   | —   | —   | —   | R, A |
| GET    | /api/students/:id           | ✓   | ✓   | ✓   | ✓*  | S   | R, S |
| PATCH  | /api/students/:id           | ✓   | ✓   | —   | —   | —   | R, A |
| DELETE | /api/students/:id           | ✓   | ✓   | —   | —   | —   | Soft archive; A (no hard delete of financial-linked students). |

## Controlled term billing (M8)

| Method | Path                                      | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-------------------------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/fee-definitions                      | ✓   | ✓   | ✓   | —   | —   | R; configuration read is gated by fee_definition.manage. |
| POST   | /api/fee-definitions                      | ✓   | ✓   | ✓   | —   | —   | R, A; authoritative default amount in kobo. |
| PATCH  | /api/fee-definitions/:id                  | ✓   | ✓   | ✓   | —   | —   | R, A; archive is soft and history-preserving. |
| GET    | /api/terms/:id/fee-assignments            | ✓   | ✓   | ✓   | —   | —   | R; term fee matrix. |
| PUT    | /api/terms/:id/fee-assignments            | ✓   | ✓   | ✓   | —   | —   | R, A; replaces only an unbilled term matrix. |
| GET    | /api/terms/:id/bill-preview               | ✓   | ✓   | ✓   | —   | —   | R; read-only review surface, server-computed. |
| POST   | /api/terms/:id/bill                       | ✓   | —   | ✓   | —   | —   | R, F, A, I; CSRF; term lock + invoice-line uniqueness + ordinary invoice state machine. |

`term.bill` is deliberately OWNER/FINANCE_OFFICER-only. SCHOOL_ADMIN can configure and review the fee structure but cannot create obligations at term scale. No UI permission is a security boundary: every route re-checks the existing matrix, tenant context, RLS, and financial state rules.

## Invoices

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/invoices               | ✓   | ✓   | ✓   | —   | S   | R; STU only own. |
| GET    | /api/invoices/:id           | ✓   | ✓   | ✓   | —   | S   | R, S |
| POST   | /api/invoices (issue)       | ✓   | ✓   | ✓   | —   | —   | R, F, A, I |
| POST   | /api/invoices/:id/void      | ✓   | —   | ✓   | —   | —   | R, F, A (cannot void if settled) |
| GET    | /api/invoices/:id/preview   | ✓   | ✓   | ✓   | —   | S   | R; public PDF not in M4. |

## Payments & receipts

| Method | Path                        | OWN | ADM | BUR | TCH | STU | PUB | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|:---:|-------|
| POST   | /api/payments (record)      | ✓   | —   | ✓   | —   | —   | —   | R, F, A, I (manual/external payment) |
| POST   | /api/payments/:id/reverse   | ✓   | —   | ✓   | —   | —   | —   | R, F, A |
| POST   | /api/receipts (issue)       | ✓   | —   | ✓   | —   | —   | —   | R, F, A, I |
| POST   | /api/receipts/:id/void      | ✓   | —   | ✓   | —   | —   | —   | R, F, A |
| GET    | /api/payments/:id           | ✓   | ✓   | ✓   | —   | S   | —   | R, S |
| GET    | /api/receipts/:id           | ✓   | ✓   | ✓   | —   | S   | —   | R, S |

## Payment links & public pay

| Method | Path                        | OWN | ADM | BUR | TCH | STU | PUB | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|:---:|-------|
| POST   | /api/payment-links          | ✓   | —   | ✓   | —   | —   | —   | R, A; 32-byte CSPRNG token; expiry. |
| GET    | /api/payment-links          | ✓   | —   | ✓   | —   | —   | —   | R |
| DELETE | /api/payment-links/:id      | ✓   | —   | ✓   | —   | —   | —   | Revoke; R, A |
| GET    | /p/:token                   | —   | —   | —   | —   | —   | ✓   | Public; token only; minimal PII; rate-limited. |
| POST   | /p/:token                   | —   | —   | —   | —   | —   | ✓   | Initiates Paystack checkout (webhook confirms); idempotent. |

## Webhooks

| Method | Path                        | AUTH             | Notes |
|--------|-----------------------------|------------------|-------|
| POST   | /api/webhooks/paystack      | HMAC signature verification (not session) | Verifies Paystack signature; replay-protected by event id; records webhook_events; idempotent by event reference. |

## Reports / aggregates / search

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/reports/summary        | ✓   | ✓   | ✓   | —   | —   | R; scoped by GUC → aggregates cannot leak across tenants. |
| GET    | /api/reports/income         | ✓   | —   | ✓   | —   | —   | R; date-bounded; financial audit. |
| GET    | /api/reports/outstanding    | ✓   | ✓   | ✓   | —   | —   | R |
| GET    | /api/search?q=…             | ✓   | ✓   | ✓   | ✓*  | S   | R; TCH scoped to own classes; STU self-only. |
| GET    | /api/exports/:kind          | ✓   | ✓†  | ✓   | —   | —   | R; †ADM can export non-financial (students); A (downloads logged). |

## Audit log

| Method | Path                        | OWN | ADM | BUR | TCH | STU | Notes |
|--------|-----------------------------|:---:|:---:|:---:|:---:|:---:|-------|
| GET    | /api/audit                  | ✓   | —   | —   | —   | —   | R; OWNER-only within their org. Platform can read across orgs only in support mode with reason. |
| GET    | /api/audit/:id              | ✓   | —   | —   | —   | —   | R |

## Platform (support mode) — scaffolded, gated OFF by default

| Method | Path                        | PLT | Notes |
|--------|-----------------------------|:---:|-------|
| POST   | /api/platform/support-mode  | ✓   | Requires second factor (future); enters platform mode; audited with reason; read-only by default. |
| POST   | /api/platform/exit          | ✓   | Exit back to ordinary session. |
| GET    | /api/platform/orgs          | ✓   | Cross-tenant listing for support; A; read-only. |
| POST   | /api/platform/impersonate   | future | Explicit, ticket-scoped, M5+; NOT available in M4. |

## What is deliberately absent

- No `DELETE /api/invoices/:id` — void instead (financial history preserved, per M2).
- No `DELETE /api/payments/:id` — reverse instead.
- No `DELETE /api/receipts/:id` — void instead.
- No `PATCH /api/auth/me/role` — roles are set by membership admin, not self.
- No bulk "export everything" endpoint for non-OWNER.
- No direct SQL-access endpoints; all DB access through repos and RLS.
- No endpoint that accepts `isAdmin`, `isPlatformAdmin`, `role`, or `organizationId` from the client as authoritative.
