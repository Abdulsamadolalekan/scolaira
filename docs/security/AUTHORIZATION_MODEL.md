# AUTHORIZATION_MODEL — SCOLAIRA M4

This document is the canonical reference for SCOLAIRA's authorization model.
Engineers must be able to answer "why was this request allowed / denied?" by
reading this file plus the single code boundary in `lib/authz`.

## 1. The Request Chain

Every authenticated request, without exception, flows through this pipeline:

```
Request
  │
  ├─► Parse raw session id from Cookie header (lib/authz.currentRawSessionId)
  ├─► Verify session cookie signature (lib/auth/cookies.verifySessionCookie)
  ├─► Load session + memberships from DB (lib/auth.getSession)
  │      ├─ session.user
  │      ├─ session.activeOrganizationId    (from signed cookie, server-validated)
  │      ├─ session.activeRole              (server-derived, never from client)
  │      └─ session.memberships[]           (all active/invited memberships)
  │
  ├─► CSRF check on state-changing methods (lib/auth.verifyCsrfToken)
  │      x-csrf-token header + csrf cookie + session id — HMAC-bound
  │
  ├─► Resolve active membership
  │      Must exist; must be ACTIVE; must belong to active org.
  │      Otherwise → 401/403 — session is unusable.
  │
  ├─► Authorize(action, resource, ctx)
  │      Inputs: role (OWNER | SCHOOL_ADMIN | BURSAR | TEACHER | STUDENT/PARENT)
  │              resource (ORG, MEMBERS, STUDENTS, INVOICES, PAYMENTS, …)
  │              action (READ, CREATE, UPDATE, DELETE, INVOKE, …)
  │              ctx (resourceOrgId? must equal session.activeOrganizationId)
  │      Output: ALLOW / DENY (DENY → 403; no silent fallback)
  │
  ├─► withTenant(session.activeOrganizationId, session.activeRole)
  │      Sets Postgres GUCs app.organization_id, app.acting_role,
  │      app.user_id, app.is_platform_admin — the inputs M2 RLS policies use.
  │      These GUCs are the ONLY way tenant context enters DB operations;
  │      there is no "pass orgId from controller to repo" API that bypasses them.
  │
  ├─► Execute handler. Every SELECT/INSERT/UPDATE/DELETE is scoped by RLS
  │   to app.organization_id (defense-in-depth on top of the JS check),
  │   and financial triggers additionally verify app.acting_role.
  │
  └─► Audit log write (who, org, role, resource, action, target, before?, after?, why?).
```

## 2. Roles, not permissions — by design

SCOLAIRA intentionally does NOT have a 50-row `permissions` table. Roles are
defined from the real operations that exist in a school:

| Role            | Purpose                                                |
|-----------------|--------------------------------------------------------|
| `OWNER`         | Organizational anchor. Exactly one ACTIVE OWNER per org (DB-enforced). Powers enumerated in §4; no "god mode". |
| `SCHOOL_ADMIN`  | Day-to-day school operations: staff, students, settings. Cannot touch OWNER. Cannot transfer ownership or delete the org. |
| `BURSAR`        | Financial operations only: invoices, payments, receipts, reports. Read-only on student/staff directory. |
| `TEACHER`       | Own classes/marks/attendance; cannot see money, cannot see other classes' students beyond shared rosters (defense-in-depth). |
| `STUDENT`/`GUARDIAN` | Read own records, own invoices, own receipts; make payments against own invoices. |
| `PLATFORM_ADMIN` (session-level, not a membership role) | Support access — see §6. Narrow, explicit, audited, opt-in per-session. |

Roles are stored on the `organization_members` row, never on the user and never
sent by the client. The server re-derives `activeRole` from the DB on every
request; role forgery in cookies or request bodies cannot succeed.

## 3. Multi-tenancy is sacred

- `app.organization_id` is set in Postgres GUCs once per request at the withTenant
  boundary, before any repo calls. Every tenant-owned table's RLS policy enforces
  `organization_id = current_setting('app.organization_id')::uuid`.
