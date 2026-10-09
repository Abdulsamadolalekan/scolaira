# M2 — Implementation Plan (Database, Financial Truth &amp; System Foundation)

&gt; **Status:** PRE-IMPLEMENTATION PLAN. This document captures the existing state
&gt; and the planned approach before any M2 code is written. It will be updated
&gt; during implementation to reflect decisions made; deviations from this plan are
&gt; called out explicitly and added to `/docs/DECISIONS.md`.

---

## 1. What already exists (M0 + M1 baseline, commit `2c5a506`)

| Area | State |
|---|---|
| **Framework** | Next.js 15.5.25 (App Router), React 18.3.1, TypeScript 5.9.3 (strict), Tailwind 3.4.19, Zod 3.25.76 |
| **DB libraries** | `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `postgres@3.4.5` (the `postgres` JS driver) all installed in `package.json`; none wired into application code |
| **DB config** | `drizzle.config.ts` points at `./lib/db/schema/index.ts` and `./lib/db/migrations`; neither exists yet. `DATABASE_URL` env var supported by `lib/security/env.ts` |
| **DB stubs** | `lib/db/index.ts` exports `getDb(): never` which throws "M0 stub". `lib/db/migrate.ts` is a console.warn no-op |
| **Money** | `lib/money/index.ts`: `Kobo` (branded `number`), `NairaString`, `parseNaira`, `formatKobo`, `formatKoboDisplay`, `addKobo`, `ZERO_KOBO`. 15 unit tests. Does not yet support subtraction, negative kobo (reversals), allocation-safe arithmetic, or naira-&lt;-&gt;kobo serialization round-trip for boundary tests |
| **Errors** | `lib/errors/index.ts`: `ScolairaApiError` with `badRequest/unauthenticated/forbidden/notFound/conflict/invariantViolation/expired/unprocessable/rateLimited/internal` factories. Error codes include `INVARIANT_VIOLATION`, `IDEMPOTENCY_KEY_REUSE` |
| **Audit** | `lib/audit/index.ts`: `audit({action, entityType, entityId?, before?, after?, reason?, metadata?})` with swappable logger; current implementation logs to stdout in dev and is no-op in test. No DB writes yet |
| **Idempotency** | `lib/idempotency/index.ts`: UUID validation, `assertValidIdempotencyKey`, `generateIdempotencyKey`. No persistence yet |
| **Security** | `lib/security/env.ts` (server-only) reads all env vars; `lib/security/server-only.ts` re-exports `server-only`; CSP and security headers set in `next.config.ts` |
| **Middleware** | `middleware.ts` is a passthrough that returns `NextResponse.next()`; reserved for M3 auth and M4 tenant injection |
| **Instrumentation** | `instrumentation.ts` logs at startup; reserved for DB warm-up / Sentry |
| **Design system** | Complete (see `docs/design-system/M1_IMPLEMENTATION.md`): tokens, 19 primitives, NavShell, CommandCenter/ListPage/DetailPage templates |
| **Tests** | Vitest 30/30, Playwright 32/32, CI pipeline runs lint/typecheck/unit/build + Playwright smoke |
| **Docs** | Extensive planning docs exist (`DATABASE.md`, `FINANCIAL_TRUTH_MODEL.md`, `FINANCIAL_INVARIANTS.md`, `AUDIT_MODEL.md`, `CONCURRENCY_DESIGN.md`, state machines under `docs/state-machines/`, etc.) — these are the design reference; migrations + source are the source of truth |
| **Postgres (local)** | PostgreSQL 17 installed during M2 setup; `scolaira` (dev) and `scolaira_test` databases created; `DATABASE_URL`/`DATABASE_MIGRATION_URL`/`TEST_DATABASE_URL` in `.env.local` (gitignored) |

## 2. What M2 will introduce

M2 is the **data and integrity foundation**. It does NOT build product features
(invoicing UI flows, payment recording UI, authentication, Paystack webhook
processing). It establishes:

1. A real Drizzle + `postgres` driver client (singleton, server-only, validated on startup).
2. A full initial schema migration covering 23 entities (see §3).
3. A migration runner wired into `instrumentation.ts` (auto-migrate in dev only; production applies migrations explicitly via `npm run db:migrate`).
4. Tenant (organization) scoping infrastructure: typed `TenantDb` view, RLS policies, test helpers.
5. Domain types + enums matching approved state machines (mapped to Postgres enums).
6. Financial invariants at the DB layer (CHECK constraints + triggers for: invoice total = sum of lines, allocations ≤ payment remaining, allocations ≤ invoice outstanding, payment amounts positive, etc.).
7. Audit logging wired to DB (replacing the M1 console logger; batching within transactions).
8. Idempotency-key persistence + webhook-event persistence tables.
9. Money utility extensions (subtraction, negative-kobo for reversals, comparison, allocation helpers, comprehensive tests).
10. Repository/query layer (`lib/db/repo/*`) for the core operations needed by tests and future slices — NOT full service logic, just the persistence primitives that tests and M3+ services will compose.
11. Deterministic seed script (`npm run db:seed`) producing clearly-labeled DEMO data with two schools, students across terms/classes, fees, invoices in multiple states, payments across methods (cash/transfer/POS/online), partial/multi-invoice allocations, reversals, prior-term debt, unreconciled items.
12. Test infrastructure: ephemeral test DB per Vitest worker, schema migration before test run, transactional rollback between tests, factories for each entity.
13. Comprehensive automated tests: schema/constraint tests, money boundary tests, financial arithmetic tests, tenant isolation tests, concurrency tests (simulated via parallel transactions), state-machine transition tests, audit-log tests, idempotency tests.
14. Documentation under `docs/database/` per directive §22.

## 3. Schema decisions

**Source of truth:** the Drizzle schema in `lib/db/schema/*.ts` and the SQL
migration it generates (committed to `lib/db/migrations/`). The reference
documentation in `docs/DATABASE.md` and `docs/database/SCHEMA_REFERENCE.md` is
derived from those.

### 3.1 Table list (final M2 set)

Grouped by concern:

**Tenant &amp; identity (M2 schema, auth logic deferred to M3):**
- `organizations` — tenant root (school).
- `users` — person record; matches Supabase `auth.users.id` in M3; in M2 seeded users exist so FKs are valid.
- `organization_members` — user × organization × role (OWNER / SCHOOL_ADMIN / FINANCE_OFFICER / STAFF). UNIQUE `(organization_id, user_id)`.
- `sessions` — Postgres `TEXT`-mode cookie sessions (minimal; replaced or extended by Supabase in M3; present so future session-backed audit actors are valid).
- &gt; NOTE: M3 introduces Supabase Auth; the `users`/`sessions` tables in M2 are
  deliberately minimal placeholders so the schema is complete and foreign keys
  are valid. Documented as "M2 foundation, M3 will migrate to Supabase auth uid
  as users.id".

**Academic structure:**
- `academic_sessions` — a.k.a. sessions per docs (renamed to `academic_sessions`
  to avoid collision with `sessions` auth table; exported in code as
  `sessions` alias for docs). State: PLANNED/ACTIVE/CLOSED.
- `terms` — per session; State: PLANNED/ACTIVE/BILLED/CLOSED.
- `classes` — e.g. JSS 2A; per organization.
- `students` — per organization; State: ACTIVE/ARCHIVED/GRADUATED/WITHDRAWN.
- `guardians` — contact records; many-to-many via `student_guardians` (one child may have multiple guardians; one guardian may fund multiple children — supports sibling payments).
- `student_guardians` — join table, includes relationship label, is_primary flag.
- `class_enrollments` — student × class × term (historical membership). Replaces the docs' `student_class_enrollments` name for brevity; referenced in docs alias.

**Fees &amp; billing:**
- `fee_definitions` — catalog row per fee type (Tuition, Development Levy, ...). Per organization. Immutable name after use? No — soft archive via status.
- `fee_assignments` — fee_definition × class × term with amount_kobo + due_date + optional discount/waiver flags (discounts/scholarships/waivers M2 representable as a separate `adjustment_kobo` column; full scholarship/discount system deferred). Status: DRAFT/ACTIVE/ARCHIVED.
- `invoices` — per (student, term); Status: DRAFT/ISSUED/PARTIALLY_PAID/PAID/VOID. `total_kobo`, `paid_kobo`, `voided_at`, `voided_reason`.
- `invoice_lines` — one bill line per fee_assignment (or ad-hoc with description); `quantity`, `unit_rate_kobo`, `amount_kobo`, `period_start/end` for pro-ration future-proofing.

**Payments &amp; reconciliation (authoritative financial tables):**
- `payments` — money in; method CASH/BANK_TRANSFER/POS/ONLINE/OTHER; Status: PENDING/CONFIRMED/DUPLICATE_SUSPECT/REVERSED/REFUNDED/FAILED/REJECTED; `amount_kobo`, `unallocated_kobo`, `reference`, `paid_at`, `recorded_by`.
- `payment_allocations` — payment → invoice; amount_kobo; Status: ACTIVE/REVERSED; `reversal_id` nullable.
- `receipts` — issued per confirmed allocation or per payment confirmation (per policy); Status: ISSUED/VOID; immutable receipt_number; receipt_pdf_url deferred.
- `reversals` — append-only correction; type REVERSAL/REFUND/CORRECTION; positive `amount_kobo`; reason required; links to payment and optionally specific allocation.

**Collection channels &amp; comms:**
- `payment_links` — shareable signed links for an invoice (or set of obligations); status ACTIVE/PAID/EXPIRED/REVOKED; unique token; expires_at.
- `communications` — SMS/email/whatsapp/print log; status PENDING/SENT/DELIVERED/FAILED; channel; address; template; related entity.

**Platform reliability:**
- `audit_events` — append-only; actor_user_id, actor_type (USER/SYSTEM/WEBHOOK), organization_id nullable (system events), action, entity_type, entity_id, before/after JSONB, reason, metadata, request_id, created_at.
- `idempotency_keys` — key (UUID or provider event id) scoped by (organization_id, user_id) for API; webhook keys scoped by (provider, event_id); request_method, request_path, request_body_hash, response_status, response_body_hash, created_at, recovered_at, expires_at.
- `webhook_events` — raw inbound payload; provider, event_id (unique per provider), event_type, payload JSONB, received_at, processed_at, processing_attempts, last_error, status (RECEIVED/PROCESSED/FAILED/RETRYING/REJECTED).

**Explicitly deferred out of M2** (called out in docs but not present as tables):
- subscriptions / onboarding_state — commercial lifecycle, Phase 2.
- RLS policies on every table — defined as SQL in migration but verified via tests; M3 will couple them with Supabase auth.uid() once auth exists (RLS shape is designed for that).
- Bank statement import / unreconciled-batches table (discovery, after M3).
- Scholarship/discount template tables (adjustment_kobo on invoice_lines + future discount table).

### 3.2 Key design choices

- **Primary keys:** UUIDv7 (time-ordered, index-friendly) generated via `gen_random_uuid()` in Postgres by default, with an optional JS-side generator for service-layer code. I prefer UUIDv7 for two reasons: sortability without exposing total count (vs sequential) and native Postgres 17 support; this is a deliberate upgrade from the generic UUID noted in docs.
- **Tenant column:** `organization_id UUID NOT NULL REFERENCES organizations(id)` on every tenant-owned table, as the *first* column after `id`. Added as the leading column in composite indexes so organization-scoped queries are contiguous on disk.
- **Money type:** `BIGINT` (not `NUMERIC`) — kobo integer per the absolute rule. Documented with a DOMAIN `kobo_value BIGINT CHECK (value >= 0)` where applicable, and a separate `signed_kobo_value BIGINT` for derived aggregates (e.g. running balances). Payment/Reversal amounts use a positive-amount CHECK; negatives are encoded as reversal/correction records.
- **Timestamps:** `TIMESTAMPTZ NOT NULL DEFAULT now()`. Updated_at maintained via trigger.
- **Deletes:** Financial records (invoices, payments, allocations, receipts, reversals, refunds, audit) use `RESTRICT`/no-delete policies enforced at the application layer; on the DB we use RESTRICT foreign keys. Non-financial mutable entities (students, classes, fee_definitions) use a soft `deleted_at` column (default NULL, filtered out) and never `CASCADE` onto financial tables.
- **Invoice paid_kobo:** MATERIALIZED as a column on `invoices`, maintained by a trigger on `payment_allocations`/`reversals`. The trigger is the authority; services do not set it directly. This is a *documented derived value* — the invariants doc states the rebuild procedure (recompute from allocations).
- **Payment unallocated_kobo:** MATERIALIZED column maintained by trigger (allocation insert/reversal decrements/increments). Check constraint `unallocated_kobo &gt;= 0`.
- **Allocation invariants:** enforced by a trigger that uses `SELECT ... FOR UPDATE` on payment and invoice and validates `amount_kobo &lt;= payment.unallocated_kobo` and `amount_kobo &lt;= invoice.outstanding_kobo()` (a PL/pgSQL function). This is the concurrency defense — the trigger runs inside the same transaction as the insert and row locks prevent double-spend.
- **State machines:** Enforced by CHECK constraint on the `status` column AND a trigger `enforce_valid_transition()` consulting a transition table (per entity). Invalid transitions raise `ERRCODE = 'check_violation'` with a clear message.
- **Indexes:** Added for every FK; added composite `(organization_id, status)`, `(organization_id, term_id)`, `(student_id, term_id)`, `(payment_id, status)`, `(invoice_id, status)`, `(provider, event_id)` UNIQUE. Every index is annotated in schema with the query it serves.
- **No silent cascades:** All FKs use `ON DELETE RESTRICT` (or `ON DELETE SET NULL` for optional metadata columns). We never `ON DELETE CASCADE` across tenant or financial boundaries.
- **RLS:** Enabled on every tenant table in the migration. Policies use `current_setting('app.organization_id', true)::uuid` checked against `organization_id`. M4/Auth middleware will `SET app.organization_id = ...` per request after authentication. M2 tests exercise this directly.

## 4. Financial integrity decisions

Following `docs/FINANCIAL_INVARIANTS.md`:

- **F1** Money is integer kobo (`BIGINT`). All money columns end in `_kobo`. No `NUMERIC(15,2)`, no `REAL`, no `DOUBLE PRECISION`. JS arithmetic uses the `lib/money` helpers; DB arithmetic uses SQL BIGINT.
- **F2** Reversals/refunds/corrections are append-only records — never negative payments.
- **F3** Allocation ≤ payment.unallocated (trigger + check constraint).
- **F4** Allocation ≤ invoice.outstanding (trigger).
- **F5** No destructive deletes of financial records.
- **F6/F7** Reversals are the only way paid totals decrease; triggers update paid_kobo atomically.
- **F8** Invoice lines are frozen after issue (trigger prevents INSERT/UPDATE/DELETE on invoice_lines for invoices in ISSUED/PARTIALLY_PAID/PAID unless via a dedicated "invoice correction" audit workflow — M2 blocks it outright; correction flow is M3+).
- **F9** Receipt numbers are immutable and generated from a `receipt_number` sequence per organization (e.g. `RCP-2025-000001`).
- **F10** Every financial mutation writes an audit event IN THE SAME TRANSACTION (so if audit insert fails, the mutation rolls back).

**Edge cases supported by the M2 schema** (mapped against directive §11):

| Case | How modeled |
|---|---|
| Cash / Transfer / POS / Online payment | `payments.method` enum; no method-specific required columns |
| Partial payment | `payment_allocations.amount_kobo` ≤ invoice outstanding; multiple allocations possible |
| One payment → multiple invoices | Multiple `payment_allocations` rows with same payment_id |
| Multiple payments → one invoice | Multiple allocations with same invoice_id |
| Sibling payment (one payment → multiple students/invoices) | Multiple allocations across invoices; payment itself has no student_id |
| Previous-term debt | Invoices retain original `term_id`; outstanding balance is simply sum of unpaid invoices regardless of term; "current term" reporting filters by term_id |
| Overpayment | Last allocation cannot exceed outstanding; overpayments are recorded as a payment with `unallocated_kobo &gt; 0` (possible e.g. when invoices get credited post-payment via reversal); can later be allocated to future invoices or refunded |
| Underpayment | Partial allocation (state PARTIALLY_PAID) — core case |
| Unidentified payment | Payment CONFIRMED with no allocations (unallocated_kobo = amount), appears in reconciliation queue (derived view, deferred) |
| Duplicate payment reference | Unique constraint on `(organization_id, method, reference)` where reference is non-null AND method ∈ {BANK_TRANSFER, POS, ONLINE} — and a DUPLICATE_SUSPECT state for operator resolution |
| Reversal / Refund | `reversals` table; triggers flip payment/allocation status and decrement paid_kobo |
| Delayed / duplicate webhook | `webhook_events` unique `(provider, event_id)`; idempotency ensures processing once; out-of-order handled via state guards |
| Payment arriving after refund | Refund creates a reversal; subsequent confirmation of duplicate webhook would see payment in REFUNDED state and record as DUPLICATE_SUSPECT instead of double-allocating |
| Concurrent allocations | Trigger uses `SELECT ... FOR UPDATE` on payment + invoice rows; check constraints + atomic UPDATE prevent over-allocation |
| Student withdrawal | `students.status = WITHDRAWN`; all invoices/payments/allocations preserved; outstanding remains payable |
| Fee change next term | Invoice lines have `description`, `unit_rate_kobo`, `amount_kobo` SNAPSHOTTED at issuance — not joined live to fee_definitions for the billed amount |
| Discount / Scholarship / Waiver | `invoice_lines.adjustment_kobo` (signed) reduces line amount; full scholarship engine deferred but representable |
| Incorrect allocation correction | CORRECTION reversal type, creates new allocation(s) in same transaction; audit trail preserved |

## 5. Multi-tenancy strategy

**Answer to "How does SCOLAIRA prevent School A from seeing School B's data?"**

1. **DB-level:** Every tenant table has `organization_id NOT NULL` with FK and an RLS policy `USING (organization_id = current_setting('app.organization_id', true)::uuid)`. RLS is enabled on every tenant table and forced on (no BYPASSRLS for the application role).
2. **Connection-level:** The app connects with a dedicated NOINHERIT role `scolaira_app` that has SELECT/INSERT/UPDATE/DELETE only via RLS policies; it cannot SET `app.organization_id` arbitrarily — only through a `SECURITY DEFINER` function `set_tenant_context(organization_id uuid, user_id uuid)` that validates membership in `organization_members` before setting the GUC. M4 auth middleware will invoke this function once per request after authenticating the user.
3. **Server-side:** All service functions receive an `OrganizationContext` object resolved by middleware from the session; there is no API route that accepts an organization_id from the client. Repository functions wrap queries in a transaction that calls `set_tenant_context`. Tests verify that setting org B and querying org A returns zero rows.
4. **Defense in depth:** The repository query helpers (see §6) never expose a "query without organization filter" surface; they all require an `organization_id` and pass it as a bound parameter even though RLS would also block it. This is belt-and-suspenders: a disabled/misconfigured RLS will not leak data.
5. **Background jobs / webhooks:** These resolve the organization_id from the payload (e.g. payment → invoice → organization) and execute within a scoped transaction that calls `set_tenant_context`. No background job ever scans all tenants' payments.
6. **Audit:** All audit records carry the organization_id (or NULL for platform-level events). Cross-tenant audit queries are not exposed to UI.
7. **Exports/reports:** Generated server-side within a tenant-scoped transaction; no bulk multi-tenant export endpoint.
8. **M2 tests:** Explicit cross-tenant access tests for every major repository function (create/read/update/delete each direction must be blocked).

## 6. Repository / data-access pattern

- Direct Drizzle usage is NOT scattered throughout routes.
- A `lib/db/repo/*` module per aggregate (organizations, users, memberships, sessions, terms, classes, students, guardians, enrollments, fees, invoices, payments, allocations, receipts, reversals, paymentLinks, communications, audits, idempotency, webhooks) exposes typed async functions that accept a db instance + required parameters.
- A `lib/db/tenant.ts` module exposes `withTenant(db, organizationId, userId, fn)` which wraps `fn(tx)` inside a transaction that calls `set_tenant_context` and starts a REPEATABLE READ transaction for financial ops.
- No ORM models / Active Record; repositories return plain typed objects; mapping is trivial since Drizzle maps 1-to-1.
- All money values returned by repos are already kobo integers; conversion to Naira strings happens at API/route boundary.

## 7. Migration strategy

- First migration: `0000_init.sql` — all extensions (`pgcrypto`, `uuid-ossp` not needed; v7 via gen_random_uuid + manual), custom ENUM types, DOMAINs (`kobo_value`, `naira_string`), all tables, all FKs, all CHECK constraints, all indexes, helper functions, RLS policies, audit trigger generic function, updated_at trigger function, financial-invariant triggers, and the `set_tenant_context` security-definer function with role setup.
- Migrations are generated by drizzle-kit, verified by hand, and COMMITTED as SQL files (the SQL file is the durable artifact; drizzle meta is also committed).
- `npm run db:generate` produces a new migration; developer reviews; CI verifies migrations apply cleanly to an empty DB.
- `npm run db:migrate` runs all pending migrations (dev auto-migrate on first server start; production requires explicit opt-in or CI step so a migration never surprises a live deploy).
- `npm run db:drop` is a test-helper only; production never exposes it.
- Migration tests (M2) apply all migrations to an empty `scolaira_test` database and verify the schema shape (information_schema assertions) — so drift between drizzle schema and SQL is caught.

## 8. Testing strategy

Extends M1's Vitest + Playwright setup with:

- **`tests/db.ts` setup:** Global setup creates DB from scratch + runs migrations once; per-test transactional rollback.
- **Money tests:** Extended to 30+ cases covering zero, min (1 kobo), max safe integer, fractional naira (parse), negative values (for reversals only), serialization round-trip, invalid values throw, add/subtract/saturate/compare, allocation decrement with bounds checking.
- **Schema/constraint tests:** Migrate empty DB, attempt to insert rows violating each CHECK/FK/uniqueness rule and assert they throw the expected SQLSTATE.
- **Financial invariant tests (in-database):** Insert a valid set of seed facts, then try: over-allocation, double-spend from parallel transactions (using `db.transaction` with two concurrent promise attempts), delete financial record, update frozen invoice line — all must fail.
- **Tenant isolation tests:** Insert records for two orgs; within a tenant-scoped transaction for org A, queries/creates/mutates targeting org B must return zero rows / throw.
- **State machine tests:** For invoices/payments/allocations/receipts/terms/sessions/students/payment-links/communications/fee-assignments — assert all valid transitions succeed, all invalid transitions throw.
- **Audit tests:** Every create/update/soft-delete in the repos inserts an audit_event; before/after snapshots are correct; audit records cannot be modified or deleted by the app role.
- **Idempotency tests:** First request persists response; duplicate same body returns cached; duplicate different body returns 409 IDEMPOTENCY_KEY_REUSE; expiry works.
- **Concurrency tests:** Two concurrent `allocatePayment({payment, invoice, amount:80_000k})` calls against a 100_000k payment must result in exactly one succeeding and the other throwing INVARIANT_VIOLATION; total allocated never exceeds 100_000k.
- **Seed determinism:** Seed run twice produces identical IDs (uses seeded UUIDs via pg `uuid_generate_v7` seeded in test or the script uses a fixed generator).

M2 also extends CI to:
- Start a Postgres service container.
- Run migrations.
- Run the new DB test suite.

## 9. Risks

| Risk | Mitigation |
|---|---|
| PostgreSQL client/server setup in CI/sandbox | Documented in MIGRATIONS.md; CI uses `postgres:17` service; sandbox has Postgres 17 installed. |
| Drizzle-kit generating a migration that omits a constraint or function trigger we add manually | We write the init SQL directly in `0000_init.sql` and then introspect-pull to sync drizzle metadata; tests verify every constraint exists. |
| RLS accidentally off | CI test runs migrations and verifies `relrowsecurity = true` on every tenant table; tests try direct cross-tenant access as `scolaira_app` and expect failure. |
| Money bugs at the JS/SQL seam | Kobo type is branded; `lib/money` provides ALL arithmetic; `any` types not permitted in the repo via `no-explicit-any` lint. SQL uses BIGINT. Boundary tests cover from parseNaira → SQL insert → SQL read → formatKobo. |
| Performance of per-transaction tenant context | `set_tenant_context` is a SECURITY DEFINER that sets two GUCs; cost is trivial. RLS policies are on `organization_id`, the leading indexed column. |
| Concurrency correctness with SERIALIZABLE vs REPEATABLE READ | Default to REPEATABLE READ; enforce over-allocation with row locking + CHECK invariants; concurrency tests validate the two-allocation race. SERIALIZABLE reserved for financial close (M3+). |
| Supabase migration in M3 may need to rename/rekey `users.id` | M2 uses UUIDs for users.id; in M3 we will ALTER to match Supabase auth.uid (type remains UUID) and migrate test users — documented. |
| Schema churn before first real school | Migrations are cheap in M2; we will add a second/third migration only after review; the initial migration covers the full coherent domain model. |

## 10. Explicitly deferred

- Live Paystack integration, webhook processing (webhook_events table + idempotency exist; handlers are M3+).
- Authentication middleware (Supabase, M3). Repos/tests use a synthetic actor.
- Command Center populated with live numbers (M1 demo data replaced later via query layer).
- Parent payment pages.
- Full scholarship/discount UI (schema supports `adjustment_kobo`, no UI yet).
- Bank statement reconciliation engine.
- Reporting materialized views.
- RLS `auth.uid()` coupling (M3 will switch policies from our GUC to Supabase `auth.uid()` once sessions are real).
- Multi-currency (schema has `organizations.currency DEFAULT 'NGN'`; all money values are NGN-only in M2).

---

## Execution order

1. Wire real Drizzle client, postgres driver pooling (1 connection in serverless? Use single-connection `postgres()` with max=1 per Next.js route module — tuned later).
2. Add PG role/RLS migration helper functions.
3. Define all 23 Drizzle tables in `lib/db/schema/*.ts`, grouped by file.
4. Generate `0000_init.sql` with drizzle-kit, then manually add: domains, CHECK constraints not expressible in Drizzle, triggers, functions, RLS, role.
5. Apply migration to dev database; verify via psql.
6. Replace `lib/db/index.ts` and `lib/db/migrate.ts` with real implementations.
7. Wire migration to `instrumentation.ts` dev-only.
8. Extend `lib/money` arithmetic (subtract, sum, compare, saturateSubtract, signed support for balances).
9. Write comprehensive money tests.
10. Implement `lib/db/tenant.ts` and `lib/db/repo/*` (one file per aggregate).
11. Rewire audit logger to write to DB via repo (batched within tx).
12. Add seed script `scripts/seed.ts` with deterministic labeled demo data.
13. Add test infrastructure: Vitest setup that runs migrations once and wraps each test in a rolled-back transaction; factory helpers.
14. Write schema, money, financial, tenancy, state, audit, idempotency, concurrency tests.
15. Add CI Postgres service + test run.
16. Update docs under `docs/database/`.
17. Full quality gate: format/lint/typecheck/unit/build/e2e visual smoke (M1 preview pages must keep working).
18. Secrets scan, commit, push, verify remote SHA.
19. Report. STOP.
