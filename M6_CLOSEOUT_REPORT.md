# M6 Closeout Report — Financial Operations Hardening & Public Payment Links

**Status:** FROZEN ✅
**Date:** 2026-09-19
**M5-FROZEN SHA:** `0c66618e29e6179c80052a82c40f669979cef6b0` (tag `M5-FROZEN`, untouched)
**M6 FINAL SHA:** `7cb97c44339cc457d8035f28331df190986f1085`

---

## 1. Final Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ PASS — zero TypeScript errors |
| `npx next build` (production) | ✅ PASS — all routes compile, no errors |
| Full vitest suite | ✅ PASS — **217 tests / 217 across 20 test files** |
| `git status` | ✅ Clean after final commit |
| M5 tag | ✅ Still points to `0c66618e29e6179c80052a82c40f669979cef6b0` |
| Migrations applied | ✅ Both dev and test DB at migration 0018 (18 applied) |

### Test breakdown (20 files / 217 tests)

- **Pre-existing (187 tests across 19 files)** — tenant isolation, audit, webhook, rich-seed, idempotency, db-boundary, runtime-role-safety, auth flows, CSRF, rate-limits, RLS bypass regressions. All pass unchanged except one which was strengthened by M6 hardening (see §4).
- **M6 endpoint hardening (30 tests in `tests/auth/m6-hardening.test.ts`)** — covers every acceptance criterion from the M6 gate checklist:
  - **Invoices (6):** authorized issue, authorized void, void-paid-rejected (409), STAFF wrong-role (403), cross-tenant (403/404), idempotent replay.
  - **Payment links (6):** authorized create+list, STAFF wrong-role (403), cross-tenant isolation, revoke idempotency + post-revoke 404, expired link 410, invalid token 404.
  - **Receipts (6):** CONFIRMED+ACTIVE issue + idempotent replay + GET, PENDING rejected, CONFIRMED-with-no-allocation rejected (400), STAFF wrong-role (403), cross-tenant isolation (403/404), partial-allocation amount equals allocated kobo (not payment total).
  - **Students (6):** admin update, finance cannot update/archive/restore (403), archive then restore happy path, archive-with-outstanding-invoice (409), STAFF wrong-role (403), cross-tenant (403/404).
  - **Public /p/[token] (5):** ACTIVE view minimal-PII payload, invalid/revoked=404 expired=410 (no information disclosure), public submit creates PENDING only (no allocation/no confirm/no invoice mutation/no receipt + audit event), submit against invalid/revoked/expired fails with correct status, malformed body 400 validation.
  - **Dashboard KPI regression (1):** seeds a 2,000,000 kobo ACTIVE allocation in the current term and a 3,000,000 kobo ACTIVE allocation in a fabricated other term; asserts collectedKobo matches only the current-term total and the other-term 3M is excluded.

---

## 2. M6 Deliverables — Implemented

### 2.1 Receipts API (`/api/receipts`, `/api/receipts/[id]`)
- Receipt rows created via POST `/api/receipts` (FINANCE_OFFICER, paymentId), idempotent on payment_id (UNIQUE constraint; POST replays the existing receipt at 200).
- State gating: rejected (400/409) for PENDING payments, REVERSED payments, CONFIRMED payments with zero ACTIVE allocations.
- `receipt.amount_kobo` = sum of ACTIVE allocations for that payment (trigger-maintained via `trg_receipts_set_amount()`), NOT payment total — partial allocations do not misstate.
- Receipt numbers DB-assigned via `next_doc_number('RCP')` in `trg_receipts_assign_number()` BEFORE INSERT. No UI-side counter, no duplicate numbering path.
- Receipts tenant-isolated via standard `*_tenant_isolation` RLS; GET/POST both go through `withAuthorizedRoute`.

### 2.2 Printable receipt page (`/payments/[id]/receipt`)
- Server component. Loads payment via the authorized API, confirms CONFIRMED status, issues the receipt idempotently (POST → returns existing id if already ISSUED), then fetches and renders from the `receipts` table (not ad-hoc from payment) — preserving immutability and numbering.
- Clear error states for non-CONFIRMED and unallocated payments.

### 2.3 Public payment links (`/p/[token]/{view,submit}`, `/api/p/[token]/*`)
- **View** (GET `/api/p/[token]/view`): returns PII-minimal payload — organization name/address/phone, invoice number, student first name + last initial, balances. No email/phone/guardian data exposed.
- **Submit** (POST `/api/p/[token]/submit`): validates body (zod), resolves the link, enters public tenant context, inserts a PENDING payment via `payments_public_insert` policy (status='PENDING' only, method whitelist), writes a `payment.pending` audit event, clears context. Returns 201 with `paymentNumber`, NO allocations, NO confirmation, NO invoice mutation.
- Endpoints are fully unauthenticated (no cookie required), CSRF does not apply (GET is safe, POST has no session), RLS is the only line of defense and is intentionally narrow.
- Public-facing UI: `/p/[token]` landing page renders org/invoice info and a submit form.

