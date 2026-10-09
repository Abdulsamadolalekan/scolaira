# SCOLAIRA — M6 Reconnaissance Report

**Status:** M5 BASELINE: FROZEN · M6 RECONNAISSANCE: COMPLETE · M6 IMPLEMENTATION: NOT STARTED · M6 BUILD AUTHORIZATION: AWAITING REVIEW
**Prepared:** 2026-09-19
**M5 tag:** `M5-FROZEN` → `0c66618e29e6179c80052a82c40f669979cef6b0`
**Working HEAD:** `49ea624` (a prior-session M6-WIP commit that sits on top of M5) + 2 modified files + 4 untracked files — all pre-reconnaissance M6 artifacts, documented in §2.3. They are **not** folded into M5 and **not** removed; M5 remains immutable.

---

## 1. Executive Summary

M5 delivered a complete, trigger-enforced financial lifecycle (draft → issue → allocate → confirm → reverse) with tenant isolation, RLS, append-only audit, idempotency, and a calm institutional UI for invoices, payments, and the command center. The financial primitives are sound and will not be modified for M6.

What M6 must add is **operational usability for a real Nigerian bursar and proprietor**: the ability to act on what they see (void an invoice, confirm a pending transfer, allocate unallocated credit, reverse a mistaken entry); a trustworthy receipt of record; shareable payment links that reflect bank-transfer reality (no fake PSP); a reconciliation workbench that resolves items rather than listing them; and enough academic/fee configuration that invoices don't have to be typed by hand every term.

M6 will **not** introduce a new service layer, will not modify M2 financial triggers or M4 authorization, will not add a parallel ledger, will not integrate a live PSP, will not add a parent portal, and will not batch-generate invoices.

---

## 2. Current System Baseline

### 2.1 Git state
| Ref | SHA | Meaning |
|---|---|---|
| `M5-FROZEN` (tag) | `0c66618e29e6179c80052a82c40f669979cef6b0` | Verified M5 baseline; never to be amended. |
| `HEAD` | `49ea624e35982c01e85e6e9fb0f4fc9747c4d620` | Prior-session checkpoint "M6 WIP: student directory/profile + new student/invoice/payment flows" — **not** part of M5; treated as early M6 scaffolding subject to review/fix. |
| Working tree | dirty (see §2.3) | Additional pre-reconnaissance M6 artifacts; left in place, not committed as part of M5. |

### 2.2 M5 frozen content (at tag `M5-FROZEN`, enumerated from `git ls-tree`)
- 244 tracked files; 10 migrations (`0000_init` … `0010_lockdown_secdef`).
- API endpoints: all `/api/auth/*`, `/api/health`, `/api/dashboard/summary`, `/api/invoices` (GET list, POST create+issue), `/api/invoices/[id]` (GET detail only — no void/issue PATCH), `/api/payments` (GET list, POST record w/ allocations), `/api/payments/[id]` (GET), `/api/payments/[id]/confirm`, `/api/payments/[id]/reverse`, `/api/payments/[id]/allocate`, `/api/members` (+ /[id], /suspend, /reactivate), `/api/org/settings`, `/api/org/transfer-owner`, `/api/setup/seed-current-term`, `/api/students` (POST create — **only**, no GET list at M5).
- Authenticated pages: `/dashboard`, `/invoices`, `/invoices/[id]`, `/payments`, `/payments/[id]`, `/members`, `/settings`, `/students` (33-line stub — "coming soon").
- Auth pages: `/login`, `/register`, `/reset`, `/reset/confirm`.
- Public preview routes under `/preview/*` (design system, not part of operating product).
- Landing `/` redirects based on session.
- All 15 test files across `tests/auth` and `tests/db` (187 tests pass at M5 verification).
- All M2 financial triggers, all M3 idempotency, all M4 RLS/authorization, all M5 UI shell.

### 2.3 Pre-reconnaissance M6 artifacts (NOT M5, preserved)
The following exist because an earlier session began M6 implementation before this directive. They are **NOT M5**, are referenced honestly throughout this report, and will be reviewed/fixed/extended under this reconnaissance rather than discarded:

- **Committed at `49ea624`:**
  - `app/api/students/route.ts` — rewritten to add GET list with per-student billed/paid/outstanding summary.
  - `app/api/students/[id]/route.ts` — NEW: GET student financial profile (invoices, payment allocations, summary).
  - `app/api/terms/route.ts` — NEW: GET list with isCurrent flag.
  - `lib/authz/permissions.ts` — added `'term.read'` action (granted OWNER/SCHOOL_ADMIN/FINANCE_OFFICER/platform-support).
  - `app/(app)/students/page.tsx` — full directory with KPI strip, responsive table/cards, permission-gated CTA.
  - `app/(app)/students/new/page.tsx` + `new-student-form.tsx` — new-student client form with CSRF, 409 handling.
  - `app/(app)/students/[id]/page.tsx` — student financial profile page.
  - `app/(app)/invoices/new/page.tsx` + `new-invoice-form.tsx` — single-line invoice form (draft + issue in one tx).
  - `app/(app)/payments/new/page.tsx` + `record-payment-form.tsx` — record-payment form with allocation preview across CASH/BANK_TRANSFER/POS/ONLINE/OTHER.
  - `lib/ui/csrf.ts` — client CSRF double-submit helper.
- **Uncommitted working-tree changes:**
  - `app/(app)/layout.tsx` — nav: students badge removed, Reconcile added.
  - `app/(app)/payments/[id]/page.tsx` — "Print receipt" CTA added.
  - `app/(app)/payments/[id]/receipt/page.tsx` (new) — printable receipt view (computed ad-hoc from payment; **does not** issue a `receipts` row — see §11 Risk R5).
  - `app/(app)/reconcile/page.tsx` (new) — static reconcile workbench (pending/unallocated/open-invoices lists, **no action buttons wired**).
  - `app/api/payment-links/route.ts` (new) — list/create (CREATE works; GET has a lazy `require('drizzle-orm')` inside a helper that is functional but inelegant).
  - `app/api/payment-links/[token]/route.ts` (new) — PATCH revoke with an incorrect `withAuthorizedRoute` 4th-arg signature (**known bug**, see §11 Risk R4).

TypeScript, `next build`, and the 187/187 test suite were verified passing against this state in the prior session.

