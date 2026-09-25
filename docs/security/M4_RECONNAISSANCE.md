# M4 Reconnaissance — Application Security Surface Inventory

**Date:** 2026-09-16
**Author:** Lead Engineer (SCOLAIRA)
**Purpose:** Complete inventory of the authority/security surface before any M4 code is written, per Founder's Mandate §04: *"Your first job is not coding. Understand the system."*

---

## 1. Current State of the System (honest)

SCOLAIRA at the end of M3 is an authentication shell on top of a complete M2 financial schema. There are **zero application routes for the actual product** — no invoice creation, no student CRUD, no payments, no reports, no settings. This is a feature: M4 builds the authorization layer *first*, then each business endpoint is added behind it, rather than retrofitting auth onto a pile of routes.

**What exists today:**

| Surface | Count | Status |
|---|---|---|
| App Router `route.ts` (API) | 8 | 7 auth + 1 health — all M3 |
| App Router `page.tsx` | 9 | 4 auth pages, 1 dashboard placeholder, 4 `/preview` static mock templates (no DB) |
| `middleware.ts` | 1 | Edge — coarse cookie-presence check; **not** the security boundary |
| Server actions | 0 | None yet |
| Drizzle repositories (tenant) | 19 | Written in M2; take a typed `TenantCtx` |
| Auth queries | inlined in `lib/auth/index.ts` | Use `getDb()/getSql()` directly during bootstrap |
| Tenant tables | 20+ | organizations, users, organization_members, students, guardians, student_guardians, academic_sessions, terms, classes, class_enrollments, fee_definitions, fee_assignments, invoices, invoice_lines, payments, payment_allocations, receipts, reversals, payment_links, communications, doc_number_sequences |
| Auth/platform tables | 8 | password_credentials, sessions, password_resets, rate_limits, login_attempts, audit_events, idempotency_keys, webhook_events |
| Migrations | 5 | 0000_init, 0001_integrity, 0002_financial_fixes, 0003_auth, 0004_cron_cleanup |
| RLS policies | ~21 tenant tables × (USING+WITH CHECK) + auth/session/user/org policies | **All tenant policies are a single `organization_id = GUC` predicate** — no role/permission logic |
| Auth helpers | `getSession()`, `withAuth()`, `requireCsrf()`, `setSystemContext()`, `setTenantFor()`, `clearContext()` | M3 |
| `withTenant()` wrapper | 1 | Calls M2 SECURITY DEFINER `set_tenant_context(org,user)` which verifies membership; runs callback; clears GUCs in `finally`. |
| `withSystemContext()` | 1 | Migration/seed/test only — NOT executable by the runtime DB role. |

---

## 2. Where Authority Currently Comes From

| Decision point | Current source | Trust level |
|---|---|---|
| "Who is this?" | `getSession()` → HMAC verify → DB lookup by `token_hash` → expiry/revocation check | ✅ M3-solid |
| "What org are they in?" | M3 picks **first ACTIVE `organization_members` row** (`ORDER BY created_at LIMIT 1`) | ⚠️ Works for single-org users; wrong for multi-org |
| "What is their role?" | `organization_members.role` column, read and returned to caller but **never checked anywhere** | ❌ Role is read but unused for access decisions |
| "What rows can they see?" | **Database RLS only** — `organization_id = current_setting('app.organization_id')`. No role filtering in DB. | ⚠️ Correct tenant isolation, **no authorization** |
| "Can they mutate financial state?" | M2 triggers (state machines, double-entry invariant, payment ref duplication) + RLS org-match + `bypass_financial_triggers='0'` | ✅ Enforces invariants ❌ Does not enforce **who** |
| "Platform admin?" | `users.is_platform_admin` boolean column, **copied into the tenant-session GUC** by `set_tenant_context()` | 🔴 Architectural defect — see §4.1 |
| CSRF | Double-submit cookie + header via `requireCsrf()` | ⚠️ Mechanism exists; **only change-password calls it today**; not yet centralized |