### 2.4 Payment link management (`/api/payment-links`, `/api/payment-links/[token]`)
- CREATE requires FINANCE_OFFICER or OWNER; returns `{token, url:/p/{token}}`.
- PATCH status (REVOKE) idempotent.
- List scoped to organization via RLS; foreign orgs see zero links.

### 2.5 Student archive/restore + UI actions
- PATCH, POST `/api/students/[id]/{archive,restore}` require OWNER or SCHOOL_ADMIN.
- Archive returns 409 when the student has outstanding (non-void, balance>0) invoices.
- Student profile page conditionally renders `<StudentActions>` (archive/restore client component) based on `student.update` permission.

### 2.6 Invoice issue/void
- POST `/api/invoices` creates and ISSUEs invoices; idempotent via Idempotency-Key.
- POST `/api/invoices/[id]/void` requires FINANCE_OFFICER/OWNER; rejected (409) when paid_kobo>0; void itself is idempotent (replay returns 200 or 409 without double-state-change).

### 2.7 Dashboard KPI term-scoping fix
- `collectedKobo` is now filtered to ACTIVE allocations against invoices in the CURRENT term (`terms.is_current = true`), preventing prior-term allocations from polluting this term's collected figure.
- Regression test (see §1) proves the term filter actually narrows.

---

## 3. Migrations (M6 adds 0011–0018; total 18 applied)

| # | File | Purpose |
|---|---|---|
| 0011 | `public_payment_link.sql` | Public bearer-lookup policies for payment_links/organizations/students/invoices; helper views/functions (original — tightened in 0014–0018). |
| 0012 | `public_payment_submit.sql` | Narrow `payments_public_insert` (status=PENDING, whitelisted methods, org match) and `audit_events_public_insert` FOR INSERT; permits audit writes from public context. |
| 0013 | `public_context_fix.sql` | Adds `app.public_context='1'` GUC marker set ONLY by SECURITY DEFINER `auth_set_public_context`; updates `auth_is_tenant_authorized()` to accept public context when organization_id is set; updates context-clearing helpers. Fixes the first hardening finding (§4.1). |
| 0014 | `payment_links_public_lookup.sql` | Drops the over-broad `payment_links_public_token_lookup` policy from 0011; introduces SECURITY DEFINER `auth_resolve_public_link(token)` + `auth_set_public_link_token()` + a per-row GUC-gated replacement policy (`app.public_link_token = token`), fixing the second hardening finding (§4.2). |
| 0015 | `fix_public_link_functions.sql` | Casts enum `status` column to `text` in SECURITY DEFINER resolvers to match `RETURNS TABLE` types. |
| 0016 | `fix_public_link_resolver.sql` | Casts varchar `token` column to `text` in resolver return. |
| 0017 | `resolver_sets_token_guc.sql` | Moves the `app.public_link_token` GUC set INSIDE the SECURITY DEFINER body (before the SELECT), because the function owner (`scolaira_app`) does NOT have BYPASSRLS — even inside a SECURITY DEFINER body, RLS is enforced and the GUC must already be set for the row-gated policy to permit the lookup. |
| 0018 | `probe_sets_token_guc.sql` | Same fix for `auth_probe_public_link`. |

Migrations 0000–0010 are M1–M5 and remain untouched (only 0011–0018 add content for M6).

---

## 4. Security Findings & Hardening History

Two important security defects were discovered during the M6 hardening gate. Both are fixed and both fixes are covered by regression tests. This section records them as architectural history.

### 4.1 Public-submit RLS boundary

**Finding:** The initial public-submit handler set `app.organization_id` via `auth_set_public_context` and relied on a new `payments_public_insert` policy to permit the INSERT. The INSERT was rejected by `payments_tenant_isolation` WITH CHECK, which calls `auth_is_tenant_authorized()`. That helper required BOTH `app.user_id` and a valid tenant token, so when public context set only `organization_id` (no user), `auth_is_tenant_authorized()` returned FALSE and the insert was denied — even though the narrow public-insert policy was correct.

More subtly, the failure mode proved that WITH CHECK policies on a table are AND-ed, not OR-ed: adding a permissive policy does not override an existing restrictive one.

