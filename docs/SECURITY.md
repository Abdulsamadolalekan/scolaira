# SCOLAIRA — Security Model

> A financial SaaS for children's data and school money. Trust is the product.

---

## I. Threat Model (Top Risks)

| # | Threat | Impact | Mitigation summary |
|---|---|---|---|
| T1 | Cross-tenant data access (IDOR / broken ACL) | Catastrophic — financial leak, regulatory breach | App-layer org scoping + Postgres RLS + foreign-key org columns + cross-tenant test matrix |
| T2 | Financial record tampering | Catastrophic — trust destruction | Server-side authorization, append-only audit, no destructive deletes, state-machine enforcement, DB triggers |
| T3 | Authentication / session theft | High — account takeover | Secure cookies, CSRF, session expiry, password hashing (argon2id via Supabase), rate limiting, future 2FA |
| T4 | Webhook forgery / replay from Paystack | High — false payments, fake balances | HMAC signature verification, idempotency key table, timestamp replay window, out-of-order handling |
| T5 | Malicious CSV import (injection, formula, bad data) | High — data corruption, XSS in export, financial drift | Strict server-side validation, CSV formula escaping on export, dry-run preview, size limits, type checks |
| T6 | Privilege escalation (staff → finance officer → owner) | High — unauthorized money actions | RBAC with explicit per-action permission matrix, server-side enforcement, no UI-hiding as security |
| T7 | SQL injection | High — data exfiltration, corruption | Parameterized queries via Drizzle; no raw SQL without identifiers reviewed; DB least-privilege role |
| T8 | XSS (e.g., via imported names, communication messages) | Medium-high — session theft, phishing | React auto-escape + CSP headers + sanitization of any user-originated HTML (we disallow HTML in free text; WhatsApp/SMS is plaintext) |
| T9 | CSRF | Medium — state-changing actions from another origin | SameSite=Lax cookies + anti-CSRF token on mutating requests + origin/referer checks |
| T10 | Sensitive data in logs/errors | Medium — PII/secret leak | Structured logging with allowlist fields; no auth tokens, no full payment references in logs; error messages sanitized |
| T11 | Insecure direct object reference on parent payment links | Medium — unauthorized invoice viewing | Signed, single-use, expiring tokens; minimal data exposed; links tied to a specific obligation; brute-force resistant (256-bit random) |
| T12 | Rate abuse / brute force on login/payment links | Medium — credential stuffing, enumeration | Per-IP + per-account rate limits; exponential backoff; failed-login auditing |
| T13 | Insecure file uploads / exports | Medium | Supabase Storage with signed URLs; server-side MIME validation; no executable content; CSV exports BOM-prefix to prevent formula execution in Excel |
| T14 | Platform admin (SCOLAIRA internal) overreach | Medium-high | Separate /admin surface, separate role, all mutations audited, purpose-specific privileges, no broad "superuser" in school context |
| T15 | NDPR / privacy breach (student/guardian PII) | Regulatory + reputational | Data minimization, encryption in transit (TLS) and at rest (Supabase-managed), access logs, retention policy, no unnecessary PII collection |

## II. Authentication

- **Provider:** Supabase Auth (JWT-based, HTTP-only secure cookies via Next.js integration).
- **Methods at launch:** Email + password.
- **Password policy:**
  - Minimum 12 characters.
  - Must not be in common-password list (check via library like `zxcvbn` for warning-only at signup; do not over-block Nigerian users).
  - Argon2id hashing (Supabase default).
- **Sessions:**
  - Default: 12-hour sliding session (refresh extends activity up to rolling 30-day window, or "remember me" opt-in per D13).
  - Secure, HTTP-only, SameSite=Lax cookies; `__Host-` prefix on production.
  - Session invalidation on password change / logout; "log out of all devices" capability.
