# M5 Closeout Report — Core School Financial Operations

**Commit:** _(see `git log -1` after commit)_
**Date:** 2026-09-18 (Africa/Lagos)
**Scope:** Production-grade financial mutation endpoints (students, invoices, payments, allocation, confirmation, reversal, seed-current-term), idempotency, duplicate-reference guard, kobo-precise accounting, and reversal.

---

## Status Matrix

| Gate | Status | Evidence |
|---|---|---|
| TypeScript `tsc --noEmit` | ✅ VERIFIED | Exit 0, no errors. |
| Production `next build` | ✅ VERIFIED | Exit 0, all new routes compiled as ƒ (dynamic). |
| Migrations (10/10) | ✅ VERIFIED | `scripts/migrate.ts` applies 0000_init … 0010_lockdown_secdef cleanly on both `scolaira` and `scolaira_test` (custom runner in `drizzle.__drizzle_migrations`). |
| Vitest unit/integration | ✅ VERIFIED | **19 files, 187 tests — all passing.** Includes: authz, tenant-isolation, RLS-bypass regression, runtime-role-safety, financial-attacks, financial-invariants, state-machines, concurrency, db-boundary, audit, webhook foundation, idempotency, rich-seed, M4 pentest. |
| Financial lifecycle E2E (HTTP, DB-state verified) | ✅ VERIFIED | Custom node harness — **36/36 assertions passed.** Register → seed term → student → invoice → full payment → PAID → partial → overpay (unallocated held) → over-alloc 400 → duplicate non-CASH ref 409 → reversal (invoice reopens to ISSUED, paid=0) → dashboard identity. |
| Body-parsing defect (F1) regression | ✅ VERIFIED | Every POST route accepts and validates its body through `withAuthorizedRoute`'s `bodySchema` path (verified for invoices, payments, confirm, allocate, reverse, students, seed-current-term — no 500s). |
| Idempotency replay defect (F2) regression | ✅ VERIFIED | Same idempotency key + same body returns the same resource id and sets `Idempotent-Replayed: true`. Same key + different body replays the original (does not create new). No duplicate financial records. |
| Cross-tenant isolation | ✅ VERIFIED | Foreign org receives 404 on invoice GET, payment allocate, payment reverse. |
| CSRF / unauthenticated | ✅ VERIFIED | 401 without session; 403 without `x-csrf-token` header. |
| Duplicate non-CASH reference | ✅ VERIFIED | BANK_TRANSFER/POS/ONLINE duplicate reference → 409; CASH duplicates allowed (school reality). |
| M4 authorization regression | ✅ VERIFIED | All new routes flow through `withAuthorizedRoute` with a declared action; existing M4 pentest/RLS tests still pass. Runtime role `scolaira_app` remains NOSUPERUSER/NOBYPASSRLS (onconnect guard intact). |
| Mobile / real-device / network throttling | ❌ NOT VERIFIED | Desktop HTTP only. No real phone, no throttling. Marked honestly per directive. |
| Backup / restore | ❌ NOT VERIFIED | No pg_dump/pg_restore drill was executed; no backup target configured. Blocker: environment permissioning + no scheduled job. |
| Live PSP / webhook integration | ❌ NOT VERIFIED | DB-layer webhook primitives exist (idempotency, webhook_events table) and pass tests (`tests/db/webhook.test.ts`), but no PSP credentials, no outbound webhook handler, no live verification. |

---

## Defects Found and Fixed in M5