**Fix (0012 + 0013):** Introduced a dedicated public-context marker GUC (`app.public_context='1'`). This GUC is settable ONLY by the SECURITY DEFINER function `auth_set_public_context(orgId)` (public clients cannot set it via `set_config` because that would require ownership of the setting or superuser, and our runtime role is least-privilege). `auth_is_tenant_authorized()` was extended to return TRUE when `app.public_context='1'` AND `app.organization_id` is a valid UUID. This gates the existing tenant_isolation policy to accept public-context writes, and separate narrow policies on each table restrict what public context can actually do:

- `payments`: INSERT only, status must be 'PENDING', method must be in a whitelist (`BANK_TRANSFER` is what public teller submit uses), `organization_id` must match the GUC org.
- `audit_events`: INSERT only (for writing the `payment.pending` event).

There is NO public UPDATE/DELETE path on any financial table and no public SELECT path on payments, allocations, or receipts.

**Verification:** `public submit creates a PENDING payment only` test inserts through the real route and then verifies (under finance tenant context) that payment=PENDING, `unallocated_kobo=0`, zero allocations, invoice.paid_kobo unchanged, zero receipts, audit event present.

### 4.2 Payment-link anonymous enumeration

**Finding:** The first revision of 0011 shipped a public lookup policy:

```sql
CREATE POLICY payment_links_public_token_lookup ON payment_links
  FOR SELECT USING (_app_current_org_uuid() IS NULL AND status = 'ACTIVE');
```

The existing regression test `tests/auth/rls-bypass-regression.test.ts` ("bootstrap mode cannot access financial tables") caught this: under no-context/bootstrap mode, a `SELECT count(*) FROM payment_links` returned 7 instead of 0. Any anonymous caller could enumerate every ACTIVE payment link in the system — leaking token values, amounts, expiry dates, invoice_ids.

**Fix (0014–0018):** Replaced the broad predicate with a two-tier scheme:

1. **Per-call GUC gating.** A new GUC `app.public_link_token` holds a single token during resolution. The public SELECT policy now requires `current_setting('app.public_link_token', true) = token`, so at most one row is ever visible under empty context.
2. **SECURITY DEFINER resolvers.** `auth_resolve_public_link(token)` and `auth_probe_public_link(token)` are SECURITY DEFINER and are the only code paths that set `app.public_link_token`. They set it to the requested token (function-local, true → reset at function exit), perform the lookup, and return either the full link row (resolve) or a status string `MISSING/ACTIVE/EXPIRED/REVOKED` (probe) without exposing other columns.
3. **RLS inside SECURITY DEFINER.** Critically, the function owner `scolaira_app` does NOT have BYPASSRLS, so even inside the SECURITY DEFINER body, RLS still applies. The GUC must be set BEFORE the SELECT for the lookup to succeed — migration 0017 moved the GUC set inside the function body to fix this.
4. **Handler refactor.** Both `/view` and `/submit` handlers now begin with `clear_app_context()`, call the resolver, then call `auth_set_public_context(orgId)` for the narrow org-scoped queries (org/student/invoice lookups). No direct `select * from payment_links where token = $1` under empty context remains anywhere in the codebase.

**Verification:** the rls-bypass-regression test (pre-existing, now strengthened by this finding) again returns 0 for bootstrap-mode SELECTs on payment_links; the public-view and public-submit M6 hardening tests confirm ACTIVE→200, invalid→404, revoked→404, expired→410 with no additional disclosure.

---

## 5. End-to-End Workflow Evidence

The manual workflow specified in the M6 acceptance criteria is exercised through real Next.js route handlers via the in-process cookie-jar harness (same code path as HTTP: cookies → CSRF → getSession → authorize → withTenant → repo → DB triggers/RLS):

| Step | Verified by |
|---|---|
| OPEN INVOICE | `createInvoice` POST /api/invoices (FINANCE_OFFICER), 201, response includes totalKobo / paidKobo=0 |
| CREATE PAYMENT LINK | `createPaymentLink` POST /api/payment-links, 201, token format, url `/p/{token}`, status ACTIVE, listable |
| OPEN PUBLIC LINK NO SESSION | `callPublicView` (no cookie) → 200, payload PII-minimal (first name + last initial, invoice number, remainingKobo, org name) |
| SUBMIT PAYMENT (public) | `callPublicSubmit` (no cookie) → 201 PENDING; `paymentNumber` matches `^PMT-`; `amountKobo` correct |
| VERIFY PENDING | Post-submit SELECTs under finance tenant context confirm: status=PENDING, unallocated_kobo=0, 0 allocations, invoice.paid_kobo unchanged, 0 receipts, ≥1 `payment.pending` audit event |
| RECONCILE / CONFIRM | `recordConfirmedPayment` POST /api/payments with initialStatus=CONFIRMED + allocations (same path the reconcile UI uses for bank-transfer confirmation) — returns payment with correct unallocatedKobo |
| ALLOCATE | Allocations supplied inline with payment creation; verified via direct SQL that ACTIVE allocation rows exist and invoice paid_kobo is incremented by the trigger |
| ISSUE RECEIPT | POST /api/receipts → 201 with RCP- number and correct amount; second POST → 200 idempotent (same id) |
| OPEN RECEIPT | GET /api/receipts/{id} → 200 with receipt+payment data |
| PRINT PREVIEW | `/payments/[id]/receipt` is a server component page that compiles in production build, fetches payment, issues receipt idempotently, renders receipt of record |