- **Password reset:** Single-use, time-limited (1 hour) token; single-consumption; email-only; audit event on reset.
- **Rate limiting:**
  - Login: 5 attempts per account per 10 minutes; exponential backoff; progressive delays.
  - Password reset: 3 per account per hour.
  - Rate-limit failures are audited and reported to the owner for suspicious patterns.
- **2FA:** Roadmap (TOTP) for OWNER role post-pilot.
- **Login auditing:** Failed and successful logins recorded with IP, user-agent, user_id.

## III. Authorization (Role-Based Access Control)

### III.1 Roles

| Role | Scope |
|---|---|
| `OWNER` | Full control over their organization; cannot delete audit log; can transfer ownership via audited flow. |
| `SCHOOL_ADMIN` | Operational management: students, classes, billing setup, staff management (except OWNER role assignment), reports. Cannot: change owner, delete organization, view/edit platform settings. |
| `FINANCE_OFFICER` | Record/edit payments (within constraints), reconciliation, receipts, billing operations, invoices, reports. Cannot: delete financial history, manage owners/admins, adjust subscription. |
| `STAFF` | Only explicitly granted capabilities (e.g., view class roster, view own students' balances for follow-up). Never access to cross-class data by default. |
| `PLATFORM_ADMIN` | SCOLAIRA internal staff for support/operations. Cannot log into a school as a user without audited "impersonate" flow; purpose-specific granular permissions. Never has silent access to school financial data. |

### III.2 Permission Matrix (Phase 1)

Legend: ✅ = allowed, ❌ = denied, 🟡 = owner-configurable

| Action | OWNER | SCHOOL_ADMIN | FINANCE_OFFICER | STAFF | PLATFORM_ADMIN |
|---|---|---|---|---|---|
| Organization settings (name, logo, etc.) | ✅ | 🟡 | ❌ | ❌ | ❌ |
| Transfer ownership | ✅ (with confirmation) | ❌ | ❌ | ❌ | ❌ |
| Manage staff & roles | ✅ | ✅ (except OWNER) | ❌ | ❌ | ❌ |
| View command center | ✅ | ✅ | ✅ | 🟡 (limited) | ✅ (audited) |
| Create / edit fee catalog | ✅ | ✅ | 🟡 | ❌ | ❌ |
| Create / edit terms & sessions | ✅ | ✅ | 🟡 | ❌ | ❌ |
| Issue / void invoices | ✅ | ✅ | ✅ | ❌ | ❌ |
| Record cash/transfer/POS payments | ✅ | ✅ | ✅ | ❌ | ❌ |
| Confirm / reconcile pending payments | ✅ | ✅ | ✅ | ❌ | ❌ |
| Reverse / refund payments (with reason) | ✅ | 🟡 | 🟡 | ❌ | ❌ |
| Allocate / reallocate payments | ✅ | ✅ | ✅ | ❌ | ❌ |
| Issue receipts | ✅ | ✅ | ✅ | ❌ | ❌ |
| Send payment reminders / comms | ✅ | ✅ | ✅ | 🟡 | ❌ |
| View reports (all) | ✅ | ✅ | ✅ | 🟡 | ✅ (audited) |
| Export student / financial data | ✅ | 🟡 | 🟡 | ❌ | 🟡 (audited, support only) |
| Import students (CSV) | ✅ | ✅ | 🟡 | ❌ | ❌ |
| View audit history | ✅ | 🟡 | ❌ | ❌ | ✅ (audited) |
| Access /admin platform | ❌ | ❌ | ❌ | ❌ | ✅ |
| Impersonate school user | ❌ | ❌ | ❌ | ❌ | 🟡 (audited, only support) |

### III.3 Enforcement

- Permission checks occur **in the service layer** on every request, not only in UI.
- Each route handler obtains an `AuthContext` (user, organization, role) and passes it explicitly; there is no implicit trust from session alone.
- Postgres RLS policies mirror the permission matrix as defense-in-depth.
- UI hides/disable actions based on role but server is authority.
- Cross-organization access attempts are audited as security events.

## IV. Tenant Isolation (Defense-in-Depth)

1. **Application layer:** Every query is scoped with `organization_id` from the authenticated membership; convenience helpers (`db.forOrg(orgId)`) make unscoped queries impossible by default; lint rule flags raw queries without org scoping.
2. **Database layer:** Row Level Security enabled on every tenant table; default-deny policy; policies per role.
3. **Foreign keys:** Every tenant table has a non-null `organization_id` with FK to `organizations(id)`; composite FKs include `organization_id` where joining prevents cross-org references.
4. **Unique constraints:** Include `organization_id` to prevent cross-org dedup collisions.
5. **Tests:** Automated cross-tenant test matrix runs in CI; attempts to access another org's invoices/payments/students must return 404/403 and produce zero rows.
6. **Parent payment links:** Tokens are 256-bit random values; do not expose org/student identifiers directly in URL slugs; signed payload includes obligation id and expiry.

## V. Webhook Security (Paystack + future providers)

1. **Signature verification:** All incoming webhooks verified using provider's HMAC secret; never accept unverified events.
2. **Raw body capture:** Signature is computed against raw unparsed body; any body parsing must happen after verification.
3. **Idempotency:** Unique key `(provider, event_id)` in database; duplicates return 200 and are no-ops.
4. **Timestamp replay window:** Events older than 5 minutes (configurable) are rejected unless signature + manual review; events in the far future are rejected.
5. **Out-of-order delivery:** State-machine transitions are explicit; late events for a non-current state route to a review queue, not silent application.
6. **Webhook endpoint rate limiting:** Per-provider-IP allowlist if provider publishes ranges; otherwise aggressive rate limit.
7. **Secrets:** Webhook secrets stored in env vars; never logged; rotated through documented procedure.
8. **Testing:** Forged, replayed, duplicate, and out-of-order webhooks are part of the security test matrix.

## VI. Input Validation & Injection Prevention

- **Zod schemas** for every API endpoint; reject unknown keys.
- All DB access via Drizzle ORM parameterized queries; raw SQL must be reviewed and parameterized.
- **CSV import:** server-side schema validation (required columns, types, ranges, uniqueness); formula-bearing cells are neutralized in exports (prefix `'=` in CSV output cells starting with `=+-@`); import preview shows errors per row before commit.
- **Free text fields** (names, notes, addresses) are plaintext; no HTML rendering; React auto-escapes; CSP disallows inline scripts.
- **File uploads:** Signed Supabase Storage URLs; size limits; type allowlist (CSV, images for receipts); server MIME sniffing.

## VII. CSRF / Session Protection

- Cookies set `SameSite=Lax`, `Secure` in production, `HttpOnly`, `Path=/`.
- Mutating requests (POST/PUT/PATCH/DELETE) require an anti-CSRF token (double-submit or same-origin token pattern) for cookie-based sessions; Supabase SSR helpers include this.
- `Origin` and `Referer` validated on state-changing endpoints.
- Strict CORS: API allowed origins limited to known app domains; public payment endpoints have their own limited CORS.

## VIII. Rate Limiting & Abuse Prevention

- Login: 5/10min per account; 20/10min per IP.
- Password reset: 3/hour per account.
- Payment link lookup: 10/min per IP; 100/hour per IP.
- API (authenticated): 120/min per user.
- Communication sends (SMS/WhatsApp/email): per-organization daily cap; per-parent frequency cap.
- Rate-limit violations return `429` with Retry-After header; repeated abuse triggers IP/account lockouts audited to owner.

## IX. Data Privacy (NDPR-aligned)

- **Data minimization:** Only collect data required for fee operations. For parents/guardians: name, phone (required for communication), email (optional), relationship to student. No BVN, no bank account details except as needed for reconciliation notes (free text, not structured).
- **Encryption:** TLS in transit; volume encryption at rest via Supabase.
- **Access logs:** Every access to sensitive student/financial data is audited.
- **Exports:** Data export restricted to authorized roles; exports are logged; CSV exports sanitized against formula injection.
- **Retention:** Active data retained while school is customer; after churn, data retained per NDPR requirements (minimum 2 years financial records), then deleted via documented process.
- **Parent communication:** Opt-out honored at the communication channel level; auditable consent where required.
- **Children's data:** SCOLAIRA processes student data as a processor on behalf of the school (controller); school is responsible for consent; SCOLAIRA provides the school with tools to respond to parent data requests.

## X. Secrets & Configuration

- All secrets (DB, Supabase service role, Paystack keys, webhook secrets, email API keys) in environment variables.
- `.env.local` / `.env.production` never committed; `.env.example` committed with placeholders.
- No secrets in logs, error messages, client-side bundles.
- Service-role keys used only in server-only code; never exposed to browser.
- Rotation procedure documented for each secret class.

## XI. Security Headers

Set on all responses:

- `Content-Security-Policy` (strict: self, required asset hosts; no inline script; no unsafe-eval)
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (payment pages: SAMEORIGIN if embedded, but we will NOT embed payment pages — top-level only)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()` — payment() may be relaxed if Paystack inline requires it

## XII. Logging & Monitoring

See `/docs/OPERATIONS.md`. Specific to security:
- All auth events (login success/failure, password reset, session invalidation) logged.
- All permission denials logged.
- All financial mutations audit-logged.
- Sentry alerts on: auth anomalies, invariant violations, 5xx spikes, repeated 401/403 patterns.

## XIII. Incident Response (Summary)

Documented runbooks for:
1. Suspected account takeover → force-logout, password reset, audit review, notify proprietor.
2. Suspected data leak → revoke leaked credentials, audit scope, notify affected schools per NDPR timeline.
3. Webhook flood / payment fraud → disable affected provider endpoint in maintenance mode, audit state, reconcile manually.
4. Data corruption from bug → stop writes, restore from PITR, replay audited events, communicate transparently.

Full runbooks live in `/docs/OPERATIONS.md` (to be expanded post-approval).

## XIV. Security Test Matrix (Pre-Pilot Gate)

See `/docs/TESTING.md`. The following are mandatory and must be automated or manually tested with recorded evidence:

- Cross-tenant access (invoices, payments, students, reports)
- Privilege escalation (each role attempting higher actions)
- Unauthorized financial actions (edit payment without permission; reverse without reason)
- CSRF (attempted forged requests from third-party origin)
- IDOR (changing IDs in URLs/requests to access other records)
- Session misuse (using expired/other-user session)
- Webhook forgery (invalid signature; wrong secret; replayed; timestamp outside window; duplicate; out-of-order)
- Malicious CSV import (formulas, XSS strings, SQL-looking strings, duplicate identifiers, impossible values, oversized)
- XSS (via student names, notes, comms messages in UI and exports)
- SQL injection (on every search/filter/input)
- Secret exposure (grep of built bundles; /api endpoints exposing env)
- Rate abuse (hit limits; confirm lockouts)
- Unauthorized exports (staff attempting exports; unauthenticated export endpoints)

## XV. Platform Admin Security

- `/admin` is a separate surface (different route segment) with its own authentication check for `platform_admin` role on Supabase.
- Platform admins **never** have automatic access to school data; access requires an audited "support session" tied to a support ticket, with time-bounded expiry (e.g., 1 hour), with the school owner notified (in-app + email) of the access.
- Platform-admin actions (e.g., subscription changes, impersonation, data export) are written to a separate platform audit log that even platform admins cannot delete.
- Separate secrets, separate session cookie (or strict path separation) to prevent lateral movement.

---

*Security is continuous, not a checkbox. This document evolves as the system grows; changes are recorded in /docs/DECISIONS.md.*