---

## 3. Inventory of What Must Be Protected

### 3.1 Resources (database-backed)

| Resource | Repo module | Tenant-scoped? | Sensitive? |
|---|---|---|---|
| organization_members | `organization-members.ts` | ✅ (self-referential) | 🔴 Security events on change |
| organizations (settings) | `organizations.ts` | ✅ | Settings changes are privileged |
| users | `users.ts` | ⚠️ RLS allows self-or-platform-admin | PII |
| academic_sessions | `academic-sessions.ts` | ✅ | Config |
| terms | `terms.ts` | ✅ | Drives billing windows |
| classes | `classes.ts` | ✅ | CRUD |
| students | `students.ts` | ✅ | PII; archive vs delete |
| guardians | schema only | ✅ | PII |
| student_guardians | schema only | ✅ | Relational |
| class_enrollments | schema only | ✅ | Academic |
| fee_definitions | `fee-definitions.ts` | ✅ | 🔴 Financial config |
| fee_assignments | `fee-assignments.ts` | ✅ | 🔴 Financial config |
| invoices | `invoices.ts` | ✅ | 🔴 Financial state |
| invoice_lines | `invoice-lines.ts` | ✅ | 🔴 Financial |
| payments | `payments.ts` | ✅ | 🔴 Financial state |
| payment_allocations | `payment-allocations.ts` | ✅ | 🔴 Financial |
| receipts | `receipts.ts` | ✅ | 🔴 Financial |
| reversals | `reversals.ts` | ✅ | 🔴 Financial corrective |
| payment_links | `payment-links.ts` | ⚠️ Has `findByTokenPublic()` for unauth lookup | 🔴 Public attack surface |
| communications | schema only | ✅ | PII (guardian contact) |
| audit_events | `audit-events.ts` | ✅ | Sensitive read (contains actor+action+resource) |
| idempotency_keys | `idempotency-keys.ts` | ✅ | Internal |
| webhook_events | `webhook-events.ts` | ✅ | Internal (Paystack callbacks — must be signature-verified) |
| doc_number_sequences | 0001 migration | ✅ | Internal |
| sessions/password_credentials/password_resets/rate_limits/login_attempts | inline in `lib/auth/index.ts` | Auth tables (user-scoped RLS) | 🔴 Security-critical |

### 3.2 Actions Requiring Authorization Decisions (per Mandate §08)

None of these routes exist yet. Every one must pass through the central authorizer:

- **Students:** create, view, update, archive, restore
- **Fees:** create definition, assign, activate, archive
- **Invoices:** create, view, issue, void
- **Payments:** record, confirm, allocate, reverse, refund
- **Receipts:** issue, view, void
- **Payment links:** create, view, revoke (+ public: view-by-token, submit-payment)
- **Staff/Memberships:** invite, view, suspend, change role, revoke
- **Organization:** view settings, modify settings
- **Reporting:** view financial reports, export financial data
- **Sessions/Terms/Classes:** CRUD, activate/close
- **Guardians:** create, view, update, link to student
- **Audit:** view audit log (restricted)

### 3.3 Current Endpoints Relative to the Authorization Boundary

1. **`app/preview/***` (4 pages)** — `'use client'`, hardcoded mock data, no DB calls. Publicly reachable. Not a data risk today, but **must be removed or access-controlled before production** since they expose future UI patterns to unauthenticated visitors.
2. **`GET /api/health`** — public, no DB, returns `{status:'ok'}`. Correct.
3. **`GET /`** → redirects to `/dashboard`; middleware bounces unauth to `/login`. Correct.
4. **Dashboard page** calls `getSession()` directly and `clearContext()` manually; doesn't set tenant because it doesn't query tenant data. When dashboard starts loading tenant data, it must move to `withAuthorizedRoute`.
5. **M3 auth routes** (login/register/reset/me/logout/change-password) deliberately operate in system/auth-context paths; expected and bounded.
6. **All future business routes** — M4 will add them; none exist yet.

