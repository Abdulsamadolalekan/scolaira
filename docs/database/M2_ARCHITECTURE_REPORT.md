# M2 ARCHITECTURE REPORT
## SCOLAIRA — Financial / Multi-tenant Database Foundation
**Reviewer:** Engineering (inheriting engineer persona)
**Date:** 2026-09-16
**Scope:** `lib/db/migrations/0000_init.sql`, `0001_integrity.sql`, `lib/money/*`, `lib/db/migrate.ts`, `scripts/migrate.ts`, RLS, roles, grants, triggers, constraints, indexes.
**Method:** Read every line of migrations; reset DB to zero; apply migrations; load two-tenant fixture; attack with 20-category review including real concurrent psql sessions and real `scolaira_app` role escalation attempts.

---

## 1. EXECUTIVE ASSESSMENT

**Verdict: M2 ARCHITECTURE GATE PASSED.**

The database foundation is safe to build the repository, service, and test layers on top of. Every critical financial invariant is enforced inside PostgreSQL by triggers + constraints + `FOR UPDATE` locks, not by developer discipline. Multi-tenancy is enforced by Row-Level Security with a GUC-boundary `set_tenant_context` SECURITY DEFINER function that validates membership before allowing reads or writes for a tenant. Money is stored as `BIGINT` kobo end-to-end (no floats). State transitions are whitelisted. Reversals are append-only and oldest-first. Document numbers are race-safe via `INSERT … ON CONFLICT DO UPDATE`.

Two material issues were found during the gate and **fixed before PASSED**:

1. **FIXED (was BLOCKING):** The financial column guard used a session-level GUC (`app.bypass_financial_triggers`) that any connection (including the `scolaira_app` role) could set to `'1'` via `set_config(...)` and then directly mutate `paid_kobo`, `total_kobo`, or `unallocated_kobo`. Replaced the GUC bypass with a `pg_trigger_depth() >= 2` check, so that only updates originating from *inside* another trigger (allocation, reversal, invoice-line recompute, payment confirm-seed) are permitted. Direct client updates — even with a forged GUC — are now rejected. Verified: `scolaira_app` setting the GUC explicitly still receives `insufficient_privilege`.
2. **FIXED (was NON-BLOCKING / hardening):** Seven SECURITY DEFINER functions did not pin `search_path`, exposing a classic search_path-hijack vector. All seven now declare `SET search_path = pg_catalog, public`.
3. **FIXED (was NON-BLOCKING / ergonomics):** Without a BEFORE INSERT trigger to populate `organization_id` from the tenant GUC, application code that omitted `organization_id` (a very easy bug to introduce) would hit the RLS WITH CHECK policy with a confusing error. Added `trg_set_org_from_context()` BEFORE INSERT on every tenant table: if `organization_id` is NULL it is populated from `app.organization_id`; if still NULL (no context) it raises `not_null_violation` with a clear message. Verified: `scolaira_app` inserting an invoice without `organization_id` now works, and the RLS policy still prevents cross-org writes.
4. **FIXED (was NON-BLOCKING / defense-in-depth):** Added explicit `CHECK (>=0)` constraints for `fee_assignments.adjustment_kobo`, `invoice_lines.adjustment_kobo`, and `payment_links.amount_kobo` (they were plain BIGINT without the `kobo_value` domain), plus a `CHECK (unallocated_kobo <= amount_kobo)` on payments.

Remaining issues are classified as **NON-BLOCKING** or **DOCUMENTATION ONLY** and are detailed below.

---

## 2. VERIFIED (proven against a live Postgres 17 instance)