### 2.4 Verification evidence carried forward
- `tsc --noEmit` clean.
- `next build` clean (all routes compiled).
- 187/187 vitest tests passing across authz, RLS-bypass regression, state machines, financial invariants, concurrency, tenant isolation, audit, idempotency, webhook, financial attacks, rich-seed, db-boundary, runtime-role-safety.
- Migrations apply cleanly (`npx tsx scripts/migrate.ts` reports 10 migrations, `new=0`).

---

## 3. Existing Capabilities

### 3.1 Pages (authenticated)
| Page | M5 state | Current state (incl. M6 WIP) |
|---|---|---|
| `/dashboard` | Exists — KPIs, attention, activity feed | Unchanged |
| `/invoices` | Exists — register, New CTA, responsive table/cards | Unchanged |
| `/invoices/[id]` | Exists — detail, lines, audit timeline; **read-only** (no Void/Issue buttons) | Unchanged |
| `/invoices/new` | Missing | **Exists** (M6 WIP) |
| `/payments` | Exists — register, method/status pills, unallocated badge | Unchanged |
| `/payments/[id]` | Exists — money ladder, allocations, activity; **read-only** (no Confirm/Allocate/Reverse buttons) | + Print-receipt CTA |
| `/payments/new` | Missing | **Exists** (M6 WIP) |
| `/payments/[id]/receipt` | Missing | **Partial (uncommitted, see R5)** |
| `/students` | Stub (33 lines) | **Exists** (M6 WIP) |
| `/students/new` | Missing | **Exists** (M6 WIP) |
| `/students/[id]` | Missing | **Exists** (M6 WIP) |
| `/members` | Exists | Unchanged |
| `/settings` | Partial (org settings + owner transfer) | Unchanged |
| `/reconcile` | Missing | **Partial (uncommitted — lists only, no actions)** |

### 3.2 Pages (public)
- `/login`, `/register`, `/reset`, `/reset/confirm` — exist.
- `/p/[token]` payment-link landing — **missing**.
- `/preview/*` — design-system previews; not user-facing product.

### 3.3 API endpoints
Classified at HEAD (after M6 WIP):

| Endpoint | Method(s) | State |
|---|---|---|
| `/api/auth/*` | all | Exists (public, M4) |
| `/api/health` | GET | Exists (public) |
| `/api/dashboard/summary` | GET | Exists — KPI trust bug noted (§11 R1) |
| `/api/invoices` | GET, POST | Exists |
| `/api/invoices/[id]` | GET | **Partial — no PATCH void, no PATCH issue-draft** |
| `/api/payments` | GET, POST | Exists (idempotent POST, allocations inline) |
| `/api/payments/[id]` | GET | Exists |
| `/api/payments/[id]/confirm` | POST | Exists |
| `/api/payments/[id]/reverse` | POST | Exists |
| `/api/payments/[id]/allocate` | POST | Exists |
| `/api/members[/[id],/suspend,/reactivate]` | all | Exists |
| `/api/org/settings`, `/transfer-owner` | all | Exists |
| `/api/setup/seed-current-term` | POST | Exists |
| `/api/students` | GET, POST | **Exists (M6 WIP)** |
| `/api/students/[id]` | GET | **Exists (M6 WIP); no PATCH/archive/restore** |
| `/api/terms` | GET | **Exists (M6 WIP)** |
| `/api/payment-links` | GET, POST | **Partial (uncommitted; POST correct, GET functional but inelegant)** |
| `/api/payment-links/[token]` | PATCH | **Buggy (uncommitted; signature mismatch with `withAuthorizedRoute`)** |
| `/api/classes` | any | **Missing** |
| `/api/fee-definitions` | any | **Missing** |
| `/api/fee-assignments` | any | **Missing** |
| `/api/receipts/*` | any | **Missing** (receipts table + repo exist but no API) |
| `/api/reports/*` | any | **Missing** (permissions defined) |
| `/p/[token]` (public) | GET | **Missing** |

### 3.4 Repositories (`lib/db/repo/`)
All exist as tenant-scoped CRUD; no service layer (intentional M2 architecture — business logic lives in triggers and routes):
academic-sessions, terms, classes, students, invoices, invoice-lines, payments, payment-allocations, payment-links, fee-definitions, fee-assignments, receipts, reversals, audit-events, idempotency-keys, organization-members, organizations, users, webhook-events.

Key methods already present:
- **invoices**: `createDraft`, `get`, `issue`, `voidInvoice`, `listForStudent`, `listOutstanding`.
- **payments**: `record`, `confirm`, `markFailed`, `get`, `findByReference`, `listForOrg`.
- **payment-allocations**: `allocate` (used by POST `/api/payments/[id]/allocate`).
- **payment-links**: `create`, `findByTokenPublic`, `revoke`.
- **students**: `create`, `get`, `getByStudentId`, `listForOrg`.
- **receipts**: `issue`, `get`, `listForPayment`.

Missing repo methods needed for M6:
- `students.update` (patch name/middleName/gender fields), `students.archive`, `students.restore`.
- Minor: `payment-links.listForOrg` (GET currently queries the table directly in the route).

---

## 4. Architecture Map

### 4.1 Request → Response chain (frozen, must be reused)
```
NextRequest
  → middleware (auth/session refresh)
  → Route handler
  → withAuthorizedRoute(options, handler)
       1. getSession()  → 401 if missing/revoked/expired
       2. requireCsrf() for unsafe methods (double-submit cookie sc_csrf → x-csrf-token)
       3. authorize(ctx, action) via POLICY matrix  → 403
       4. Zod parse body/query  → 400
       5. withTenant(identity, fn)
            · SELECT set_tenant_context(org, user)  → GUC app.organization_id / app.user_id
            · callback receives (db, ctx); all queries use drizzle with RLS enforced
            · finally: RESET GUCs (even on throw)  → prevents cross-request pool leakage
       6. handler → repos → drizzle → Postgres → RLS policies
       7. auditRepo.record(tx, ctx, …)  (append-only, trigger-blocked UPDATE/DELETE)
  → NextResponse
```