---

## 4. Findings — Gaps, Assumptions, Escalation Paths

### 4.1 🔴 ARCHITECTURAL DEFECT: `set_tenant_context()` conflates platform authority with tenant membership

File: `lib/db/migrations/0001_integrity.sql`, function `set_tenant_context(...)`:

```sql
SELECT "is_platform_admin" INTO v_admin FROM "users" WHERE "id" = p_user_id;
PERFORM set_config('app.is_platform_admin', CASE WHEN v_admin THEN '1' ELSE '0' END, false);
```

The same GUC (`app.is_platform_admin`) is used for two different concepts that Mandate §10 explicitly separates:
- **Platform authority** (operating SCOLAIRA cross-tenant)
- **Tenant membership** (operating inside a school)

Because `set_tenant_context(org, user)` copies the flag into the session GUC when a platform admin visits a school, and because RLS policies OR with `is_platform_admin='1'` (e.g. `users_self_or_admin`), a platform admin acting inside one school holds platform-level read on tables whose RLS ORs with the flag — notably `users`, which returns **every user in the entire system** regardless of tenant when the flag is set. Tenant tables whose policies only check `organization_id = GUC` stay scoped, which is good, but:
- The semantic overloading is a footgun for any future RLS policy that reasonably ORs with is_platform_admin for "platform backdoor" access.
- It blurs the audit log: was that action a platform-admin support action or a privileged tenant action?

**Mandate §10:** *"Do not create a generic `isPlatformAdmin → bypass everything` mechanism."* The flag is already being propagated into tenant scope. Fixing this is a prerequisite for M4.

**Proposed M4 fix (migration 0005):**
- Keep `app.organization_id`, `app.user_id`, `app.bypass_financial_triggers`.
- Redefine `app.is_platform_admin` to mean **exclusively** "this session is in the platform-admin cross-tenant context." It is '1' ONLY when entered via a dedicated `enter_platform_context(platformUser)` SECURITY DEFINER function, not during normal tenant entry.
- Add a separate `app.acting_role` GUC (text) — set to the resolved membership role (e.g. 'SCHOOL_ADMIN') during tenant scope. Application-layer authorization reads this; RLS financial defense-in-depth policies in later migrations can use it too.
- Modify `set_tenant_context(org,user)` to always set `app.is_platform_admin='0'` and instead set `app.acting_role` to the resolved role.
- Remove the PLATFORM_ADMIN value from membership_role enum (see §4.2).

This is presented as an architectural finding now, not a silent patch. It requires a migration that touches existing RLS and must be done carefully with tests.

### 4.2 ⚠️ `PLATFORM_ADMIN` in the membership_role enum

File: `lib/db/schema/enums.ts`:

```ts
membershipRoleEnum = pgEnum('membership_role', ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER','STAFF','PLATFORM_ADMIN']);
```