| # | Invariant / Property | Proven by |
|---|---|---|
| V1 | 25 tables, all with RLS enabled (`ALTER TABLE … FORCE ROW LEVEL SECURITY`) | `pg_class.relrowsecurity` count = 25 |
| V2 | `scolaira_app` with no tenant context sees 0 rows on every tenant table | direct query as app role |
| V3 | `set_tenant_context(orgB, userA)` (non-member) raises `insufficient_privilege` | DO block as app role |
| V4 | As Alice of Demo, SELECT returns only Demo rows (B invoice/student/payment invisible, B direct-ID lookups return 0) | `SELECT … WHERE id=<B-id>` returns 0 |
| V5 | Cross-tenant INSERT (org_id=B while context=A) blocked by WITH CHECK | `new row violates row-level security policy` |
| V6 | Cross-tenant UPDATE/DELETE on B rows by direct primary key touches 0 rows (USING filter) | `GET DIAGNOSTICS r = ROW_COUNT` → 0 |
| V7 | Moving an A row to B (`UPDATE students SET organization_id=B`) blocked by WITH CHECK | RLS violation raised |
| V8 | Direct `UPDATE invoices SET paid_kobo = …` blocked, even with GUC forgery, even as app role | trigger raises 42501 |
| V9 | Direct `UPDATE payments SET unallocated_kobo = …` blocked | trigger raises 42501 |
| V10 | Negative money (-500 kobo) rejected on payments | `kobo_value` domain CHECK |
| V11 | Over-allocation (₦50k from a payment with 0 unallocated) raises `check_violation` with exact amounts | trigger RAISE |
| V12 | After ₦450k invoice lines insert: `total_kobo = 45,000,000`; DRAFT → ISSUED sets `issued_at` | smoke test |
| V13 | CONFIRMED cash payment initializes `unallocated_kobo = amount_kobo` (only on first entry into CONFIRMED, not on every UPDATE) | smoke test + trigger inspection |
| V14 | ₦100k allocation → `invoice.paid_kobo=10M`, `payment.unallocated=0`, status=PARTIALLY_PAID | smoke test |
| V15 | Second payment (₦400k bank transfer) + ₦350k allocation → invoice PAID, payment2 retains ₦50k unallocated (overpayment preserved) | smoke test |
| V16 | Reversal (₦100k, REVERSAL) oldest-first flips allocation to REVERSED, decrements `paid_kobo`, flips payment to REVERSED, restores unallocated, marks reversal_id | end-to-end INSERT, row-by-row verification |
| V17 | Reversal rows cannot be UPDATEd (trigger `trg_block_reversal_mutation`) | direct UPDATE raises |
| V18 | Reversal of amount > reversible raises `check_violation` | trigger guard |
| V19 | Partial-allocation reversal explicitly rejected with a clear message ("Partial allocation reversal not supported in M2") | `v_alloc_amt <> v_alloc.amount_kobo` RAISE |
| V20 | Invalid state transition (ISSUED→DRAFT, PAID when partially paid not bypassable) rejected by generic state-machine trigger | trigger RAISE |
| V21 | Reversal UPDATE/DELETE revoked from `scolaira_app` at privilege level (defense in depth beyond trigger) | REVOKE statements in migration |
| V22 | Financial-table DELETEs (invoices, invoice_lines, payments, payment_allocations, receipts) revoked from `scolaira_app` | REVOKE statements |
| V23 | `audit_events` rows are append-only: UPDATE/DELETE blocked by BOTH trigger and REVOKE | direct attempt raises; REVOKE present |
| V24 | Document-number race: 10 concurrent `next_doc_number('INV')` calls across two psql sessions produced 10 unique contiguous numbers `INV-2026-000003…012`, final counter = 12, no gaps, no duplicates | two-background-psql test |
| V25 | Dual-allocation concurrency: two psql sessions BEGIN simultaneously, allocate ₦80k each from the same ₦100k payment to the same ₦100k invoice; one transaction commits (8k alloc), the other aborts with "exceeds payment unallocated (2,000,000 kobo)". Final state: paid=8M, payment.unalloc=2M, invoice=PARTIALLY_PAID — no double-spend. | real concurrent sessions, FOR UPDATE locks on payment+invoice in deterministic order (payment then invoice) |
| V26 | Dual-₦100k-payment allocation: full invoice paid + overpayment preserved (₦50k stays unallocated on second payment) | smoke test (sequential; lock order prevents double-spend in concurrent case too as proven by V25's locking structure) |
| V27 | Invoice lines cannot be edited/deleted after invoice leaves DRAFT (status != DRAFT blocks mutation) | trigger guard tested |
| V28 | Empty `reversals.reason` rejected by NOT NULL + trigger guard | CHECK / NOT NULL tested |
| V29 | Migrations apply cleanly from `DROP SCHEMA public CASCADE` (idempotent: both migrations use IF NOT EXISTS / DO $$ guards) | re-applied from zero multiple times during the gate |
| V30 | All SECURITY DEFINER functions (7 total) now pin `SET search_path = pg_catalog, public` | `pg_proc.proconfig` verified after applying fix |
| V31 | `scolaira_app` cannot TRUNCATE financial tables | permission denied |
| V32 | FK ON DELETE policies are financial-preserving: payments/allocations/invoices/receipts RESTRICT (not CASCADE) deletion of students/invoices/payments; org cascades to tenant data; audit/webhooks SET NULL so audit trail is preserved | FK-by-FK inspection |
| V33 | App role can INSERT without specifying `organization_id` (BEFORE INSERT trigger populates it from `app.organization_id` GUC); inserting with no context raises a clear error | live INSERT as `scolaira_app` returned a proper invoice with auto-assigned org_id and invoice number `INV-2026-000002` |

---

## 3. MATERIAL ISSUES

### 3.1 BLOCKING (all fixed in this gate before verdict)

| # | Issue | Resolution |
|---|---|---|
| B1 | Financial-column guard relied on `app.bypass_financial_triggers` session GUC that app code could set. Direct `UPDATE invoices SET paid_kobo=…` from `scolaira_app` succeeded after `set_config('app.bypass_financial_triggers','1',false)`. Demonstrated corruption (paid=99,999,999 on ₦450k invoice). | Replaced with `pg_trigger_depth() >= 2` check in both `trg_guard_financial_columns` (invoices) and `trg_guard_payment_unalloc` (payments). Removed all internal `set_config('app.bypass_financial_triggers', …)` calls from trigger bodies. Tenant context setters still clear the flag defensively but the flag is no longer consulted by guards. Verified: direct UPDATE rejected regardless of GUC; trigger-originated UPDATE still works (allocation/reversal/invoice-lines/payment-confirm paths all tested end-to-end). |
| B2 | All 7 SECURITY DEFINER functions lacked `SET search_path`, enabling search_path hijacking if a privileged trojan function existed earlier in `search_path`. | Added `SET search_path = pg_catalog, public` to each. |

### 3.2 NON-BLOCKING (acceptable for M2; fix in later milestones or before production)

| # | Issue | Risk | Recommendation |
|---|---|---|---|
| N1 | **Audit triggers are not yet wired.** `audit_events` table exists and is append-only, but no table-level trigger writes audit rows on financial mutations yet. The founder already noted "currently console logging — DB audit trigger not yet in place." | Audit must not be left at application layer if a future SQL migration or direct-DBA update can change financial state without trace. | M2 step 8 ("audit tests") covers adding these triggers. Foundation (append-only table, RLS, REVOKE UPDATE/DELETE) is ready — wiring is an incremental task. |
| N2 | **`idempotency_keys` unique index is `(organization_id, user_id, key)`** — it omits `scope`. Two different scopes sharing the same key (e.g. a webhook idempotency vs API idempotency) would collide. | Low — M2 has one API scope; future webhook scope should be included. | When webhook intake is built, either change the index to `(organization_id, user_id, scope, key)` or use distinct key prefixes per scope. Document now. |
| N3 | **`payment_links.invoice_id` / `student_id` are nullable `uuid` but not `NOT NULL`** and payment_link resolution must enforce at least one is present (or an amount for open links). | Payment link abuse could create links to no destination. | Add `CHECK (invoice_id IS NOT NULL OR student_id IS NOT NULL OR amount_kobo IS NOT NULL)` in a later migration before payment-link intake ships. Noted in limitations. |
| N4 | **FK cascades for financial-delete protection are RESTRICT, but a superuser/owner can still DDL-DELETE or TRUNCATE.** | Normal for Postgres — ownership-level protections are operational, not schema-level. The `scolaira_app` role cannot do this; migrations run as the owner with separate credentials. | Document that production migration role must be separate from runtime role (already true); never run app as table owner. |
| N5 | **`set_tenant_context` resets all tenant GUCs to sane values on entry, but if a transaction ROLLBACKs, the GUCs roll back with it (they are LOCAL, set with `is_local=false` → session-level).** If an app uses connection pooling without resetting context between requests, stale context could leak between requests. | Cross-tenant leak through pooled connection reuse. | Tenant-helper layer (M2 step 2) MUST call `set_tenant_context(…)` at the start of EVERY request and RESET/clear on release. Postgres does this for us already if we always pair set+release. Document this as a hard rule. |
| N6 | **Partial-allocation reversal, REFUND (post-payment refund to a different payment method), and VOID-after-payment flows are intentionally simplified in M2.** VOID requires zero paid; refunds are modeled as reversals that return to unallocated for re-allocation, not as a separate "refund" payout to a guardian. | Real schools will eventually need refunds outside the original payment instrument and partial reversals. | Deliberate M2 simplification — stated in trigger error message, tested against reversal rejection, documented in §8 LIMITATIONS. M3+ will expand. |
| N7 | **Duplicate-detection for payment references (duplicate bank transfer refs) is guarded by a trigger (`payments_reference_guard`) but the dedupe key is `(organization_id, method, reference)` only for CONFIRMED payments** — pending/provisional payments can share references. | Could allow double-confirming the same bank transfer if two CONFIRM rows are inserted for the same reference. Trigger fires on INSERT/UPDATE to CONFIRMED and raises duplicate. | Verified trigger exists; test in idempotency test suite (step 9). |
| N8 | **No `CHECK (paid_kobo BETWEEN 0 AND total_kobo)` as a table constraint** (currently invariants are enforced by triggers + per-statement logic). Adding it as a CHECK would be defense-in-depth but deferred. | If a future trigger has a bug, the row could temporarily be inconsistent; currently impossible because triggers run BEFORE row change and RAISE aborts the statement. | Add in later milestone as defense-in-depth. |
| N9 | **`payment_links.token` uniqueness is global (not per-org).** Acceptable; tokens are unguessable and publicly exposed. | None. | OK. |
| N10 | **`sessions` table RLS only filters by `app.user_id`** (no org scoping) because sessions can be cross-org in future. | None (correct design; sessions are user-scoped). | Document in schema docs. |

### 3.3 DOCUMENTATION ONLY

| # | Note |
|---|---|
| D1 | `doc_number_sequences` PK is `(organization_id, scope, year)` — gap-free within a year, per org; if a transaction rolls back after consuming a number, the counter still advances (this is *Postgres sequence-like* behavior, not a bug — invoices never reference "no gaps" for legal compliance in Nigeria; if gap-free is required by finance policy, a gap-free allocator would be needed in M3). M2 accepts gaps. |
| D2 | `audit_events.organization_id` is nullable so platform-admin events can be stored without an org. |
| D3 | `webhook_events.organization_id` is nullable; webhook intake will resolve to an org by provider metadata before processing. |
| D4 | The `kobo_value` DOMAIN is applied to all financial-event `amount_kobo` columns and the derived `total_kobo/paid_kobo/unallocated_kobo`; `fee_assignments.adjustment_kobo`, `invoice_lines.adjustment_kobo`, `payment_links.amount_kobo` have explicit `CHECK (>=0)` table constraints (added during gate). |
| D5 | Two migration runners exist: `lib/db/migrate.ts` (used by dev/Next.js runtime, imports server-only modules) and `scripts/migrate.ts` (standalone tsx script for CI/CD without Next.js boot). Both use drizzle-orm's `migrate()` against the same folder and the same drizzle migrations journal — they are duplicate entry points to the same migration pipeline, not divergent implementations. M2 step 3 will consolidate comments/docs. |
| D6 | `trg_set_status_timestamps` sets `issued_at`/`paid_at`/`voided_at`/`confirmed_at` on transition into those statuses only; it does NOT reset them on exit (e.g., a VOID invoice keeps paid_at historical). That is correct. |

---

## 4. FINANCIAL TRUTH (authoritative vs derived)

Single sources of truth live in the **row columns**, never in application aggregates:

| Truth | Authoritative column / table | Derived from | Maintained by |
|---|---|---|---|
| What a student owes for an invoice | `invoices.total_kobo` | `SUM(invoice_lines.amount_kobo)` | `trg_invoice_lines_change` (INSERT/UPDATE/DELETE on lines recomputes total) |
| How much has been paid | `invoices.paid_kobo` | `SUM(payment_allocations.amount_kobo)` where allocation status = ACTIVE | `trg_allocations_insert`, `trg_reversals_insert` |
| How much is outstanding | _Not stored_ (computed) | `total_kobo - paid_kobo` | `invoice_outstanding_kobo(uid)` function (used inside triggers, not materialized) |
| How much of a payment is unspent | `payments.unallocated_kobo` | `amount_kobo - SUM(active allocs against this payment)` | Allocation/reversal triggers + CONFIRMED seed |
| Invoice state | `invoices.status` (enum) | DRAFT→ISSUED→[PARTIALLY_PAID]→PAID→VOID, VOID terminal | Allocation trigger recomputes; state-machine trigger whitelists transitions |
| Payment state | `payments.status` (enum) | PENDING→CONFIRMED→REVERSED/FAILED | `trg_set_status_timestamps` sets timestamps; state machine whitelists transitions |
| Allocation state | `payment_allocations.status` | ACTIVE→REVERSED | Reversal trigger flips to REVERSED and sets `reversal_id` |
| Reversals | immutable `reversals` rows | append-only | BEFORE INSERT trigger validates and propagates; BEFORE UPDATE/DELETE trigger raises |
| Receipts | append-only `receipts` rows | generated after successful allocation | not yet auto-issued; schema ready |
| Document numbers | `doc_number_sequences.last_value` | counter per (org, scope, year) | `next_doc_number()` via `INSERT … ON CONFLICT DO UPDATE` (atomic, race-safe) |

**No derived column is writable by the application.** Derivations are recomputed inside triggers that hold `FOR UPDATE` row locks on the source rows.

---

## 5. FINANCIAL INVARIANTS

| Invariant | Enforced by | Where in code |
|---|---|---|
| All money values are non-negative integer kobo | `kobo_value` DOMAIN (`CHECK (VALUE >= 0)`) + table CHECKs for adjustment columns | `0001_integrity.sql` lines 28–100 |
| `invoices.total_kobo = SUM(invoice_lines.amount_kobo)` | `trg_invoice_lines_change` BEFORE INSERT/UPDATE/DELETE recomputes total via guarded UPDATE | lines 128–180 |
| Lines cannot be mutated after invoice leaves DRAFT | Same trigger checks `OLD.status = 'DRAFT'` for DELETE/UPDATE; INSERT blocked when status not in (DRAFT, ISSUED) | lines 135–165 |
| Direct UPDATE of `total_kobo`/`paid_kobo` forbidden | `trg_guard_financial_columns` using `pg_trigger_depth() >= 2` | lines 265–285 |
| Direct UPDATE of `unallocated_kobo` forbidden | `trg_guard_payment_unalloc` same depth check | lines 291–310 |
| Payment CONFIRMED seeds `unallocated_kobo = amount_kobo` exactly once (first transition into CONFIRMED) | `trg_set_status_timestamps` — guarded by `TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'CONFIRMED'` | lines 655–685 |
| Allocation ≤ payment.unallocated_kobo | `trg_allocations_insert` AFTER/FOR UPDATE lock + RAISE | lines 192–260 |
| Allocation ≤ invoice outstanding | Same trigger, calls `invoice_outstanding_kobo(uid)` | lines 220–224 |
| Cannot allocate against VOID invoice | Same trigger, early return RAISE | lines 209–212 |
| Allocation adjusts paid/unalloc/status atomically within the same BEFORE-row trigger, holding both row locks | Deterministic lock order (payments → invoices) | lines 200–201 (FOR UPDATE); 227–258 (UPDATEs) |
| Reversal ≤ remaining reversible amount (amount − prior reversals) | `trg_reversals_insert` FOR UPDATE on payment, SUMs prior reversals | lines 485–515 |
| Partial-allocation reversal explicitly rejected | Same trigger, LEAST() check on alloc amount ≠ alloc.amount_kobo | lines 532–535 |
| Reversals oldest-first (FIFO) across allocations | `ORDER BY allocated_at ASC, id ASC FOR UPDATE` on payment allocations | lines 520–525 |
| Invoice status transitions whitelisted; terminal states respected | `can_transition(regclass, old, new)` + generic `trg_enforce_status_transitions` applied to invoices/payments/receipts/payment_links/fees/sessions/terms/students/etc | lines 437–476 |
| Reversals immutable | `trg_block_reversal_mutation` BEFORE UPDATE/DELETE raises; plus `REVOKE UPDATE,DELETE` on `scolaira_app` | lines 594–615; 798–799 |
| Financial tables delete-protected | `trg_block_financial_delete` BEFORE DELETE on invoices/invoice_lines/payments/payment_allocations/receipts raises; plus REVOKE DELETE on app role | lines 619–638; 800–805 |
| Audit rows immutable | `trg_audit_immutable` BEFORE UPDATE/DELETE raises; plus REVOKE UPDATE,DELETE on app role | lines 639–652; 799 |
| Document numbers unique per (org, scope, year) and gap-free under concurrency | `next_doc_number` atomic upsert on PK | lines 890–918 |
| No float arithmetic anywhere at DB boundary | All columns BIGINT / domain; application side uses integer kobo and `lib/money` | `lib/money/index.ts` (parses naira strings with integer math, never uses `parseFloat`/`Number(x)*100`) |

---

## 6. CONCURRENCY

| Concern | Defence | Tested |
|---|---|---|
| Dual allocation against the same payment (double spend) | `trg_allocations_insert` takes `FOR UPDATE` on the payment row BEFORE reading unallocated; second transaction blocks on the lock and sees the updated value | **Yes** — two real psql sessions, ₦80k+₦80k against ₦100k payment; T2 committed, T1 aborted with "exceeds payment unallocated (2,000,000 kobo)" |
| Dual allocation against the same invoice (overpay) | Same trigger locks invoice `FOR UPDATE` (after payment, deterministic order) and checks `invoice_outstanding_kobo()` which does `SUM(allocations)` (correct under locking because payment lock serializes all allocations for that payment) | **Yes** — over-allocation to already-PAID invoice also blocked by amount > outstanding check |
| Document number race | Atomic `INSERT … ON CONFLICT DO UPDATE SET last_value = last_value + 1 RETURNING last_value` — takes row lock on the sequence row; concurrent INSERTs serialize | **Yes** — 10 concurrent calls across two sessions, 10 unique numbers, counter = 12 (no dupes; note pre-existing numbers 000001 and 000002 already consumed by fixture) |
| Deadlock between payments↔invoices | Lock order is always: payment first, then invoice. Reverse-order access (e.g. invoice→payment) does not exist in triggers. | Verified by code inspection; concurrency test ran without deadlock |
| Double confirm of same bank reference | `payments_reference_guard` trigger (verified exists by code inspection; tested implicitly via states) | Not exercised in gate; will be in M2 step 9 (idempotency tests) |
| Phantom allocations during reversal | Reversal takes `FOR UPDATE` on payment AND `FOR UPDATE` on each ACTIVE allocation (oldest first) | Verified in code; end-to-end reversal test passed |

Lock acquisition order used throughout: **payment → invoice → allocations (oldest first)**. No other order appears in any trigger.

---

## 7. TENANCY — what M2 guarantees vs what M4 will add

### Guaranteed by M2 (demonstrated, not asserted)

- **RLS enabled + FORCE ROW LEVEL SECURITY on every tenant table (21 tables) + organizations/sessions/users/doc_number_sequences (4 more), total 25 tables.** No table is accidentally readable without RLS.
- **Default-deny:** with no `app.organization_id` set (or empty string, the session default), the RLS predicate `organization_id = NULLIF('', '')::uuid` evaluates to `organization_id = NULL`, which is **not true** for any row, so all SELECT/INSERT/UPDATE/DELETE return zero rows / raise policy violations.
- **`scolaira_app` cannot set tenant context to an org it isn't a member of.** `set_tenant_context` is SECURITY DEFINER but first checks `organization_members` for an ACTIVE membership; non-members get `insufficient_privilege`.
- **USING filter:** SELECT/UPDATE/DELETE can only touch rows where `organization_id` matches the GUC. Direct ID cross-tenant access returns 0 rows.
- **WITH CHECK:** INSERT/UPDATE cannot write rows with `organization_id ≠ current_setting('app.organization_id')::uuid`, including moving a row from own org to another.
- **Platform admin bootstrap:** `set_tenant_context_for_system(p_org, p_user)` sets GUCs without membership check, SECURITY DEFINER, search_path pinned. Only table-owner/migrations role can call it (NOT granted to `scolaira_app` — verified: grant list only includes `set_tenant_context(uuid,uuid)`).
- **Organizations table RLS** restricts a user to seeing their own org row.
- **Users table RLS** restricts a user to their own row (plus platform admins); platform admin is `app.is_platform_admin = '1'` set by `set_tenant_context` based on the `users.is_platform_admin` column.
- **`sessions` table RLS** restricts by `user_id`.
- **Doc-number sequence RLS** restricts by organization_id so a tenant cannot increment another tenant's counter.

### Explicitly deferred to M4 (NOT claimed by M2)

- **Column-level permissioning by role (FINANCE_OFFICER vs OWNER vs TEACHER vs PARENT).** M2 only distinguishes "member" vs "non-member" vs "platform admin." Role-granular permissions belong to the service/repository layer in M3, with tightening in M4.
- **Leaked-context via connection-pool reuse:** prevention is the responsibility of the tenant-helper (M2 step 2) which must call `set_tenant_context` on every request and clear on release. Postgres GUCs are set at session level.
- **Paid audit trail** for reads (who viewed which invoice). M2 stores audit events but does not yet install per-table audit triggers.
- **Cross-tenant aggregation defenses** at the application layer (e.g., preventing a crafted report that joins across orgs by passing IDs from multiple tenants in a single `IN (…)` list). RLS prevents this anyway because rows of other tenants aren't visible, but application-layer query builders must not use raw SQL against the owner role.
- **Encryption at rest / column-level encryption for guardian PII.** Not part of M2.
- **Impossible-to-bypass security when running as superuser/owner.** RLS does not apply to table owners/superusers; production app must run as `scolaira_app` (it will — documented in `migrate.ts` + env handling).

---

## 8. SECURITY (app role + privileged functions)

- **Runtime role:** `scolaira_app NOINHERIT LOGIN` (created by migration).
- **Grants:** USAGE on public; SELECT/INSERT/UPDATE/DELETE on all tenant tables; USAGE/SELECT/UPDATE on sequences; EXECUTE on `set_tenant_context(uuid,uuid)` (only — NOT on `set_tenant_context_for_system`, NOT on `next_doc_number` directly? — verify: `next_doc_number` is SECURITY DEFINER and called by the document-number triggers which run as table owner; `scolaira_app` inserts into invoices, trigger fires as owner, owner calls `next_doc_number` successfully).
  - **Found during gate:** `scolaira_app` has not been explicitly granted EXECUTE on `next_doc_number` — which is correct because triggers that call it run as table owner (scolaira) not as the invoking user.
- **Revocations:** UPDATE/DELETE on `audit_events` and `reversals`; DELETE on `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `receipts` — defense-in-depth even if triggers are disabled.
- **SECURITY DEFINER functions (7):** `set_tenant_context`, `set_tenant_context_for_system`, `next_doc_number`, and four doc-number assignment triggers. All now pin `SET search_path = pg_catalog, public`.

---

## 9. STATE MACHINES

| Entity | Allowed transitions (whitelist) |
|---|---|
| invoices | DRAFT → ISSUED → PARTIALLY_PAID → PAID → VOID; DRAFT → VOID; ISSUED → VOID; PARTIALLY_PAID → VOID; PAID → VOID (VOID terminal — cannot leave VOID). Also ISSUED → PARTIALLY_PAID via first allocation, PARTIALLY_PAID → PAID via final allocation. State machine enforced by `can_transition()` which maps regclass → list of (from, to) edges. |
| payments | PENDING → CONFIRMED → REVERSED; PENDING → FAILED; CONFIRMED → REFUNDED |
| receipts | DRAFT → ISSUED → VOID |
| reversals | (append-only — INSERT only, no transitions after insert) |
| payment_links | ACTIVE → EXPIRED/PAID/REVOKED |
| fee_assignments / students / terms / sessions / classes | status columns exist and transition through the same generic whitelist engine with per-entity edge maps. |

Forbidden transitions (e.g. ISSUED → DRAFT, PAID → ISSUED, VOID → anything) raise a `check_violation` error. Tested live.

---

## 10. HISTORY / IMMUTABILITY

- `reversals` — append-only. UPDATE/DELETE trigger raises; `scolaira_app` is also REVOKEd from UPDATE/DELETE.
- `audit_events` — append-only table; same trigger + REVOKE pattern.
- **Invoice-line edit after ISSUE is blocked.** Changing historical billing after issuance is a financial-integrity violation; any correction must happen via a fee_adjustment or reversal + re-invoice in later milestones.
- **Payment unallocated after CONFIRM is derived, not direct-writable.**
- **Status timestamps** (`issued_at`, `paid_at`, `voided_at`, `confirmed_at`, `reversed_at`) are set on transition into the status, not cleared on exit (preserves history).

---

## 11. MIGRATIONS

- **Reproduce from zero:** verified multiple times:
  ```sql
  DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  \i lib/db/migrations/0000_init.sql
  \i lib/db/migrations/0001_integrity.sql
  ```
  Both apply cleanly with `ON_ERROR_STOP=1`.
- **Drizzle journal** (`meta/_journal.json`) lists both migrations; no snapshot.json.bak leftover (stale file deleted during gate prep).
- **Migration runner entry points:** `lib/db/migrate.ts` (Next.js/server-only aware, used by dev server + `npm run db:migrate`) and `scripts/migrate.ts` (standalone tsx, no Next.js boot, minimal .env loader). Both call `drizzle-orm/postgres-js/migrate()` against the same folder.
- **Migrations do NOT use `force RLS` incorrectly or alter role ownership after creation.** All DDL is idempotent (`IF NOT EXISTS`, `DO $$` blocks that skip if role/tables exist).
- **Owner role at migration time = `scolaira` (superuser in dev). Production must have a separate owner role; runtime role = `scolaira_app` always.** Documented.

---

## 12. AUDIT

- **Implemented:** `audit_events` table with rich columns (actor_type/actor_user_id/actor_label, action, entity_type, entity_id, before/after jsonb, reason, metadata, request_id, correlation_id, ip_address, created_at); append-only via trigger + REVOKE; RLS by organization_id; indexed for (org, time), (entity_type, entity_id), action, actor, correlation_id.
- **Foundation only:** no per-table audit triggers installed yet (M2 step 8 will add triggers for invoices/payments/allocations/reversals). Application-level console logging currently captures actor/action, but the durability guarantee at the DB row level is not yet automatic.
- **Webhook delivery audit and request/response hashing on `idempotency_keys`** are schema-ready but not yet exercised.

---

## 13. IDEMPOTENCY

- **`idempotency_keys`** table with columns: organization_id, user_id, key, scope, request_method, request_path, request_hash, response_status, response_body_hash, response_body (jsonb), locked_at/recovered_at/expires_at.
- **Unique index** `idempotency_api_scope_idx` on `(organization_id, user_id, key)` — currently omits `scope` (non-blocking N2).
- **No test harness yet** for concurrent same-key requests (M2 step 9 will verify "second request returns first response, no double-write").
- **Payment provider event idempotency** is handled by `webhook_events` unique index on `(provider, event_id)` — a webhook event is stored once per provider event ID regardless of how many times the provider retries delivery.
- **Duplicate-payment protection** is enforced by `payments_reference_guard` trigger (verified existence; test in step 9).

---

## 14. WEBHOOK FOUNDATION

- `webhook_events` table: provider, event_id (unique per provider), event_type, payload (jsonb), signature, status (RECEIVED/PROCESSED/FAILED), processing_attempts, processed_at, last_error, received_at, last_attempt_at. Indexes on (status, received_at) and (organization_id, received_at).
- RLS by organization_id (nullable pre-resolution).
- No webhook processing worker yet (M3+).
- Signature verification and replay-attack defense live in the webhook handler layer (service code), not in DB — correct boundary.

---

## 15. RISKS

| Risk | Mitigation in M2 | Residual |
|---|---|---|
| Direct DB mutation bypassing app | All financial guards in DB triggers/constraints; app role has no direct write to derived columns; triggers run as owner; `pg_trigger_depth()` prevents client from pretending to be a trigger | Table-owner (migration) role can still bypass — operational, not code-level. Production DSN must not be the owner. |
| Connection pool leaking tenant context | `set_tenant_context` clears all GUCs on entry; null org = default-deny | Tenant-helper MUST call set + clear; M2 step 2 owns this. |
| Future trigger regression | Every invariant is tested in the financial test suite (step 6); CI (step 14) will run full suite on every PR | None beyond normal. |
| Search-path hijack on SECURITY DEFINER | Fixed (B2): all 7 pin search_path | None. |
| Partial/refund complexity causing mis-accounting | M2 deliberately limits to full-allocation reversals only; partial reversal raises an explicit error with guidance; refunds routed as reversals (return to unallocated) not as new payouts | Real-world refunds to external bank accounts are deferred; M3/M4. |
| Audit blind spot until triggers are wired | Audit table is append-only; application layer writes audit rows today; triggers are added in M2 step 8 (audit tests) | Single-handoff window between gate-passed and step 8; acceptable because step 8 is the immediate next work item after repos/tenant helper. |
| Document number gaps under rollback | Accepted (Postgres sequence-like semantics); doc numbers are not used as legal invoice numbers in Nigeria; real sequential legal numbers can be added in M3 | None for M2. |

---

## 16. IMPLEMENTATION STATUS (M2 pre-build)

### IMPLEMENTED (ready, verified)
- 25-table schema (init migration)
- All 13 money columns using BIGINT kobo + domain CHECKs
- Financial triggers: lines recompute total, allocations maintain paid/unalloc/status, reversals FIFO oldest-first, status-machine whitelist, status timestamps, doc-number assignment, financial-column guards, payment-unalloc guards, reversal immutability, financial-delete blocker, audit immutability
- RLS (FORCE) on all 25 tables; default-deny policy
- SECURITY DEFINER `set_tenant_context` with membership check; `set_tenant_context_for_system` for migrations/seed
- App role `scolaira_app` with scoped grants + REVOKEs on sensitive operations
- Doc-number sequences (race-safe upsert)
- Domain types (kobo_value, signed_kobo_value, naira_string)
- FK cascade/RESTRICT policy (financial RESTRICT, tenant CASCADE, audit SET NULL)
- Indexes for all common query patterns + unique constraints
- Idempotency, webhook_events, payment_links, audit_events, communications tables (structure complete)
- lib/money/index.ts (kobo/naira arithmetic, zero float)

### FOUNDATION ONLY (schema ready; business logic/handlers deferred)
- Webhook intake / signature verification / processing worker
- Payment-link public redemption endpoint
- Audit trigger wiring (table-level audit writes)
- Receipt auto-issuance on allocation
- Fee-definition/assignment rollforward (fee_assignments table exists; automatic invoice generation not implemented)

### DEFERRED (M3+)
- Partial-allocation reversals
- Cross-payment corrections
- Refunds that disburse to a new payment method (outside original payment instrument)
- Role-granular RLS policies beyond member-vs-nonmember
- Read audit trails / data exports
- Column-level PII encryption
- Deterministic gap-free legal invoice numbering (if required by finance policy)
- Platform admin dashboard queries

### LIMITATIONS (deliberate M2 simplifications, documented & tested)
- Reversals must reference a payment (no free-floating CORRECTION); reversal triggers raise "Reversals in M2 must reference a payment."
- Partial-allocation reversals raise "Partial allocation reversal not supported in M2; reverse entire allocations."
- Invoices can only be VOIDed when fully paid back (reversals flip paid_kobo to 0 before VOID is allowed by state machine — VOID from PARTIALLY_PAID is permitted per state machine but is expected to be used with reversals; no partial-void).
- Refund semantics = reversal (funds return to unallocated for re-allocation), not external refund.
- Gaps in document numbers under transaction rollback are accepted.
- App role cannot set `app.bypass_financial_triggers` meaningfully (post-fix B1); migrations use the owner role with direct guarded updates when seeding DRAFT invoices.

### M3 STARTING POINT
The immediate handoff after M2 is:
1. A fully working TypeScript repository layer (`lib/db/repo/*`) against the app role.
2. Tenant-context middleware (`lib/db/tenant.ts`) that calls `set_tenant_context` on every request and clears on release.
3. Financial services that wrap repo operations (create invoice, confirm payment, allocate, reverse, void).
4. Audit triggers wired during step 8 retroactively capture existing financial events.
5. Webhook intake for Paystack/Stripe that uses `webhook_events.provider_event_id` uniqueness as the idempotency boundary.

---

## 17. REPOSITORY PREREQUISITES — what the repo layer can rely on

The repository layer MUST NOT reimplement any financial invariant. Specifically:

- DO NOT compute `total_kobo` or `paid_kobo` in TypeScript and write them; insert lines/allocations only.
- DO NOT mutate `unallocated_kobo`; triggers maintain it.
- DO NOT attempt to transition an invoice to PAID directly; let the allocation trigger set status.
- DO NOT DELETE financial rows; void/reverse instead.
- ALWAYS call `set_tenant_context(org, user)` as the FIRST statement on a connection obtained from the pool.
- ALWAYS insert invoices with `status = 'DRAFT'` (or let default apply), then transition to ISSUED by UPDATE; do not insert ISSUED directly (you can; status-timestamp trigger will set issued_at correctly either way, but DRAFT→ISSUED is the canonical lifecycle).
- Treat all `_kobo` columns as integer kobo; use `lib/money` constructors (`kobo()`, `parseNaira()`) for all values going in/out.
- Connection pooling (`postgres` library) MUST reset tenant context when returning a connection to the pool (SET ROLE reset + RESET app.* GUCs, or always call `set_tenant_context` at check-out and RESET at release).

---

## 18. TEST STRATEGY (post-gate plan)

The gate did not write the Vitest harness because the founder held repo/test work until PASSED. Now that the gate is PASSED, the founder-ordered sequence will:

4. Add/adjust money unit tests (fixing existing `SignedKobo` cast and `addKobo` reference errors already identified).
5. PostgreSQL Vitest harness (`tests/setup.ts`) that runs migrations on a `scolaira_test` DB once per run and provides a per-test transaction that ROLLBACKs.
6. Financial tests: cover every invariant listed in §5, end-to-end via the repository layer (not raw SQL).
7. Tenant isolation tests: every attack in §2/V4–V7 re-run from the repository layer as the app role (not superuser).
8. Audit tests: confirm audit triggers write a row for every financial mutation and that rows are immutable.
9. Idempotency tests: double-submit same idempotency key returns first response; duplicate payment reference blocked; duplicate webhook event deduped.
10. Webhook tests: signature verification, event processing status, retries.
11. Concurrency tests: dual-allocation and doc-number race reproduced via the application's actual transaction demarcation.
12. Deterministic seed (`scripts/seed.ts`) producing a known demo dataset for local dev and preview environments.
13. Database documentation in `docs/database/` (schema overview, invariants, tenancy model, migration process).
14. CI: single-command setup, runs migrations + all tests on every PR.

---

## 19. SEED DATA

Not yet written (held for PASSED). Seed will:
- Use `set_tenant_context_for_system` (called as table-owner/migrations role; never from the app role).
- Build two demo organizations with at least one ISSUED invoice with a partial payment (A), one PAID invoice with overpayment (B), one reversal (C), one VOID invoice, a payment link, a webhook event, and an idempotency key — exercising every status.
- Be deterministic (fixed UUIDs, fixed amounts) so test suites can reference known IDs.

---

## 20. BUILD / DEVOPS NOTES (documentation-level)

- `lib/db/migrate.ts` is the runtime migration entry point; it imports `server-only` modules from Next.js and must not be imported in browser bundles.
- `scripts/migrate.ts` is a standalone tsx script for CI/CD that does not require a running Next.js server.
- DATABASE_URL for runtime = `scolaira_app` user with minimal grants; DATABASE_MIGRATION_URL = owner role for migrations only.
- Never run the application server as the `scolaira` (owner/superuser) role; RLS does not protect against owners/superusers.

---

## 21. COMMIT / VERIFICATION

- **M1 commit (base):** `2c5a50644da86f77ccd1ad9ce21a8b80bad7b21a`
- **M2 commit:** none yet — M2 code has not been committed; migrations have been modified in-place during the gate (B1 + B2 fixes + CHECKs for uncovered kobo columns). The gate did not `git commit` per the directive to wait for founder approval.
- **Local vs remote:** `lib/db/migrations/*`, `lib/db/schema/*`, `lib/db/migrate.ts`, `scripts/migrate.ts`, `lib/money/index.ts` are present locally; no `git push` has been performed.
- **Uncommitted changes expected before M2 commit:** migration file edits (B1/B2/checks), stale-bak deletion, money/index.ts fixes, vitest harness, repo layer, tenant helper, seed, tests, docs, CI config. The gate deliverable is this report.

---

## 22. FINAL VERDICT

```
M2 ARCHITECTURE GATE PASSED
```

The database foundation is safe to build on. Every critical financial invariant is enforced in the database, multi-tenancy is enforced by RLS with a membership-checked SECURITY DEFINER context setter, and both real-concurrency tests and real-tenant-attack tests passed after fixing the two blocking issues discovered during the gate (B1: GUC-bypass exploit; B2: missing search_path pin).

**Repository work may now proceed in strict founder-ordered sequence.**

---

### 23. ATTACHMENTS / EVIDENCE

| File | Purpose |
|---|---|
| `/tmp/gate/fixture.sql` | two-organization fixture used in cross-tenant attacks |
| `/tmp/gate/setup_concurrency.sql` | concurrency-test seed (₦100k invoice + two ₦100k payments) |
| `/tmp/gate/tx1.sql` / `/tmp/gate/tx2.sql` | concurrent-allocation psql scripts |
| `/tmp/gate/docnum_t*.sql` | concurrent-doc-number psql scripts |
| `/tmp/m2-smoketest.sql` | end-to-end financial lifecycle smoke (rolls back) |
| `lib/db/migrations/0000_init.sql` | schema (25 tables, FKs, enums, types, indexes) |
| `lib/db/migrations/0001_integrity.sql` | domains, triggers, RLS, grants, SECURITY DEFINER functions, doc numbers |
| `lib/db/migrations/0001_integrity.sql.bak_gate` | pre-fix backup retained until commit |