### 4.2 Database
- **Role wiring:** three Postgres roles: `scolaira_migrator` (owner/SUPERUSER used only for migrations/seeds), `scolaira_app` (NOBYPASSRLS, runtime role — all app queries), `scolaira_authenticator` (connection pool login; SET ROLE to `scolaira_app`).
- **RLS enabled on every tenant table; default-deny with no context** (proven by `rls-bypass-regression.test.ts`).
- **Policies** (0008 + 0010): per-table `%I_tenant_isolation` policies generated dynamically; users/sessions/password_resets scoped to self; platform support mode restricted to read-only via `PLATFORM_SUPPORT_ACTIONS`.
- **Financial columns guarded:** `trg_guard_financial_columns` blocks direct writes to `invoices.total_kobo/paid_kobo`, `payments.unallocated_kobo`; `trg_guard_payment_unalloc` additionally prevents any update to `unallocated_kobo` outside allocation/reversal triggers.
- **Status machines** enforced by `trg_enforce_status_transitions` (state transition whitelist per enum).
- **Append-only audit and reversals:** `trg_audit_immutable`, `trg_block_financial_delete` on invoices/payments/allocations/receipts/reversals.

### 4.3 Migrations
10 migrations, applied in order; schema is the source of truth — no drizzle-kit `push` or `migrate` (only `scripts/migrate.ts` against raw SQL).

### 4.4 Idempotency
`lib/db/repo/idempotency-keys.ts` + `/api/invoices` and `/api/payments` POST handlers call `idemRepo.acquire()` / `idemRepo.complete()` within a transaction; replays return the original response with `Idempotent-Replayed: true`.

### 4.5 UI / component system
Design tokens in `tokens.css` + `globals.css` (forest/gold/ivory ink palette); reusable components in `components/ui/`:

- **Layout:** `nav-shell` (`Card`, `CardHeader`, `AppShell`), `app-shell`, `kpi-card`.
- **Atoms:** `Badge` (success/warning/danger/info/neutral/gold/forest), `Money` (kobo-safe, locale-formatted), `Button`, `Input`, `confirm` (ConfirmDialog), `dialog`, `drawer`, `dropdown-menu`, `checkbox`, `tooltip`, `toast`.
- **Patterns:** `EmptyState`, `ErrorState`, `Skeleton`, `AccessDenied`, `PermissionGuard`, `table`.
- Typography: serif (`var(--font-serif)`) for page titles, sans for UI; tabular-nums for money; 10/11px uppercase tracking-wider for labels.
- Page layout: `mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8` standard container; `grid-cols-*` responsive tables vs. `md:hidden` card lists.

### 4.6 Tests (15 files, 187 cases, all green)
- Auth: authz matrix, m4 pentest, rls-bypass-regression, runtime-role-safety, auth flows.
- DB: audit, concurrency (parallel allocations), db-boundary, financial-attacks, financial-invariants, idempotency, rich-seed, state-machines, tenant-isolation, webhook idempotency.
- Unit: `lib/money` and `components/ui/money`.

---

## 5. Financial Source of Truth

Every money number displayed in M6 must derive from trigger-maintained columns. **No dashboard-specific aggregations, no client-side math beyond formatting.**

| Metric | Authoritative column(s) | Definition | Boundary | Authz |
|---|---|---|---|---|
| **Billed** (term- or org-scoped) | `invoices.total_kobo` where `status IN ('ISSUED','PARTIALLY_PAID','PAID')` (DRAFT/VOID excluded) | Sum of totals of issued invoices (not drafts, not voids) | `invoices.organization_id = current_setting('app.organization_id')::uuid` enforced by RLS | `invoice.read` or `dashboard.read` |
| **Collected** | `SUM(payments.amount_kobo - payments.unallocated_kobo) WHERE status='CONFIRMED'` (preferred) — equivalently `SUM(payment_allocations.amount_kobo WHERE status='ACTIVE')` | Money confirmed AND allocated. Unallocated cash is NOT collected. | payments.org_id RLS | `payment.read` / `dashboard.read` |
| **Outstanding** | `SUM(invoices.total_kobo - invoices.paid_kobo) WHERE status IN ('ISSUED','PARTIALLY_PAID')` | What parents still owe on issued non-void invoices | invoices.org_id RLS | invoice.read |
| **Overdue** | outstanding subset `AND due_date IS NOT NULL AND due_date < CURRENT_DATE AND remaining > 0` | Aged outstanding | 〃 | 〃 |
| **Unallocated credit** | `SUM(payments.unallocated_kobo) WHERE status='CONFIRMED'` | Cash in suspense, not yet applied | payments.org_id RLS | payment.read |
| **Pending/unreconciled** | `COUNT(*)` / `SUM(amount_kobo) WHERE status='PENDING'` | Recorded but not confirmed against bank | payments.org_id RLS | payment.read / payment.confirm |
| **Invoice balance** | `total_kobo - paid_kobo` (trigger-guarded) | Never recompute client-side | invoices.org_id RLS | invoice.read |
| **Payment applied to student** | JOIN `payment_allocations → invoices → students`, SUM allocations with status='ACTIVE' | Allocated amount whose invoice belongs to the student | Both tables RLS | student.read (profile) |
| **Partially paid / Paid / Void / Draft** | `invoices.status` enum set by trigger | Use enum value; do not infer from balances alone | 〃 | 〃 |
| **Collection rate** | `collected × 10000 / billed` (basis points), server-computed | Billed=0 ⇒ 0% | derived | dashboard.read |

**No M6 feature may introduce a stored/derived balance column or a "ledger" table that duplicates these values.** Any new aggregation must read from these columns.

### Financial lifecycle already enforced (M2, frozen)
1. `payments.record` → status PENDING or CONFIRMED; if CONFIRMED, trigger seeds `unallocated_kobo = amount_kobo`.
2. `payments.confirm` → transition PENDING→CONFIRMED; same trigger seeds unallocated.
3. `payment_allocations.allocate` → trigger validates: alloc ≤ payment.unallocated AND ≤ invoice.outstanding; decrements payment.unallocated; increments invoice.paid_kobo; flips invoice status to PARTIALLY_PAID/PAID; appends to audit.
4. `reversals.insert` (on reverse/refund) → trigger reverses allocation (ACTIVE→REVERSED), restores payment.unallocated, decrements invoice.paid_kobo, recomputes invoice status; appends reversal row (immutable).
5. `invoices.voidInvoice` → sets status VOID; precondition: balance must be 0 or caller must reverse allocations first; appends audit.
6. `invoices.issue` → DRAFT→ISSUED; sets issued_at/number; appends audit.
7. Deletes blocked everywhere by `trg_block_financial_delete`.

---

## 6. Security / Tenancy Model