- Direct UUIDs in URL/body/query/filter/search/aggregate/report/export paths are
  NEVER trusted: RLS will return 0 rows for foreign IDs (SELECT) or raise
  `tenant_mismatch` (INSERT/UPDATE/DELETE via `trg_set_org_from_context` +
  `trg_guard_cross_tenant_mutation`).
- Aggregates, counts, totals, search, exports, reports are scoped by the same
  GUCs — they cannot leak other tenants' data via aggregation.
- Payment links are addressed by 32-byte CSPRNG tokens (not UUIDs of tenant
  resources) with their own RLS and expiry — enumeration yields 404.
- There is no connection-pool leak: `withTenant` uses a single connection for
  the duration of the request via `db.withConnection`, so GUCs never bleed to
  another request.

## 4. OWNER — a precise anchor, not a god role

Founder's decision, explicitly encoded: exactly one ACTIVE OWNER per org
(Postgres partial unique index `org_members_one_active_owner_idx`). OWNER's
powers are:

1. Transfer ownership to another ACTIVE member (atomic, transactional, audited;
   rejects target not in org; cannot end up with 0 or 2 owners even transiently).
2. Delete the organization (only when zero financial balances, or via archive;
   in M4 DELETE /api/org is gated behind OWNER and returns 400 if balance≠0).
3. Invite, suspend, reactivate, remove any member — including SCHOOL_ADMIN and
   lower. OWNER may NOT remove or suspend themselves unless ownership is
   transferred first.
4. Assign and change roles of other members, EXCEPT: cannot demote/remove the
   current OWNER (that would be themselves) without transferring first.
5. Update organization settings (name, logo, address, academic-year config).
6. All ordinary operations that SCHOOL_ADMIN/BURSAR can do (read, etc.).

OWNER does NOT bypass:

- RLS (it applies to everyone).
- Financial state guards (can't issue a receipt against an unpaid invoice, etc.).
- Idempotency/concurrency controls.
- Audit logging.
- CSRF.
- The principle that financial mutations require an explicit resource check.

SCHOOL_ADMIN explicitly CANNOT:

- Suspend, remove, or change the role of any OWNER.
- Transfer ownership.
- Delete the organization.
- Revoke or issue API keys (future — reserved to OWNER).

These denials are enforced in `Members.canModifyMemberPolicy` (returns FORBIDDEN
if target.role === OWNER and actor.role !== OWNER) and `authorize()` itself.

## 5. Financial authorization

Every financial mutation (invoice issue/void, payment record/confirm/allocate/
reverse/refund, receipt issue/void, payment-link create/revoke, reconciliation)
must answer:

- **Who** — authenticated user with active membership;
- **In which org** — activeOrganizationId, enforced by GUC+RLS;
- **Against which resource** — invoice/payment/receipt must belong to that org
  (defense-in-depth foreign-key org check above RLS);
- **Under what state** — state-machine guards (Postgres triggers) reject invalid
  transitions (e.g., voiding a voided invoice, allocating to a paid invoice);
- **Audited** — every mutation writes an `audit_events` row with actor, org,
  resource, action, before/after (redacted of secrets), idempotency key;
- **Idempotent** — client-supplied Idempotency-Key header replayed within 24h
  returns the original result without double-acting;
- **Concurrency-safe** — financial triggers and unique constraints prevent
  double-spend (e.g., allocation amounts can't exceed invoice balance).

Platform support mode (§6) does NOT grant the ability to mutate financials in
customer orgs; platform actions default to read-only observability and any
financial action on behalf of a school requires an explicit ticket-scoped grant
that the code tracks separately (M5 / operations console).

## 6. Platform administration

There is NO `isPlatformAdmin → bypass everything` code path. Platform sessions
are a separate mode entered explicitly (`POST /api/platform/support-mode` with
second factor out of scope for M4 — scaffolded, returns NOT_IMPLEMENTED) and
scoped:

- `isPlatformSession` flag on the session, default false;
- When active, `app.is_platform_admin` GUC = '1', which lets RLS policies see
  across orgs for observability reads (e.g., audit search across tenants for
  fraud response) but does NOT grant write access — financial triggers and
  write-path RLS still require org-scoped context;
- Every entry/exit/query in platform mode is audited with a reason field the
  operator must supply;
- Platform mode never silently becomes unlimited; the code boundary
  (`lib/authz/platform.ts`) enumerates allowed platform actions.

## 7. Defense in depth layers

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| L1 — Session | signed HMAC cookie, rotated on privilege change | prevents session forgery |
| L2 — CSRF | double-submit token bound to session id | blocks cross-site mutation |
| L3 — Authz JS | `authorize(action,resource,ctx)` in `lib/authz` | single point where decisions are made |
| L4 — Tenant GUC | `withTenant()` sets PG GUCs per-request; connection-scoped | prevents GUC leakage |
| L5 — RLS | `ENABLE ROW LEVEL SECURITY` + per-table policies on `app.organization_id` | rejects cross-tenant access even if L3 has a bug |
| L6 — Triggers | `trg_set_org_from_context`, `trg_guard_cross_tenant_mutation`, financial state-machine triggers | last-ditch row-level veto |
| L7 — Partial unique index | `org_members_one_active_owner_idx` | DB-enforced exactly-one-OWNER invariant |
| L8 — Audit log | append-only `audit_events` table; auditable after the fact | detection & forensics |
| L9 — Idempotency keys | `idempotency_keys` table | prevents duplicate mutations on retries |

If any layer L(n) has a bug, L(n+1) must still prevent the failure. M4 red-team
tests (see M4_SECURITY_TEST_RESULTS.md) specifically exercise L1–L7.

## 8. Code boundary

The single authorization boundary is:

- `lib/authz/index.ts` — `requireAuth()`, `requireMembership()`, `authorize()`,
  `withAuthz()`, `currentRawSessionId()`, `CurrentRequestContext`.
- `lib/db/tenant.ts` — `withTenant()`, `withSystemContext()` (for migrations,
  background jobs, and tests only — NEVER from a route handler).
- `lib/auth/index.ts` — `getSession()`, cookie/session issuance.

Route handlers look like:

```ts
export async function PATCH(req: Request) {
  const ctx = await withAuthz(req, {
    resource: 'ORG',
    action: 'UPDATE',
    roles: ['OWNER'],
    requireActive: true,
  });
  // ctx.db is already tenant-scoped. ctx.membership has role, orgId, userId.
  // No further role/org checks are needed in handler code.
}
```

If a handler does NOT call `withAuthz` (or its cousin that accepts `params`),
it does NOT have a tenant-scoped `db`; attempting to call repo functions
without going through `withTenant` will fail when GUCs are unset (RLS denies).

## 9. What is NOT authorization

- A valid session is not authorization.
- A valid membership is not authorization.
- A role the client claims in a request body/query/header is not authorization.
- An `organizationId` the client sends is not authorization; the server uses
  `session.activeOrganizationId` which was set by the most recent
  `/api/auth/select-organization` call that itself re-verified membership.
- Having a user account on the platform is not authorization to any org's data.

## 10. Threat model summary

- **Forged identity** — rejected by signed session cookie (L1).
- **CSRF** — rejected by double-submit token (L2).
- **Wrong role** — rejected by `authorize()` (L3); role comes from DB, not client.
- **Wrong tenant by direct UUID** — rejected by RLS (L5) and cross-tenant trigger (L6).
- **Wrong tenant by aggregate/search/export** — all queries use GUC; rejected by RLS (L5).
- **Privilege escalation user→platform** — platform mode is a separate session flag, opt-in, audited (§6).
- **Ownership transfer abuse** — atomic SQL, target must be active member in same org; partial unique index enforces exactly-one-owner even with bugs above (L7).
- **Financial double-mutation** — idempotency keys (L9) + state triggers (L6).
- **Cross-request connection leakage** — per-connection GUCs in `withTenant`; never shared (L4).