| # | Defect | Fix | Files |
|---|---|---|---|
| F1 | New POST routes registered without `bodySchema` → framework skipped `readJson(req)` → `body === undefined` → Zod threw "Required" → 500. | Added `bodySchema: <Schema>` to every new POST; added `EmptySchema = z.object({}).optional()` for parameter-only endpoints (confirm, seed-current-term). | `app/api/invoices/route.ts`, `app/api/payments/route.ts`, `app/api/payments/[id]/{confirm,allocate,reverse}/route.ts`, `app/api/students/route.ts`, `app/api/setup/seed-current-term/route.ts` |
| F2 | Idempotency replay path did `JSON.parse(existing.responseBody)` but drizzle returns jsonb columns already parsed → catch silently swallowed the error → a duplicate record was created on retry. | Detect string vs object; parse only when string. Same fix in both handlers. | `app/api/invoices/route.ts` (L156), `app/api/payments/route.ts` (L140) |
| F3 | `seed-current-term` used raw `db.execute(sql, params)` with stale imports. | Rewrote with drizzle `db.update().set().where(eq(...))`. | `app/api/setup/seed-current-term/route.ts` |
| F4 | `Kobo` branded type errors on payment amount fields. | Added `asKobo(n) => n as Kobo` helper; cast at record/allocate/reverse call sites. | `app/api/payments/route.ts`, `app/api/payments/[id]/{allocate,reverse}/route.ts` |
| F5 | Null-narrowing for `term` in invoices route defeated TS control flow. | Const-bind after null-check; assert after guard. | `app/api/invoices/route.ts` |

---

## Route Surface (added / modified)

| Method | Path | Action | Notes |
|---|---|---|---|
| POST | `/api/students` | `student.create` | Minimal create (studentId, name, gender, classId). |
| POST | `/api/invoices` | `invoice.create` | Create draft → add lines → issue; idempotent; returns {invoice}. |
| GET  | `/api/invoices/:id` | `invoice.read` | Detail (lines, allocations, activity) — existed pre-M5. |
| POST | `/api/payments` | `payment.record` | Record payment with explicit allocations; idempotent; duplicate-ref guard; overpay held as `unallocatedKobo`. |
| POST | `/api/payments/:id/confirm` | `payment.confirm` | Scaffolded; accepts empty body (PENDING→CONFIRMED approver flow deferred). |
| POST | `/api/payments/:id/allocate` | `payment.allocate` | Allocate unallocated portion of CONFIRMED payment to invoices; sum validation. |
| POST | `/api/payments/:id/reverse` | `payment.reverse` | Creates `reversals` row; deallocates; returns payment to REVERSED state. |
| POST | `/api/setup/seed-current-term` | `academic_session.manage` | Idempotent bootstrap of 2026/2027 + First Term. |

---

## Known Limitations / Deferred

1. `/api/payments/[id]/confirm` — full PENDING→CONFIRMED approver flow deferred (endpoint exists to lock the URL shape; the state transition + second-eyes authorization is M6+).
2. Auto-FIFO allocation across open invoices is not implemented. Clients pass explicit `allocations: []`; overpay is held on the payment for later manual allocation.
3. CASH payments allow duplicate references (legitimate for anonymous cash collection at the school gate). Non-CASH references are guarded (409).
4. Idempotency-key body mismatch replays the original response (Stripe-style); no request-hash rejection yet.
5. **NOT VERIFIED (honest):** backup/restore, real-device mobile, live PSP integration, network throttling.

---

## Engineering Chain

Every new endpoint follows the mandated chain:

`UI → withAuthorizedRoute(action, bodySchema) → domain handler → db.transaction(tx) → repo calls (tenant ctx) → RLS → financial triggers/constraints → audit_events`

No handler accesses the DB outside the `withTenant` scope set up by `withAuthorizedRoute`; no handler reads organizationId/userId/role from the client body; all cross-resource access uses `assertResourceInOrg(ctx, resource, label)` before mutation.

---

## Repository State

- **HEAD at freeze time:** `beb5996537512a3b60aaff13d4eb60309b43cff2` (parent of the M5 commit).
- **M5 commit SHA:** recorded after commit.
- **Working tree at freeze:** only M5 files modified/added — no unrelated changes.
- **Build artifacts:** `node_modules/`, `.next/` gitignored; not committed.