Every M6 endpoint must:
1. Export a handler wrapped by `withAuthorizedRoute` (public endpoints: `/p/[token]`, auth routes, health — see §6.3).
2. Declare an explicit `Action` (from the existing `Action` union).
3. Rely on `ctx.organizationId` from the tenant context; never accept orgId from the request body.
4. Never accept `role`, `isAdmin`, `isPlatformAdmin` from client payloads.
5. Use the repository methods that take `ctx` (repos automatically include `organization_id` predicates).
6. For cross-entity lookups (e.g. "does this invoice belong to this org?"), call `assertResourceInOrg(ctx, resource, 'Name')`.
7. For unsafe methods, CSRF is enforced automatically by `withAuthorizedRoute` (default: `csrf: !SAFE_METHODS.has(method)` → on for POST/PATCH/PUT/DELETE). Client forms use `csrfHeaders()` from `lib/ui/csrf.ts`.
8. Wrap multi-statement financial operations in `db.transaction(...)` while still inside `withTenant` (GUCs are inherited by the transaction).
9. Write an `auditRepo.record(...)` entry for every mutation, including `requestId` correlation.
10. Accept `Idempotency-Key` for mutating endpoints where retries are plausible (confirm, allocate, reverse, void, issue, receipt issue).

### 6.1 Existing Actions M6 will use (all already in POLICY)
`invoice.void`, `invoice.issue`, `payment.confirm`, `payment.allocate`, `payment.reverse`, `receipt.read`, `receipt.issue`, `payment_link.create/read/revoke`, `student.update/archive/restore`, `fee_definition.manage`, `fee_assignment.manage`, `class.read`, `term.read`, `student.read/create`, `dashboard.read`. **No new Actions are required.**

### 6.2 Role map for new M6 operations
| Operation | OWNER | ADMIN | FINANCE_OFFICER | STAFF |
|---|---|---|---|---|
| Void invoice | ✓ | ✓ | ✓ | ✗ |
| Issue draft invoice | ✓ | ✓ | ✓ | ✗ |
| Confirm payment | ✓ | ✓ | ✓ | ✗ |
| Allocate payment | ✓ | ✓ | ✓ | ✗ |
| Reverse payment | ✓ | ✓ | ✓ | ✗ |
| Print/issue receipt | ✓ | ✓ | ✓ | ✗ |
| Create/list/revoke payment link | ✓ | ✓ | ✓ | ✗ |
| View public `/p/[token]` | (public — token as bearer secret) |
| Student update/archive | ✓ | ✓ | ✗ | ✗ |
| Fee definitions / assignments manage | ✓ | ✓ | ✓ | ✗ |
| Classes list | ✓ | ✓ | ✓ | ✗ |

### 6.3 Public `/p/[token]` (the only new unauthenticated surface)
- Runs outside `withAuthorizedRoute`.
- Bootstrap: looks up link by `token` against a direct connection as `scolaira_app` without any GUC set; RLS on `payment_links` must allow public token lookup (RLS policy for payment_links is a M6 migration decision — see §10).
- After reading the link row, it calls a minimal public-context setter that:
  - Sets `app.organization_id` to `link.organization_id`.
  - Sets `app.user_id = ''` (unauthenticated).
  - Sets `app.is_platform_admin = '0'`, `bypass_financial_triggers = '0'`.
  - Does **not** call `set_tenant_context` (which requires a membership).
- All subsequent queries (invoice, student, org) run with that GUC; RLS must be permissive enough to allow READ of those specific rows when matched to org_id but NOT of any other table.
- Mutations from the public page must record a PENDING payment with `initialStatus: 'PENDING'` via `payRepo.record` (same path an authenticated bursar uses); they must NOT be able to confirm, allocate, or void anything.
- PII on the public page is limited to: student first name + last initial, invoice number/amount, school name + bank details. No other student fields, no other invoices, no other students.
- GUCs cleared in `finally`.
- CSRF: not applicable for public endpoint (no session); instead rely on the token as bearer secret (24-char `nanoid`, 128 bits of entropy, unique-indexed). Tokens can be revoked, which immediately disables the page.

### 6.4 Cross-tenant protections already in place (must not be weakened)
- RLS default-deny when GUC is unset; pool connection GUCs cleared in `finally`.
- `assertResourceInOrg` on every cross-resource lookup in handlers.
- Tenant-scoped repositories.
- Platform-support mode restricted to PLATFORM_SUPPORT_ACTIONS (read-only).
- Runtime role `scolaira_app` is NOBYPASSRLS.
- System-context function is not GRANTed to `scolaira_app`.
- No direct SQL using `organization_id` from request body without going through ctx.

---

## 7. Product/UX Surface Map

### 7.1 OWNER / Proprietor
- **Need:** one screen that tells them how much is owed, how much has come in, what is ageing, what the bursar hasn't processed yet, and whether anyone needs to be chased.
- **Exists today:** Command Center with 5 KPIs, attention list, activity feed.
- **Gap:** KPIs are all-time, but greeting says "the term" (R1); no link to drill into reconcile; no indication of prior-term arrears; no print/export.

### 7.2 BURSAR / FINANCE_OFFICER
- **Need:** fast entry of payments as they walk in (cash, POS, transfer alert); quick confirmation of pending transfers; allocating money to invoices; issuing receipts; sharing payment links; voiding mistakes; reversing bad entries.
- **Exists today:** Payment register, payment detail (read-only), invoice register, invoice detail (read-only), record-payment form, new-invoice form, reconcile page (static).
- **Gap:** no action buttons on payment detail; no void button on invoice; reconcile shows problems but doesn't help resolve them; receipts not generated; payment-link management half-written; no link to record payment / issue invoice from student profile (deep-links already exist on the student profile — good).

### 7.3 SCHOOL_ADMIN
- Same financial access as FINANCE_OFFICER, plus member management and org settings. Already supported by the authorization matrix; M6 does not need to differentiate admin vs. bursar on financial screens.

### 7.4 STAFF
- **Need:** see their own dashboard, not financial data.
- **Exists today:** STAFF sees only `dashboard.read`; all financial pages return `AccessDenied`.
- **Gap:** when a staff member lands on `/invoices` etc. via URL, the AccessDenied screen is already shown. Continue to respect this in M6.

### 7.5 Parents / Payers
- **Need for M6:** only a printable invoice (already at `/preview/invoice/[id]`) and a shareable payment-link page that tells them how much to pay and where to transfer.
- **No parent auth portal in M6.**