A literal browser click-through was not performed in the sandbox (no interactive browser in this environment), but every link in the chain above goes through the identical handler middleware stack a real HTTP request would traverse.

---

## 6. Receipt Model Verification

| Property | Evidence |
|---|---|
| DB-assigned receipt number | `trg_receipts_assign_number` BEFORE INSERT trigger calls `next_doc_number('RCP')`; UI never supplies a number; test asserts `receiptNumber` matches `^RCP-` |
| One receipt per payment under M6 | UNIQUE constraint on `receipts.payment_id` WHERE status='ISSUED' (partial); idempotent replay test confirms second POST returns the same receipt id |
| amount = allocated, not payment total | Partial-allocation test: payment=3,000,000 kobo with one 1,500,000 allocation → receipt.amountKobo=1,500,000 (read from DB, not computed in UI) |
| Unallocated not misrepresented | `unallocated_kobo` on the payment is trigger-maintained; receipt.amount does not include it; UI prints only allocated amounts line-by-line |
| State gating | Tests confirm PENDING → reject, CONFIRMED + no ACTIVE allocation → reject, CONFIRMED + ACTIVE allocation → 201 |
| Tenant boundaries | RLS isolation; foreign org GET returns 403/404 |
| Printable correctness | Server-rendered receipt page (no client JS needed for print); org name/address, receipt number, payment number, per-invoice allocations, total, timestamp |
| No duplicate numbering in UI | No client-side counter exists; numbers come exclusively from DB trigger |

---

## 7. Intentionally Deferred Work

The following were scoped out of M6 and remain deferred. No work has been done on them in this milestone:

1. **Student profile-edit UI** — beyond the existing update of first/last names and the archive/restore actions delivered here, full profile editing (contacts, guardians, custom fields) remains a future milestone.
2. **Reconcile → Allocate query-param prefill** — the reconcile page does not pre-populate the allocation form from a payment-link or deep-link query parameter.
3. **Public rate-limiting** — `/p/[token]/view` and `/p/[token]/submit` do not yet have application-layer rate limiting. The infrastructure (`auth_clear_rate_limits()`, rate_limit GUCs) exists but is not wired to public endpoints.
4. **Payer email/SMS notifications** — no email or SMS is sent on public submission or on receipt issue.
5. **Historical-term dashboard navigation** — the dashboard always renders the current term's KPIs; there is no term picker for historical comparison.

These are candidates for M6.x or M7 after explicit prioritization.

---

## 8. Final Gate Commands (re-executed against the exact committed tree)

All three were re-run immediately before the freeze commit after `npm install` and re-provisioning the local Postgres (dev dependencies had been cleared by a sandbox restart):

```
$ npx tsc --noEmit
(exit 0)

$ NODE_OPTIONS="--max-old-space-size=4096" npx vitest run
Test Files  20 passed (20)
     Tests  217 passed (217)

$ npx next build
✓ Generating static pages
✓ Build completed successfully
```

---

## 9. Sign-off

- [x] All 217 tests pass (20 files)
- [x] TypeScript strictly clean
- [x] Production build succeeds
- [x] Public submit produces PENDING only — no allocation / confirm / invoice mutation / receipt
- [x] Receipts require CONFIRMED + ACTIVE allocation; partial-allocation amount correct
- [x] Receipt numbers DB-assigned; no UI-side counter; one-receipt-per-payment idempotent
- [x] RLS not weakened anywhere — two regressions found during hardening are fixed and regression-tested
- [x] Payment-link anonymous enumeration closed via SECURITY DEFINER + per-row GUC
- [x] Cross-tenant isolation verified for invoices, payment-links, receipts, students
- [x] Wrong-role (STAFF, FINANCE_ON_STUDENT_WRITE, etc.) rejections tested for every verb
- [x] Idempotency keys tested for invoice create, void, receipt issue
- [x] Dashboard KPI current-term scoped; other-term allocations excluded
- [x] Audit event written for public-submit PENDING creation
- [x] M5-FROZEN commit `0c66618` preserved (tag `M5-FROZEN` points to it; no amend/rebase)
- [x] No scope creep into deferred items
- [x] Migrations 0011–0018 applied cleanly to both dev and test databases
- [x] Working tree clean after final commit
- [x] M7 not started