A platform administrator is not a member of a school. Having PLATFORM_ADMIN as a membership role:
- Implies platform admins occupy an `organization_members` row (they don't; they operate cross-tenant).
- Creates an insertion path where a bug that writes a membership with role=PLATFORM_ADMIN grants ambiguous combined privileges.
- Muddles role semantics.

**Fix (M4 migration):** Remove PLATFORM_ADMIN from membership_role. Use `users.is_platform_admin` boolean (or, better, a new `platform_admin_users` join table for M4's explicit platform-capability grants, see §6) as the sole indicator. Platform admins with no memberships get an empty list routed to a platform console.

### 4.3 ⚠️ RLS is tenant-isolating but not authority-limiting

Every tenant RLS policy uses the same predicate:
```sql
"organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
```
This is correct for M2/M3 tenant isolation, but means: any member of an organization (including STAFF) could SELECT/INSERT/UPDATE/DELETE any row in that org at the DB level if they reach a query path.

**Conclusion:** Authorization must be enforced at the application layer in a **centralized, unavoidable authorizer** that gates every repository call. Defense-in-depth RLS on financial tables (role-aware policies on invoices/payments/receipts) should be added but is secondary — the application layer is the primary gate.

**Mandate alignment:** §07 says "The database RLS from M2 remains an independent defensive layer. Do not weaken it." We will not weaken it; we will strengthen it in carefully-reviewed migrations.

### 4.4 ⚠️ Multi-org active selection does not exist

M3 picks first ACTIVE membership (`ORDER BY created_at LIMIT 1`). Multi-org users (a bursar working two schools, a platform admin supporting tenants) will always land in their earliest membership.

**M4 needs:** a signed, server-verified active-org cookie; on every request, verify user is ACTIVE in the selected org; graceful switcher UI.

### 4.5 ⚠️ CSRF not yet wired into a single wrapper

`requireCsrf()` exists and works, but only `/api/auth/change-password` calls it. Every state-changing protected endpoint must enforce it, and it must be impossible to forget.

### 4.6 ⚠️ Payment-link public lookup is an intentional back door

`findByTokenPublic()` SELECTs by token without tenant context — necessary for payers, but it's exactly the sort of "convenient public path" that becomes an isolation breach when extended. M4 must:
- Build a dedicated public payment-link route; allow-list exactly the returned fields (amount, school display name, payee display name, expiry, status) — no guardian PII, no other invoices, no financial history.
- Use 32-byte CSPRNG tokens (not nanoid/shortids).
- Enumeration resistance (constant-time responses, IP rate limits).
- All public mutations must be Paystack-signed webhooks, not payer-triggered writes.

### 4.7 ⚠️ Registration creates SCHOOL_ADMIN not OWNER

The role enum has OWNER and SCHOOL_ADMIN as separate roles; the M3 register flow creates the founding user with role `SCHOOL_ADMIN`. This may be intentional but must be resolved deliberately in M4's role policy. An OWNER role implies irrevocable ownership (e.g., cannot be suspended by another SCHOOL_ADMIN); this is a policy decision, not an engineering guess. I will propose a resolution in §6 pending your approval.

### 4.8 ⚠️ Webhook endpoint does not exist yet

`webhook_events` table exists; Paystack webhook signature verification and idempotency do not. M4 will implement the public webhook endpoint with signature verification BEFORE any Paystack integration (M4 defers actual Paystack enablement per Mandate §26 — payment processing is later; we only build the authorization gate for it now).

### 4.9 ⚠️ `users` table RLS cross-user visibility

`users_self_or_admin` policy:
```sql
"id" = NULLIF(current_setting('app.user_id', true), '')::uuid
OR current_setting('app.is_platform_admin', true) = '1'
```
Once is_platform_admin is correctly scoped (§4.1 fix), school members within tenant scope **will not be able to see other users in their organization through RLS alone**. Any staff/student roster UI must do its reads through the `organization_members → users` join with an explicit authorization check. This is not a defect today (no such UI exists) but must be designed explicitly.

---

## 5. What M4 Will NOT Do (out of scope per Mandate)

- Payment processing integration (Paystack live keys, webhook delivery, settlement reconciliation) — authorization gate built but integration deferred.
- Deployment / infrastructure / WAF / TLS / edge rate limiting.
- UI polish for pages unrelated to authorization.
- Email/SMS delivery transport (we will emit audit + token records; actual delivery remains deferred and the dev echo gate is preserved for tests).
- WebAuthn / TOTP MFA.
- Remember-me / extended sessions.
- Redesign of M2 financial triggers or schema.
- Platform admin UI console (only the security boundary is built; UI is later).

---

## 6. Proposed M4 Authorization Architecture (for your approval before coding)

Pending your sign-off, this is what I propose to build.

### 6.1 Roles (keep them small; earn your way in)

| Role | Purpose |
|---|---|
| `OWNER` | Immutable founder of the organization. Can do everything a SCHOOL_ADMIN can, plus transfer ownership, delete the organization, and cannot be suspended by other SCHOOL_ADMINs. Exactly one per org (enforced by partial unique index where role='OWNER' and status='ACTIVE'). Registration creates the first user as OWNER (fixing §4.7). |
| `SCHOOL_ADMIN` | Day-to-day school administrator. Can manage staff, students, fees, invoices, payments, settings, reports. Cannot transfer ownership or delete the org. |
| `FINANCE_OFFICER` | Can manage fees/invoices/payments/receipts/reversals/payment-links and view financial reports/exports. Cannot manage staff, cannot change org settings, cannot create/archive students. |
| `STAFF` | Teachers/non-finance staff. Can view assigned classes/students (future: class-level scoping), mark attendance (M5+). In M4, read-only on student/academic data they are associated with; no financial access. |

Platform administration is NOT a role in an organization. It is a capability on the `users` row (or in a later `platform_admin_capabilities` table).

### 6.2 Permission model

I propose **action-permission grants on resources**, encoded as a pure-TypeScript policy map (no database permissions table initially — the policy is part of the application source and changes with code review; if per-org custom roles become a requirement we add it in M6+).

Example shape:
```ts
type Action =
  | 'student.create' | 'student.read' | 'student.update' | 'student.archive'
  | 'fee_definition.create' | 'fee_definition.read' | ...
  | 'invoice.create' | 'invoice.read' | 'invoice.issue' | 'invoice.void'
  | 'payment.record' | 'payment.confirm' | 'payment.allocate' | 'payment.reverse' | 'payment.refund'
  | 'receipt.issue' | 'receipt.read' | 'receipt.void'
  | 'payment_link.create' | 'payment_link.read' | 'payment_link.revoke'
  | 'membership.invite' | 'membership.read' | 'membership.suspend' | 'membership.change_role' | 'membership.revoke'
  | 'org_settings.read' | 'org_settings.update'
  | 'report.financial.read' | 'report.financial.export'
  | 'audit.read'
  | 'academic_session.manage' | 'term.manage' | 'class.manage';

const POLICY: Record<MembershipRole, Action[]> = {
  OWNER:           [...all],
  SCHOOL_ADMIN:    [...all except ownership transfer / org delete],
  FINANCE_OFFICER: [financial + payment_link + financial report/export + student.read, fee_definition.manage],
  STAFF:           [student.read (scoped), class.read (scoped)],
};
```
Platform authority is a separate set of scoped actions (e.g. `platform.support.read`, `platform.impersonate.enter`, `platform.org.suspend`) — never "bypass everything." Platform actions require entering an explicit platform context and always emit an audit event.

### 6.3 Central authorization boundary

One module — `lib/authz/index.ts` — that provides:

```ts
authorize(ctx: AuthzContext, action: Action, resource?: ResourceRef): AuthzResult
```

Where `AuthzContext` is built by `withAuthorizedRoute()` from the verified session + resolved active membership:
```ts
interface AuthzContext {
  userId: UUID;
  organizationId: UUID;
  role: MembershipRole;
  membershipStatus: 'ACTIVE';
  isPlatformAdmin: boolean;  // only true when entered via platform context, not during tenant visit
  csrfVerified: boolean;
}
```

Every protected API route looks like:
```ts
export async function POST(req: Request) {
  return withAuthorizedRoute(req, { action: 'invoice.issue', method: 'POST' }, async ({ db, ctx, body }) => {
    // body already zod-parsed
    // ctx carries identity, tenant, role
    // authorize already passed
    // db is already tenant-scoped (withTenant + new acting_role GUC)
    const invoice = await invoices.issue(db, ctx, body.invoiceId);
    await auditWrite(db, ctx, 'INVOICE_ISSUED', { invoiceId: invoice.id });
    return NextResponse.json({ invoice });
  });
}
```

This is the ONLY sanctioned path to a repository. Direct calls to `withTenant` from routes are prohibited by lint rule (or code review + convention).

### 6.4 GUC redesign (migration 0005_guc_redesign)

- `app.organization_id` — uuid (text) or ''; tenant scope.
- `app.user_id` — uuid (text) or ''; acting user.
- `app.acting_role` — text (membership_role value or ''), set by `setTenantFor()`; used by future defense-in-depth RLS.
- `app.is_platform_admin` — '0' or '1'; **ONLY** set by a new `enter_platform_context(user)` SECURITY DEFINER function, which itself checks that the user has `is_platform_admin=true`. `setTenantContext(org,user)` always sets this to '0'.
- `app.bypass_financial_triggers` — '0' always (only the financial trigger migrations touch this during corrective trigger logic).

### 6.5 Resource-level authorization helper

For actions that target a specific resource (e.g. `invoice.void`), the central wrapper accepts a `loadResource` hook that fetches the row by id *after setting tenant scope* and verifies `row.organization_id === ctx.organizationId` (defense-in-depth even though RLS already filtered), then passes the row to the handler. If the row is missing or wrong-org, returns 404 (no "belongs to other org" distinction to avoid enumeration).

### 6.6 Active-org selection

- New signed cookie `sc_active_org` containing `<orgId>.<hmac>`.
- Set via an explicit `POST /api/auth/select-organization` endpoint that verifies the user has an ACTIVE membership in that org.
- Read during `getAuthContext()`; falls back to first ACTIVE membership if missing or invalid (and re-signs).
- Never trust a client-supplied orgId in request body/query.

### 6.7 Payment links public surface

- Endpoints: `GET /api/public/payment-links/:token`, `POST /api/public/payment-links/:token/pay` (calls Paystack, not yet wired to live provider), `POST /api/public/paystack/webhook` (HMAC-SHA512 verified against Paystack secret).
- All endpoints have tight rate limits.
- GET returns a narrow payer view DTO (typed to exclude PII beyond what is necessary).
- No public endpoint can mutate payment/invoice state except via Paystack-signed webhook.

### 6.8 Authorization audit

A new `AUTHZ_DENIED` audit event fires on every authorization failure (with action, resource id if any, reason, ip, user id). Existing M3 audit events continue to fire; we add fine-grained events for every role/membership/setting change with `before` and `after` snapshots for mutable fields.

### 6.9 Concurrency semantics

- Authorization is checked **once at request entry** using a snapshot of membership/role. For multi-step transactions, the snapshot membership/role is read with `SELECT ... FOR SHARE` so that a concurrent role change/membership revoke blocks until the transaction completes.
- Rationale: a request that has already passed authorization should not silently fail mid-transaction because an admin revoked the user between statements. However, a revoked user cannot begin new requests because `getAuthContext()` re-reads membership on every request.
- Tests will cover: revoked-during-transaction, role-changed-during-transaction.

### 6.10 Test plan (red-team)

In addition to positive tests for each role/action/resource combination, the M4 test suite will include:
- All 15 Executive Security Gate properties from Mandate §23.
- Foreign-org UUID on every resource type (invoices, payments, students, etc.).
- Foreign-org UUIDs in search/report/export/aggregate query params.
- Forged role, forged organizationId, forged userId in body/query.
- STAFF attempting financial mutations.
- FINANCE_OFFICER attempting staff role changes.
- SCHOOL_ADMIN attempting ownership transfer.
- Platform-admin user entering tenant scope WITHOUT platform powers (cannot read users cross-tenant).
- Revoked membership mid-flight.
- Concurrent role change during sensitive mutation.
- Payment-link token enumeration (timing + rate limit).
- Payment-link response does not leak guardian PII / other invoices.
- Public webhook with invalid signature rejected.
- CSRF enforcement on every POST/PUT/PATCH/DELETE protected route.
- Connection-pool GUC leakage (post-request state is neutral).
- Search result counts/totals do not reveal foreign org existence (inference).

### 6.11 Deliverables for M4

1. Migration `0005_authz_guc.sql` — GUC split, removal of PLATFORM_ADMIN from membership_role (with data migration if any rows exist — none should), new SECURITY DEFINER `enter_platform_context`, `app.acting_role` GUC.
2. `lib/authz/` module — `index.ts` (policy + `authorize()`), `context.ts` (withAuthorizedRoute wrapper), `guc.ts`, `platform.ts`, `public.ts` (payment-links, webhooks).
3. Active-org selection endpoint + signed cookie.
4. Public payment-link and webhook route scaffold (authorization-scoped, not payment-integrated).
5. All protected routes mandated by §3.2 — but rather than build every product feature in M4 (which violates Mandate §26 — "Do not start unrelated product features"), I will build the **authorization layer + a representative subset of business endpoints** that proves each decision path:
   - Staff/membership management (invite, view, suspend, change-role, revoke) — proves role-change security.
   - One financial write path end-to-end (invoice create → issue → payment record → receipt issue) — proves financial authorization.
   - Organization settings view/update — proves org-level privilege.
   - Financial reports endpoint (with a simple aggregate) — proves search/aggregate tenant scoping.
   - Audit log read endpoint (restricted to SCHOOL_ADMIN+) — proves sensitive-read control.
   - Payment link create/revoke and public view — proves public surface isolation.
   - Platform-admin explicit entry route gated behind platform capability — proves platform boundary.
   - Remaining product UI is M5 once the authority layer is proven.
6. Centralized CSRF enforcement in the wrapper (not per-route).
7. Full docs: `docs/security/AUTHORIZATION_MODEL.md`, `AUTHORIZATION_MATRIX.md`, `M4_SECURITY_TEST_RESULTS.md`.
8. Red-team tests covering the §23 gate properties.

---

## 7. Questions I Need You to Settle Before I Code

These are policy calls, not engineering calls:

1. **Owner vs School Admin.** Is the founding user registered as OWNER (immutable, can transfer ownership, cannot be suspended by other admins) or SCHOOL_ADMIN (mutable, no special status)? I recommend OWNER as the anchor of last resort for a school.
2. **FINANCE_OFFICER scope.** Can a finance officer create/archive students? (I recommend no — students are academic records.) Can a finance officer void invoices? (I recommend yes — void is a finance operation, not an admin operation.) Can they issue refunds unilaterally or does that require a second approval? (M4: unilateral; second-approval is M6+ workflow.)
3. **STAFF read scope.** In M4, do teachers see ALL students in the school or only those in classes they are assigned to? I recommend **all students in the school for read-only** for M4, with class-level scoping added in M5 once class-assignment exists. (Cross-class access is a privacy issue, but with no assignment data yet the alternative is zero student visibility for STAFF until M5, which breaks the product.)
4. **Platform-admin cross-tenant support read.** When a platform admin acts in a support capacity for a school, can they view financial data (invoices/payments) or only identity/settings? I recommend platform admins get read-only access to everything via an explicit "enter support mode" flow (audited, time-limited) but cannot initiate financial mutations. This aligns with Mandate §10's "narrowly scoped, auditable" requirement.
5. **Exports.** Any role that can view reports can export? Or does export require a higher privilege (exfiltration risk)? I recommend: financial report/export is one permission (`report.financial.read`) — exports are just a format; restricting format without restricting read doesn't actually protect data.
6. **Preview pages.** Keep them (public design templates) until production, or remove now? I recommend gating them behind NODE_ENV !== 'production' so they can't leak UI in production.

---

## 8. Declaration

This reconnaissance is complete. I have not written any M4 authorization code beyond what was necessary to read the existing system. I am presenting findings and proposed architecture per Mandate §04 before proceeding. The §4.1 GUC conflation is flagged as an architectural defect rather than silently patched, per your instruction in §25 ("If you find something wrong ... Architectural defect → Stop. Explain it. Do not silently patch around it.").

Awaiting your approval of the architecture (and answers to the §7 policy questions) before I begin implementation.