### 7.6 Mobile / unreliable-network behaviour
- Existing patterns already use responsive grid (`md:hidden` card lists, `sm:` breakpoint actions), tabular-nums for money at readable sizes, and large enough tap targets.
- M6 forms will follow the `/students/new` and `/payments/new` pattern: single-column on mobile, two-column on larger screens; submit button disables on click and shows loading state to prevent duplicate submits; server returns 409/400 rather than mutating on double-submit. CSRF + idempotency keys are additional guards.
- No offline/PWA behaviour in M6.

---

## 8. M6 Gap Analysis

### 8.1 MUST BUILD (required for M6 "operating experience")
| ID | Capability | Why must |
|---|---|---|
| M1 | Fix dashboard KPIs to be current-term scoped (or clearly labeled "all-time") | Trust — UI says "the term" but shows all-time; this is the most visible page. |
| M2 | Invoice void + issue-draft API + UI buttons | Without void a typo persists forever; bursar cannot correct mistakes. Issue-draft completes the draft→issued path (invoices can in theory be drafted and later issued even though `/invoices/new` auto-issues today). |
| M3 | Payment confirm/allocate/reverse action forms on payment detail | APIs exist; page is inert. Without these, bursar must use curl/direct API. |
| M4 | Reconcile page actions (deep-link or inline controls) | Workbench must resolve items, not just list them. Inline buttons that open the payment detail with the right action preselected is the honest-M6 answer. |
| M5 | Receipts done properly (issue receipt row on first print, render from `receipts` table, gate on CONFIRMED+non-void; void-receipt action if needed) | The current uncommitted `/receipt` page is computed ad-hoc, bypasses the receipts table, and issues no receipt number. This creates a competing source of truth for receipts. |
| M6 | Classes list API (read-only) | Dropdown dependency for fee assignments and per-class visibility; blocks M7. |
| M7 | Student PATCH (basic fields) + archive/restore API & UI | Daily operations — correcting names, withdrawing students — uses existing permissions and existing status enum. |
| M8 | Payment-links management (fix buggy revoke, add list+create UI at `/payments/links`, copy-to-clipboard URL) | Schools give parents URLs; must work. |
| M9 | Public `/p/[token]` page (bank-transfer instructions + teller reference form → PENDING payment) | Realities of Nigerian banking: most payments are bank transfers. The link page must not fake a PSP. |
| M10 | Navigation & permission polish (AccessDenied on every new page, correct nav items, empty states, mobile) | Coherence with M1 design system. |
| M11 | Re-run full verification chain (tsc, build, 187+ tests, new tests for M6 surfaces, fresh migrations, secret scan, git clean) | Quality gate required by directive. |

### 8.2 SHOULD BUILD (fits M6 if time, does not gate the experience)
| ID | Capability | Why should |
|---|---|---|
| S1 | Fee definitions CRUD API + simple list page under Settings → Fees | Schools have more than one fee head; avoids retyping. |
| S2 | Fee assignments per class/term API + management UI | Makes fee heads apply to a class/term; feeds dropdown in `/invoices/new`. |
| S3 | Idempotency-Key support added to void/confirm/allocate/reverse/issue/receipt endpoints | Defensive against duplicate submits on slow networks. |
| S4 | `accessDeniedTitle` contextualization on each page | Minor UX polish. |
| S5 | Payment detail page: when status=PENDING, surface Confirm call-to-action prominently; when unallocated>0, surface Allocate form | Discoverability. |

### 8.3 DEFER (M7+)
- Bulk invoice generation from fee assignments (whole-class billing at term start).
- Invoice reminder/dunning (SMS/WhatsApp/email).
- Exports (CSV/PDF financial reports).
- Parent/guardian authentication portal.
- Guardian CRUD UI (schema exists; UI deferred).
- Class enrollment UI.
- Real Paystack/Monnify PSP integration (webhook_events table exists; consumer deferred until real key).
- Audit log viewer UI (data is already recorded).
- Custom roles.
- Multi-currency support.
- Term/session/class management UI beyond seed.

### 8.4 DO NOT BUILD (would violate constraints)
- Any second ledger / cached balance table outside the trigger-maintained columns.
- Client-side authorization checks (e.g. `if role==='OWNER'` in components to gate content instead of server-side `checkPermission` + `AccessDenied`).
- Silent "recalculate balances" endpoints — any discrepancy is a bug to fix, not a button to press.
- Fake PSP or simulated Paystack flow on the payment-link page.
- Decorative SaaS widgets (charts for their own sake, avatar galleries, onboarding wizards unrelated to money).
- Silent mutation of M2 triggers or status enums.
- A service layer that wraps repositories without a concrete need — M2/M4 architecture has service logic in DB triggers + route handlers.

---

## 9. Architecture Impact

For each MUST/SHOULD item:

| ID | DB migration? | New repo method? | New API route? | New page/UI? | Authz change? | Audit? | Idempotency? | Concurrency? | Financial invariant change? |
|---|---|---|---|---|---|---|---|---|---|
| M1 | No | No | Modify `/api/dashboard/summary` | Minor label/KPI | No | No | No | No | No |
| M2 | No | Use existing `invRepo.voidInvoice`/`issue` | PATCH `/api/invoices/[id]` (void, issue) | Button + confirm dialog on invoice detail | No (uses existing actions) | Yes (already in repos) | Add `Idempotency-Key` | No (triggers + single-row UPDATE) | No (triggers enforce) |
| M3 | No | No existing allocate/confirm/reverse repos; APIs already exist; wire UI | No new API | Client form in payment detail | No | Already in APIs | Add `Idempotency-Key` support to APIs if missing | Allocation trigger uses `SELECT … FOR UPDATE` semantics | No |
| M4 | No | No | No | Reconcile buttons deep-link/trigger actions inline | No | Yes (via M3) | No | No | No |
| M5 | No (table exists) | Use `receipts.issue`; add `findByPaymentActive` helper | POST `/api/receipts/issue` (or issue-on-first-print) | Refactor `/payments/[id]/receipt` to render from receipt row; add void-receipt endpoint | Actions exist | `receipt.issue`/`receipt.void` audit events | Issue-once-per-payment (unique index or application check) | No (append-only) | Issuance must be gated to CONFIRMED non-reversed payments with allocated>0 OR unallocated>0 (valid); forbid against REVERSED/FAILED |
| M6 | No | Use `classes.listForOrg` | GET `/api/classes` | No UI page (dropdown only) | Uses existing `class.read` | No | No | No | No |
| M7 | No (status enum exists) | Add `students.update`, `archive`, `restore` methods | PATCH `/api/students/[id]`, POST `/[id]/archive`, `/restore` | Edit form + archive button on student profile | Actions exist | Yes | Optional | No | Status transition trigger enforces allowed transitions |
| M8 | No | Fix `revoke` route signature; add `listForOrg` | Fix PATCH `/api/payment-links/[token]`; tighten GET | `/payments/links` page | Actions exist | `payment_link.revoke/create` audit (repo likely needs audit call added) | Create endpoint: idempotency useful but not required (token is random); revoke is naturally idempotent | No | No (links are non-financial; they don't move money) |
| M9 | **RLS policy for `payment_links` token-only read + minimal public GUC setter function** | Use `linkRepo.findByTokenPublic` | No new API (page is RSC that reads link) | `app/p/[token]/page.tsx` | Public surface; token as bearer secret | Audit when a PENDING payment is created from the public page | PENDING payment creation uses existing idempotency; add `idemKey` from reference+token | No (inserts a PENDING record only) | No — no confirm/allocation from public page |
| M10 | No | No | No | Nav, empty states, AccessDenied | No | No | No | No | No |
| M11 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| S1 | No (table exists) | Use `fee-definitions` repo | GET/POST `/api/fee-definitions`, PATCH archive | `/settings/fees` definitions section | Uses `fee_definition.manage` | Yes | Optional | No | No |
| S2 | No (table exists) | Use `fee-assignments` repo | GET/POST `/api/fee-assignments`, PATCH archive | Same page | Uses `fee_assignment.manage` | Yes | Optional | No | No |
| S3 | No | No | Modify existing routes | No | No | No | Yes | No | No |

**Total new migrations: 1** (the public-GUC helper + RLS policy for payment_links public lookup, scoped to READ with no membership). No other schema changes. No financial trigger changes.

---

## 10. Dependency Graph / Build Order

The order below is deliberately chosen so each step keeps `tsc && next build && vitest` green.

1. **M1 — KPI term scoping.** One file (`/api/dashboard/summary`), touches no other surface; verifies understanding of term-vs-org scope before anything else.
2. **M6 — Classes list API.** Small, dependency-free; unlocks dropdowns needed by S2 (fees).
3. **M7 — Student update/archive/restore.** Required before student profile is "complete"; uses existing status enum and triggers.
4. **M2 — Invoice void + issue-draft API & UI.** Completes the invoice lifecycle UI.
5. **M3 — Payment confirm/allocate/reverse forms on payment detail.** Completes the payment lifecycle UI; reconcile (M4) relies on these actions existing.
6. **M5 — Receipts done right.** Adds receipt API and rewrites the uncommitted receipt page to render from `receipts` rows; depends on payment detail (M3) because the "Print receipt" CTA lives there.
7. **M9 migration first** (public-GUC helper + RLS policy). **Then M8 — payment-links management (fix revoke, list page). Then M9 page** (`/p/[token]`). The public page depends on both the migration and the link-management flow to be testable.
8. **M4 — Reconcile page actions.** Wire deep-links/inline CTAs that route into payment detail confirm/allocate flows from M3.
9. **S1+S2 — Fee definitions + assignments** (if time permits after M1–M9 verification). Simple CRUD; feeds dropdowns in `/invoices/new`; not gating.
10. **M10 — Polish:** nav items, empty states, AccessDenied on every page, mobile QA, CSRF/loading state on all new forms, toast notifications for success.
11. **S3 — Idempotency-Key on remaining mutating endpoints.** Defensive.
12. **M11 — Verification chain:** tsc, build, vitest (existing 187 + new M6 tests), new tests per §14, fresh-migrate DB, secret scan, clean git state, tag `M6-FINAL`, record SHA.

---

## 11. Risk & Failure-Mode Analysis

| ID | Risk | Consequence | Control |
|---|---|---|---|
| R1 | Dashboard KPIs labeled "term" but computed org-wide all-time | Proprietor makes wrong decisions; trust erosion | M1 — current-term scoped via `termRepo.getCurrent()`; label "Current term". All-time view deferred. |
| R2 | Voiding an invoice that has payments applied | Triggers will block (paid_kobo>0 ⇒ can't void); API must return a clear 409 instructing bursar to reverse allocations first | Verify `invRepo.voidInvoice` preconditions; surface in UI as "Reverse payments before voiding" rather than a raw SQL error |
| R3 | Double-clicking "Confirm" double-confirms | Idempotency-Key on client (random per form render + localStorage dedupe) + server idempotency acquire in transaction; status machine allows PENDING→CONFIRMED only once (trigger blocks CONFIRMED→CONFIRMD) | Add S3 idempotency on confirm/allocate/reverse; client button disabled after first click |
| R4 | Buggy `/api/payment-links/[token]` PATCH signature | Revoke 500s; links un-revokable | Rewrite using standard `withAuthorizedRoute({...}, handler)` shape with params resolved before wrapping (match `/api/invoices/[id]` pattern) |
| R5 | Uncommitted receipt page issues no receipt row | Receipt numbers aren't auditable; duplicate prints get different implicit IDs; no record of who issued | M5 — issue a `receipts` row on first print; render from that row; void → new receipt; receipt numbers become immutable |
| R6 | Public `/p/[token]` leaks PII or allows cross-tenant enumeration | Family privacy breach; cross-org data leak | Strict RLS policy allowing READ of ONLY the matched payment_links row and the specific invoice/student/org rows it references; PII capped at first name + last initial; token is 24-char nanoid (2^128 search space); constant-time lookup not required but unique index limits to one row; generic 404 for revoked/expired/unknown to avoid token enumeration |
| R7 | Public `/p/[token]` records a payment without auth and creates a drain for garbage | Junk PENDING payments; easier to forge | Require minimal fields (amount, payer name, teller reference) all validated; payment is PENDING only — no allocation, no confirmation, no financial effect beyond a pending row; rate-limit by token+IP (reuse existing rate_limits table) |
| R8 | Archive/restore of a student skips status trigger | Invalid status transitions | Use generic `trg_enforce_status_transitions` which is already applied to all enum-status tables by migration 0001; repository `archive()`/`restore()` sets status + timestamp; transactional |
| R9 | Over-allocation when allocating from UI | Invariant breach (payment unalloc <0 or invoice paid > total) | Trigger enforces (proven in `financial-invariants.test.ts`); UI clamps client-side to `min(input, remaining)`; server clamp is authoritative |
| R10 | Partial transaction failure (e.g., allocations written but audit event fails) | Inconsistent DB | All multi-statement mutations wrapped in `db.transaction` (already used in POST /api/payments, /api/invoices); triggers are DML-side and run in the same tx |
| R11 | CSRF token missing on new client forms | 403 on submit | All mutating `fetch()` calls use `csrfHeaders()` helper; verified by existing m4 pentest tests |
| R12 | Stale frontend after navigation | Client sees old balance | All list/detail pages are Server Components with `cache: 'no-store'`; client forms call `router.refresh()` after mutation |
| R13 | Race between two bursars allocating the same payment | Over-allocation | Trigger uses `SELECT ... FOR UPDATE` on payment row (proven by `tests/db/concurrency.test.ts`) |
| R14 | Connection pool leaks tenant GUCs | Cross-tenant data leak | `withTenant` `finally` block RESETs GUCs even on throw; pool is pinned to 1 connection for GUC safety in test (production note: ensure pool is sized so that GUC lifetime = connection lifetime and finally always runs) |
| R15 | Fee definitions/assignments create paths that bypass invoices.total_kobo invariant | Could produce inconsistent invoice totals | S1/S2 only produce metadata (templates); actual invoice creation still flows through `invRepo.createDraft` + `lineRepo.addLines` + `invRepo.issue` path which fires all existing triggers unchanged |
| R16 | Receipt issued for REVERSED/FAILED payment | Invalid receipt | M5 — status check on server; render 403 with explanation if payment.status ≠ CONFIRMED; no receipt row is created in that case |
| R17 | Payment link page shows bank details that are not stored anywhere | Currently `organizations` schema doesn't have bank-detail columns | Hard-code a placeholder "Contact the school for bank details" OR add bank-detail fields to org settings. **Decision in §15:** use placeholder + note that bank details live in Settings for M7; do not add a migration for this in M6. |
| R18 | Uncommitted reconcile page has no authz bug | Read-only surface behind checkPermission('payment.confirm'); verify when wiring actions | Server-side permission guard already present; will preserve |

---

## 12. M6 Non-Goals (explicit)

1. **No live PSP integration.** Payment links record PENDING payments for manual reconciliation.
2. **No bulk / batch invoice generation.** Fee assignments exist as templates only; one invoice at a time in M6.
3. **No parent/guardian authentication.** Parents interact only via the public `/p/[token]` link (bearer token).
4. **No communications sending (SMS/WhatsApp/email reminders).** `communications` schema exists but no sender; no provider integrations.
5. **No PDF receipt rendering.** Browser print via `window.print()` and print CSS is sufficient; a PDF pipeline is deferred.
6. **No CSV/financial exports.** Permission exists; rendering deferred.
7. **No custom-role editor.** Role matrix remains source code (git-auditable).
8. **No class enrollment UI.** Schema exists but no UI.
9. **No AI/ML/chatbot.** Not a financial tool.
10. **No generic "admin template" dashboards.** Every widget must answer a specific operational decision (§13).
11. **No general-ledger / expense tracking.** Scolaira remains accounts-receivable for a school.
12. **No silent balance repair.** Any discrepancy is investigated and fixed; there will be no "Recalculate balances" button.
13. **No changes to M2 financial triggers, M4 authorization matrix (other than potentially exposing actions already defined), or M3 idempotency semantics.**
14. **No multi-currency.** NGN/kobo-only.
15. **No database migration beyond the one required for public payment-link RLS (M9).**

---

## 13. Dashboard Widget Discipline

For every widget proposed on the Command Center, the decision it supports:

| Widget | Question it answers | Decision enabled | Authorized |
|---|---|---|---|
| Billed (current term) | How much have we invoiced parents this term? | Set collection target; judge billing completeness. | dashboard.read (all roles) |
| Collected (current term) | How much cash has actually landed against those invoices? | Assess bursar performance; judge bank position. | 〃 |
| Outstanding (current term) | How much are we still owed? | Prioritise follow-up. | 〃 |
| Overdue (current term) | Of that owed, how much is past the due date? | Escalate; chase specific parents. | 〃 |
| Unreconciled payments (count) | How much did the bursar log as pending that hasn't been confirmed? | Reconcile today. | 〃 |
| Active students | How many students are we billing this term? | Sanity-check the roster vs. billing base. | 〃 |
| Collection rate % | What share of billed have we collected? | Single health metric for proprietor. | 〃 |
| Attention list (top 3 overdue, pending payments, draft invoices) | What will age into a problem if I don't act today? | Direct navigation to the specific invoice/payment. | 〃 |
| Activity feed (last 6 payments/invoices) | What just happened? | Trust that money moving is visible. | 〃 |

Widgets explicitly rejected for M6: bar-chart of daily collections (insufficient data volume for a small school); pie-chart of payment methods (decorative); "projected revenue" (speculative); attendance stats (out of scope); class rankings (not financial); year-on-year comparison (single-tenant early).

---

## 14. Verification Contract

To close M6, the following must be executed and pass. I will honestly report each as VERIFIED or NOT VERIFIED in the M6 closeout.

### 14.1 Automated (VERIFIED in CI-equivalent sandbox)
- [ ] `tsc --noEmit` — zero errors.
- [ ] `next build` — production build succeeds; all new routes compiled as λ or ○.
- [ ] Vitest full suite: existing 187 tests must still pass (no M2/M4/M5 regressions).
- [ ] **New M6 tests** added (minimum):
  - Invoice void: happy path; void an invoice with paid balance (must fail); void an already-void invoice (idempotent/error); void requires invoice.void permission; cross-tenant void blocked.
  - Payment actions from UI perspective (allocate/confirm/reverse) — integration tests against API (in addition to existing trigger tests) to confirm HTTP boundary honors authz + idempotency.
  - Receipt: cannot issue against PENDING/REVERSED/FAILED; issuing twice for same payment returns same receipt (idempotent/void-and-reissue); receipt renders with correct totals.
  - Payment links: create/list/revoke lifecycle; revoked token returns 404 on public page; expired token returns 404; public page does not leak unrelated students.
  - Public `/p/[token]` submission creates PENDING payment and does not allocate.
  - Student archive/restore: status transitions enforced; non-owner/non-admin roles blocked.
  - Classes list requires class.read; cross-tenant blocked.
  - Dashboard KPI term scoping: invoice in non-current term excluded from KPIs.
- [ ] Financial invariants: re-run `tests/db/financial-invariants.test.ts`, `financial-attacks.test.ts`, `concurrency.test.ts` — all must pass unchanged.
- [ ] Tenant isolation: re-run `tests/db/tenant-isolation.test.ts`, `tests/auth/rls-bypass-regression.test.ts` — must pass.
- [ ] Authz matrix: `tests/auth/authz.test.ts` extended for new endpoints; all 29 existing tests still pass.
- [ ] Idempotency: existing `tests/db/idempotency.test.ts` passes; add coverage for new endpoints where idempotency is supported.
- [ ] Fresh DB: `dropdb`/`createdb` → migrations from 0 → all applied; seed runs; integration suite passes.
- [ ] Secret scan: grep for hard-coded keys, `.env` references committed, private keys — none.

### 14.2 Manual (VERIFIED by exercising in running dev server)
- [ ] Walkthrough: create student → issue invoice → record payment (bank transfer, pending) → confirm payment → allocate → print receipt — end-to-end.
- [ ] Walkthrough: void an unpaid invoice; void a paid invoice must fail with instructional error.
- [ ] Walkthrough: reverse an allocation; verify balances unwind; verify payment status.
- [ ] Walkthrough: create a payment link, open it in an incognito window, submit teller reference → PENDING payment appears in reconcile; confirm + allocate; verify invoice paid.
- [ ] Walkthrough: cross-tenant — two seeded orgs; user in org A cannot fetch or mutate org B's invoices/payments/students/classes/payment links.
- [ ] Walkthrough: wrong-role access (STAFF on financial pages → AccessDenied).
- [ ] Walkthrough: CSRF — mutating fetch without x-csrf-token rejected.
- [ ] Mobile layouts at 375px width for the new forms (no horizontal scroll, touch targets ≥44px).

### 14.3 NOT VERIFIED (environmental limitations — must be reported honestly)
- Real-browser Playwright/Cypress E2E (not in repo; out of scope for M6 sandbox).
- Real-device iOS/Android testing.
- Real PSP webhook processing (intentionally deferred; no fake).
- Live multi-user network latency / concurrency under load (test concurrency is at the DB trigger level only).
- Backup/restore drill (documented limitation per M5).
- PDF receipt generation (browser print only).

---

## 15. Open Questions / Decisions Required

1. **Q1 (Bank details on payment-link page):** The `organizations` table does not have bank-account columns. Option (a) display a placeholder "Contact the school for bank details" in M6 and leave bank-account configuration to M7 settings; Option (b) add columns + migration + settings section in M6.
   - **Recommendation:** (a) placeholder in M6 to keep the migration surface minimal; clearly documented.
2. **Q2 (Dashboard scope):** Current-term vs. all-time toggle?
   - **Recommendation:** Current-term KPIs only for M6; add a small sub-label "Current term" on each KPI. All-time can be a reports-page item in M7.
3. **Q3 (Reconcile page inline actions vs. deep-links):** Inline allocate/confirm/reverse modals on the reconcile page, OR buttons that navigate to the payment detail page with the relevant action auto-opened?
   - **Recommendation:** Deep-links for M6 (honest; reuses the payment detail forms we will build in M3; avoids duplicating allocation logic).
4. **Q4 (Receipt issuance trigger):** Auto-issue a receipt row when payment first becomes CONFIRMED + allocated > 0, OR issue on first print/request only?
   - **Recommendation:** Issue on first print ("receipt of record" is created when the bursar/parent actually requests a receipt); auto-issuance on every payment produces receipts no one asked for. Issue button visible on payment detail for explicit issuance.
5. **Q5 (Student full-update scope):** What fields should PATCH /api/students/[id] accept?
   - **Recommendation:** firstName, lastName, middleName, gender, dateOfBirth, admissionDate (contact, class enrollment deferred); archive/restore via dedicated /archive and /restore POSTs (clear intent, matches members pattern).
6. **Q6 (Fee definitions/assignments scope in M6):** Include S1+S2 in MUST or SHOULD?
   - **Recommendation:** SHOULD; M6 can ship without them (bursars can still issue single-line invoices as they do today), but they materially reduce friction. Implement after M1–M9 if verification budget allows.

---

## 16. Proposed M6 Definition of Done

M6 is done when and only when:
1. **M1–M10 are implemented** per §8.1, with S1+S2 included if time permits after M11 verification passes.
2. **No new migrations** beyond the one public-link RLS helper.
3. **No modifications** to M2 financial triggers, M4 authorization POLICY (existing actions are sufficient), or M3 idempotency semantics.
4. **Every new mutating endpoint** goes through `withAuthorizedRoute`, enforces CSRF, writes an audit event, and is covered by at least one happy-path and one wrong-role/cross-tenant/invalid-state test.
5. **Every money number on every page** traces back to one of the §5 authoritative columns; no client-side balance math beyond formatting; no dashboard-specific ledger tables.
6. **Public `/p/[token]`** never reveals PII beyond first name + last initial + invoice amount, never mutates financial state beyond creating a PENDING payment, and is revocable instantly.
7. **Receipts** are rows in the `receipts` table with immutable numbers; the receipt page renders from that row; receipts cannot be produced for non-CONFIRMED payments.
8. **tsc, next build, vitest** all pass (existing 187 + new M6 tests).
9. **Fresh DB migration** succeeds; seed data boots the app; walkthroughs (§14.2) succeed manually.
10. **Working tree clean**, committed as `M6 FINAL` with an immutable SHA, tagged `M6-FINAL`.
11. **Closeout report** lists VERIFIED / NOT VERIFIED evidence honestly per §14.

---

## Pause Point

**M5 BASELINE: FROZEN** (`M5-FROZEN` tag → `0c66618`).
**M6 RECONNAISSANCE: COMPLETE** (this document).
**M6 IMPLEMENTATION: NOT STARTED** (beyond the prior-session scaffolding explicitly documented in §2.3, which will be reviewed, fixed, and extended during build).
**M6 BUILD AUTHORIZATION: AWAITING REVIEW.**

No new M6 feature code will be written until this report is reviewed. Questions Q1–Q6 in §15 can be decided at review time; reasonable defaults are documented so build can proceed if answers are deferred.
