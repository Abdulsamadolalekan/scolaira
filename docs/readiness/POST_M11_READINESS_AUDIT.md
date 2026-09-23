# SCOLAIRA — Post-M11 Product Readiness & Acquisition Audit

**Audit scope:** whole product as frozen at tag `m11-collections-control-plane`
**Frozen revision:** `cc0f6af378015aa6c4deba10a4e126ef9d8ff165`
**Audit mode:** read-only against the frozen tree. No product, schema, migration, seed, financial-path, or database file was modified. No Git history was created, rewritten, or falsified.
**Result:** **NO-GO for pilot deployment carrying real money, real student records, or real parent access.**
Conditional GO only for a bounded, supervised, non-production validation pilot under the compensating controls in §12.

---

## 0. Evidence classification

Every finding carries an evidence class so that reviewers can tell a proven defect from an unproven risk and from a missing artefact.

| Class | Meaning |
|---|---|
| **E1** | Verified by static inspection of the frozen source at the cited `file:line`. |
| **E2** | Verified by a read-only runtime/database probe against a disposable fixture database. |
| **E3** | Identified by static inspection; dynamic reproduction **still pending**. Must be reproduced before remediation sign-off. |
| **E4** | Absence of evidence (missing test, missing proof, missing document). Not a proven runtime defect, but blocks due diligence. |

**Standing caveat:** findings initially derived from an invalid concurrency probe were discarded. Only the corrected probe — with tenant GUC handling, `row_security`, and temporary-table privileges fixed — is treated as E2 evidence. Cleanup of disposable fixtures required a controlled superuser transaction with `session_replication_role=replica`; that technique must never be used against non-disposable data.

---

## 1. Overall production-readiness assessment

**Verdict: NOT PRODUCTION READY. NOT PILOT READY FOR REAL DATA.**

The financial *model* is stronger than the financial *enforcement surface*. The ledger design is genuinely defensible — authoritative sources of truth, append-only history, DB triggers enforcing invoice/payment/allocations/reversal invariants, partial-unique reference guards, per-organization document numbering, M9's one-issued-receipt-per-payment index, and M10's control-plane guard that refuses to mark a case `ALLOCATED` unless the payment is `CONFIRMED`, fully allocated, and backed by an accepted candidate. That is acquisition-grade *architecture*.

What is not acquisition-grade is the **isolation boundary beneath it** and the **evidence above it**:

- the tenant-isolation model is implemented through a connection pool with `max: 1` and session-level GUCs set *outside* a reserved transaction, with incomplete cleanup — so correctness depends on serverless instance reuse behaviour rather than on a hard boundary;
- financial foreign keys and trigger parent lookups are **not** organization-composite, so cross-tenant parent/child references are constructible;
- the public payment-link context can be established by the runtime role with an arbitrary organization, and the generic authorization layer accepts the public-context marker without validated bearer-link proof;
- the runtime database role retains broad schema/table/function privileges after migration, and two tables (`reminders`, `app_meta`) have RLS enabled but not `FORCE`d;
- the health endpoint is a **liveness-only false green** and the E2E suite never establishes a migrated, seeded database or an authenticated school/parent/platform journey.

Individually the medium findings are ordinary scale-up debt. Collectively, the criticals mean that **two schools' financial data can plausibly interleave inside one process**, and that **the team's green CI does not demonstrate the product works end to end**. For a proprietor handing over real fee money, and for a buyer running technical due diligence, those two facts are the entire story.

**Maturity by domain**

| Domain | Assessment |
|---|---|
| Financial model & invariants | Strong; trigger-enforced, append-only, reproducible. |
| Financial enforcement edges | Partial; idempotency, receipts, void, and reversal replay have gaps. |
| Tenant isolation | **Unsound as designed** (pool/GUC + non-composite FKs). |
| Authorization | Centralized and real; undermined by the public-context trust shortcut. |
| Database privilege model | Broad grants survive migration; partial re-hardening only. |
| Front-end / UX coherence | Functional; identity, mobile, and support journeys incomplete. |
| Automation & release evidence | Typecheck/unit tests credible; E2E and health are not. |
| Operations (backup/DR/secrets) | Documented, largely unevidenced. |
| Documentation truth | Partly ahead of the implementation; partly draft. |

---

## 2. CRITICAL findings

### C-1 — Tenant context is not bound to a reserved connection; cleanup is incomplete
- **Severity:** Critical
- **Location:** `lib/db/index.ts:51-60`, `lib/db/tenant.ts:78-114`
- **Evidence class:** E1 (static) + E2 (corrected probe)
- **Verification:** Read the pool construction (`max: 1`) and the tenant-context setter. Confirm the context is established outside a reserved transaction and that the reset path omits `acting_role`, `platform_admin_id`, `platform_token`, `tenant_token`, `public_context`, `public_link_token`. Reproduce: issue two concurrent authenticated requests for different organizations against a disposable database and inspect the resolved GUCs observed by each query.
- **Root cause:** Isolation is implemented as session state on a pooled connection rather than as a per-request, transaction-scoped or connection-reserved boundary.
- **Impact:** Cross-tenant read/write exposure, including financial rows. This is the single most serious defect in the product.
- **Remediation:** Reserve a dedicated connection per request for the whole request lifetime (or scope context to a transaction that the query path cannot escape), make cleanup unconditional and total, and fail closed if the expected context is absent.
- **Pilot requirement:** **Hard gate.** Must be fixed and re-probed before any second tenant exists in an environment.
- **ADQ requirement:** Buyer must receive the fix, the probe, and the concurrency test as evidence.

> **R1 status (closed 2026-09-23) — CLOSED, PROVEN.** Context is now bound to the
> connection that executes the protected queries (scope-owned connection; a
> reserved connection when the pool can spare one, a serialized shared
> connection when it cannot), written transaction-locally so Postgres itself
> reverts it, cleared on all 11 identity variables on both layers and read back
> with `ScopeIntegrityError` on failure. Evidence:
> `docs/security/R1_ISOLATION_HARDENING_CLOSEOUT.md` §2, §5, §7;
> `tests/db/r1-context-isolation.test.ts` (14 tests, including 16 interleaved
> concurrent scopes over two organisations on a 4-connection pool);
> `tests/db/r1-independent-reaudit.test.ts` section E. No reliance on `max: 1`
> remains.

### C-2 — Financial foreign keys and trigger parent lookups are not organization-composite
- **Severity:** Critical
- **Location:** `lib/db/migrations/0000_init.sql:429-442`; `lib/db/migrations/0001_integrity.sql:208-260`
- **Evidence class:** E1 + E2
- **Verification:** Read the FK definitions for invoices/lines/payments/allocations/receipts/reversals and the trigger lookup statements on the parent rows. Reproduce by attempting a child insert whose parent id belongs to a different organization and observing whether the database rejects it.
- **Root cause:** Keys are globally unique UUIDs, so referential integrity is satisfied structurally while tenant integrity is never asserted.
- **Impact:** A mis-scoped join, a leaked id, or a trigger executing under a different context can silently attach one school's money to another school's invoice, and triggers will then mutate the wrong tenant's balances.
- **Remediation:** Add composite `(organization_id, id)` uniqueness on parents and composite FKs on children; scope trigger parent lookups by `organization_id`.
- **Pilot requirement:** **Hard gate.**
- **ADQ requirement:** Migration diff plus a negative test proving the cross-tenant insert now fails.

> **R1 status (closed 2026-09-23) — CLOSED, PROVEN.** 16 unique
> `(organization_id, id)` parent indexes and 37 organization-composite foreign
> keys across 17 tables (migration `0038_r1_organization_composite_fks.sql`,
> forward-only; trigger bodies deliberately unchanged). Evidence:
> `tests/db/r1-composite-fk.test.ts` (48 tests: per-relationship forged inserts
> for all 37 relations, an enforcement-layer matrix showing which layer rejects
> each one, and proof that a cross-tenant allocation attempt leaves the foreign
> tenant's `paid_kobo` / `unallocated_kobo` byte-for-byte unchanged).

### C-3 — Public-context boundary is self-asserted and accepted without bearer-link proof
- **Severity:** Critical
- **Location:** `lib/db/migrations/0013_public_context_fix.sql:55-74`; `lib/db/migrations/0034_m10_control_plane_auth_hardening.sql:107-145`
- **Evidence class:** E1
- **Verification:** Inspect the public-context setup function's argument handling and the authorization path's treatment of the public marker. Reproduce by invoking the setup path with an arbitrary organization id under the runtime role, then exercising a tenant-scoped route under the resulting context.
- **Root cause:** A context-setting function that is callable by the runtime role with caller-supplied organization input, combined with an authorization layer that trusts the public marker rather than re-validating the token that justified it.
- **Impact:** The public payment-link surface can become a tenant-selection primitive rather than a narrowly scoped, token-proven read/write path.
- **Remediation:** Derive the public context exclusively from a validated, unexpired token inside a single privileged routine; make the generic authorization layer re-verify the link on every public-context request; remove runtime execute rights on the raw setup path.
- **Pilot requirement:** **Hard gate.**
- **ADQ requirement:** Privilege diff + token-forgery test.

> **R1 status (closed 2026-09-23) — CLOSED, PROVEN, AND BROADER THAN ORIGINALLY
> SCOPE.** The self-asserted setter is revoked from the runtime role; public
> context is derived solely from the bearer token, whose resolution mints a
> proof bound to (token, organization, backend) that every public policy
> requires (migration `0040`). Two further layers of the same boundary were
> found by adversarial testing and closed: `auth_is_tenant_authorized()` treated
> public context as tenant membership, which gave a single link token full
> row-level access to that organisation's tenant tables (measured: `UPDATE
> invoices` affected 1 row) — removed in `0042`; and the public submission route
> depended on that over-authorization for its `INSERT … RETURNING`, replaced by
> the credential-gated `auth_public_submit_payment()` entry point in `0043`, so
> public context now holds **no direct write privilege on any table**. Evidence:
> `tests/db/r1-public-context.test.ts` (20 tests) and
> `tests/db/r1-independent-reaudit.test.ts` sections B–D.

### C-4 — Runtime-role privileges exceeded the application's needs (found during R1)
- **Severity:** Critical (discovered 2026-09-23, during R1 adversarial verification)
- **Location:** `scripts/migrate.ts:46-78`, `tests/global-setup-db.ts`, `scripts/provision-db.sh:49`
- **Evidence class:** E2 (measured against the running database)
- **Root cause:** the post-migration grant step ran
  `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO scolaira_app` and only
  then revoked a hand-picked list, silently re-granting what the migrations had
  revoked — including `REVOKE ALL ON app_meta` from migration 0010.
- **Measured before the fix:** `has_table_privilege('invoices','TRUNCATE') = true`,
  `has_table_privilege('app_meta','SELECT') = true`, table ACL
  `scolaira_app=arwdDxtm/scolaira_owner`. TRUNCATE is **not** subject to row
  level security, so RLS/FORCE RLS and every append-only `REVOKE UPDATE, DELETE`
  were powerless against it; a runtime-role compromise could have destroyed
  authoritative financial history and the tenant-context HMAC secret.
- **Remediation:** migration `0044_r1_runtime_privilege_hardening.sql` (DML-only
  for the runtime role, `app_meta` owner-only, no `CREATE` on schema `public`)
  plus the grant step itself in `scripts/migrate.ts` and
  `tests/global-setup-db.ts` now granting the explicit DML set.
- **R1 status (closed 2026-09-23) — CLOSED, PROVEN.** Zero tables grant the
  runtime role TRUNCATE; `app_meta` ACL is owner-only; the runtime role cannot
  `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, drop a composite constraint, drop
  a policy, create a permissive policy, grant itself privileges, or `ALTER ROLE
  … BYPASSRLS` (all refused `42501`). Evidence:
  `tests/db/r1-independent-reaudit.test.ts` section F.

---

## 3. HIGH findings

### H-1 — Runtime role retains broad privileges after migration; two tables lack `FORCE ROW LEVEL SECURITY`
- **Severity:** High · **Location:** `lib/db/migrations/0006_runtime_role.sql:22-55`, `scripts/migrate.ts:46-78`, `lib/db/migrations/0019_reminders.sql:61-78`, `lib/db/migrations/0010_lockdown_secdef.sql:187`
- **Evidence class:** E1
- **Verification:** Read the post-migration grant block and the `security definer` whitelist; inspect `relforcerowsecurity` for `reminders` and `app_meta`. Cross-check `scripts/bootstrap-roles.sql` and `scripts/provision-db.sh` default privileges.
- **Root cause:** Broad default privileges applied for migration convenience are only partially re-tightened afterwards.
- **Impact:** RLS becomes advisory for table owners and for any path not subject to the re-hardening; `auth_test_system_context` remains a live concern.
- **Remediation:** Finish least-privilege re-hardening; `FORCE ROW LEVEL SECURITY` on `reminders` and `app_meta`; review and remove any non-production context helper from the shipped grant set.
- **Pilot requirement:** Required before pilot.
- **ADQ requirement:** Before/after privilege matrix as an artefact.

### H-2 — Aggregation scope, term boundaries, and pagination are inconsistent across headline KPIs and queue views
- **Severity:** High · **Location:** `app/api/dashboard/summary/route.ts:102-250`; `lib/db/repo/reminders.ts:122-189`; `lib/db/repo/collections.ts:123-171`; related list routes
- **Evidence class:** E1/E3
- **Verification:** Compare the term filter on headline KPIs against the all-term filter on aging/stale queues; enumerate hard result caps; then exercise with multi-term, prior-term-debt, and high-volume tenants.
- **Root cause:** Two different scoping conventions coexist without an explicit, labelled contract, and result caps were added for performance without cursor/`hasMore` contracts.
- **Impact:** A proprietor can see a current-term total beside an all-term arrears queue and reasonably conclude the numbers are wrong. Prior-term debt treatment is undefined, so term boundaries silently change reported revenue.
- **Remediation:** Declare one scoping contract per surface, label it in the UI, make every capped endpoint return an explicit truncation signal and support navigation, and add term-boundary and prior-term-debt tests.
- **Pilot requirement:** Required — proprietor-facing coherence is a pilot acceptance criterion.
- **ADQ requirement:** Reconciliation test set demonstrating KPI totals tie back to source rows.

### H-3 — Public payment link: no idempotency or rate limit, caller-influenced amount, and sensitive data in public output and audit metadata
- **Severity:** High · **Location:** `app/api/p/[token]/submit/route.ts`; `app/p/[token]/page.tsx`; `app/api/payment-links/route.ts`
- **Evidence class:** E1
- **Verification:** Inspect the submit handler for replay protection and throttling; compare the displayed amount with the amount accepted on submit; inspect the public read payload and the notes/audit metadata written on submission.
- **Root cause:** The public journey was built for demonstration breadth (open/partial payment) without the adversarial controls a public surface needs.
- **Impact:** Repeated pending submissions, amount divergence between what the payer saw and what is recorded, full student identifiers exposed to anyone holding a link, and bearer tokens persisted into notes and audit metadata.
- **Remediation:** Enforce the link's fixed amount server-side, add submission idempotency and rate limiting, minimise the public payload, and stop persisting raw tokens.
- **Pilot requirement:** **Hard gate if public links are enabled during pilot.** Mitigation: disable public links for the pilot.
- **ADQ requirement:** Threat model + abuse test results.

### H-4 — Registration writes are not transaction-wrapped; register route has no outer cleanup
- **Severity:** High · **Location:** `lib/auth/index.ts:452-532`; `app/api/auth/register/route.ts:16-38`
- **Evidence class:** E1
- **Verification:** Read the registration sequence — user, organization, membership, credential inserts as separate autocommit statements — and confirm the route performs no compensating cleanup if auto-login fails after the inner cleanup.
- **Root cause:** A multi-row provisioning workflow modelled as sequential statements rather than a single unit of work.
- **Impact:** A mid-sequence failure leaves an orphaned user or a half-created school account; the operator sees an error but the tenant exists in a partial state, and retry produces confusing conflicts.
- **Remediation:** Wrap provisioning in one transaction; on failure roll back fully; make failure messages actionable.
- **Pilot requirement:** Required — onboarding is the pilot's first interaction.
- **ADQ requirement:** Failure-injection evidence.

### H-5 — Auth-module context cleanup and reset-token critical section
- **Severity:** High · **Location:** `lib/auth/index.ts:199-290, 293-320, 644-692`; `app/api/auth/logout/route.ts:6-21`
- **Evidence class:** E1
- **Verification:** Trace `getSession` and `withAuth` for guaranteed cleanup on every failure path; inspect whether the reset `SELECT ... FOR UPDATE` row lock is held across credential update, token consumption, and session revocation; check the logout handler for the project's stated CSRF policy on unsafe methods.
- **Root cause:** Cleanup is delegated to outer wrappers rather than guaranteed inside the module; the reset flow uses `FOR UPDATE` outside a transaction spanning the read-modify-consume sequence; logout is treated as low-risk and skips the policy check.
- **Impact:** Residual system context after failed auth work; a reset token that can be consumed more than once under concurrency; a CSRF-policy exception that a due-diligence reviewer will read as inconsistent enforcement.
- **Remediation:** Module-level `finally` for context cleanup; one transaction spanning reset read/update/consume/revoke; align logout with the unsafe-method CSRF policy.
- **Pilot requirement:** Required.
- **ADQ requirement:** Concurrency test on reset-token double-consumption.

### H-6 — Release evidence: health endpoint is a liveness-only false green and E2E never establishes a real seeded, authenticated system
- **Severity:** High · **Location:** `app/api/health/route.ts:17-40`; `e2e/health.spec.ts`; `e2e/screenshots.spec.ts`; `playwright.config.ts:7-30`; `.github/workflows/ci.yml`; `tests/global-setup-db.ts`
- **Evidence class:** E1
- **Verification:** Read the health handler — it always returns `status: "ok"` with `database`/`auth: "not_configured"`. Read the Playwright config and specs — Chromium only, preview/mock pages, no migration+seed step, no authenticated school/parent/platform journey.
- **Root cause:** Health was written as a process liveness check and E2E as visual smoke coverage, then treated as deployment confidence.
- **Impact:** A deployment with a broken database, missing migrations, or failed auth configuration reports healthy. Screenshots purporting to show the product show preview surfaces instead, so the artefact that a buyer or proprietor would inspect does not evidence the shipped journeys.
- **Remediation:** Add a readiness probe that proves database connectivity, migration state, and auth configuration, and fails closed. Add a CI step that provisions and seeds a database, then runs authenticated school, parent-payment, and platform journeys, with at least one non-Chromium pass.
- **Pilot requirement:** **Hard gate** — no pilot on unverifiable green.
- **ADQ requirement:** CI run artefacts and the readiness probe output.

### H-7 — Financial idempotency and receipt/void boundaries are not uniformly enforced
- **Severity:** High · **Location:** `app/api/payments/route.ts:127-245`; `app/api/payments/[id]/reverse/route.ts:44-57`; `app/api/receipts/route.ts:33-107`; `app/api/invoices/[id]/void/route.ts:28-52`
- **Evidence class:** E1
- **Verification:**
  1. Payment creation: confirm `Idempotency-Key` is optional, so a retried submit creates a second payment.
  2. Reversal: the header comment claims idempotency on `reference`, implemented as SELECT-then-INSERT. Inspect `reversals` in `0000_init.sql` and `0001_integrity.sql` — the only unique index is `reversals_org_number_idx (organization_id, reversal_number)`. **No unique constraint exists on `(payment_id, reference)`.** Two concurrent identical reversal POSTs can both insert.
  3. Receipt issuance: reads payment, reads ACTIVE allocations, reads any existing receipt, inserts the receipt, writes the audit event — all on `db`, outside a transaction. The M9 partial unique index (`0021_academic_roster_control.sql:33-34`) resolves the duplicate-insert race, but not the amount snapshot taken from a non-transactional read.
  4. Invoice void: reads the invoice balance on `db`, then voids and audits on `db`, outside a transaction.
- **Root cause:** The strongest guarantee available (a transaction plus a DB constraint) is applied on the happy-path routes but not on the correction/issuance routes that exist precisely for exceptional situations.
- **Impact:** Double reversal under concurrency (bounded by `trg_reversals_insert`, which caps total reversal at the payment amount — so the result is a *legitimate-looking but unintended full reversal*, not a phantom overshoot); a receipt whose frozen `amount_kobo` no longer matches the allocations still active at rest; an invoice voided on a stale balance read; audit rows that can exist without, or apart from, the state change they describe.
- **Remediation:** Add `UNIQUE (payment_id, reference)` on `reversals` where reference is not null; wrap receipt issuance and invoice void in explicit transactions covering read → mutate → audit; accept `Idempotency-Key` on payment creation and reversal; snapshot the allocation set onto the receipt at issue time.
- **Pilot requirement:** **Hard gate.**
- **ADQ requirement:** Constraint diff + concurrency tests for reversal, receipt, and void.

> **R2 status (closed 2026-09-23) — CLOSED, PROVEN, with one sub-claim corrected.**
> Verification first disproved part of the finding: `payments_org_reference_unique_idx` has existed since
> `0001_integrity.sql:126`, so "no unique constraint on payment references" was wrong. The real gaps were
> narrower and were confirmed by measurement: the predicate omitted method `OTHER` (two `OTHER` payments
> sharing one reference were created) and carried no status predicate, so a `FAILED` attempt permanently
> blocked the legitimate retry the application permits — which then surfaced as a raw `23505` and a 500.
> The reversal claim was confirmed exactly as written: two connections replaying the route's
> SELECT-then-INSERT both passed the guard and both inserted, reducing a 1,000,000 kobo payment to
> `paid_kobo = 0 / ISSUED` through two individually-legal half reversals.
>
> Remediation: migration `0045` (reversal reference uniqueness; a live-payment reference guard covering
> every non-CASH method; a write-once `receipts.allocations_snapshot`, all with fail-closed pre-checks),
> a mandatory `Idempotency-Key` on the five financial mutations, one transaction spanning
> read → guard → mutate → audit for receipt issuance and invoice void, and a cause-chain SQLSTATE reader
> after the re-audit proved that Drizzle's error wrapping hid every database-enforced conflict from the
> route boundary (it answered 500 where it intended 409).
>
> Evidence: `docs/security/R2_EXCEPTIONAL_PATH_FINANCIAL_INTEGRITY_CLOSEOUT.md` §3 (measured pre-fix
> probe), §4 (remediation), §5 (36 new tests), §6 (regression), §7 (financial non-interference);
> `tests/db/r2-exceptional-path-integrity.test.ts` (20), `tests/db/r2-independent-reaudit.test.ts` (16,
> which found and forced the fix of two further defects).
>
> Remaining and explicitly NOT closed here: the public payment-link surface (H-3) still has no rate limit
> or submission idempotency, does not bind the payer-supplied amount to the link's fixed amount, and still
> persists the bearer token in `payments.notes`/audit metadata — it is the recommended next milestone.

### H-8 — Authenticated shell identity, mobile behaviour, and the platform-support journey are incomplete
- **Severity:** High · **Location:** `app/(app)/layout.tsx`; `components/ui/app-shell.tsx`
- **Evidence class:** E1
- **Verification:** Inspect shell identity/role presentation and mobile composition; exercise at 390px; attempt the invitation flow (returns `501`); look for any read-only platform-support journey that targets a specific organization.
- **Root cause:** The shell was built for the primary roles and never extended to support/oversight presentation.
- **Impact:** In a pilot, the first support incident requiring a specific school's data has no sanctioned, attributable, read-only path — which pushes operators toward exactly the ad-hoc privileged access the architecture was designed to prevent. Broken invitation and cramped mobile views undermine the commercial demo.
- **Remediation:** Complete organization identity and role presentation, fix 390px composition, implement invitation or remove the affordance, and add an audited, read-only, target-organization support journey or explicitly document its absence as an operational constraint.
- **Pilot requirement:** Required.
- **ADQ requirement:** Journey walkthrough evidence at both viewports.

### H-9 — Operations and recovery are documented but unevidenced; documentation partly precedes implementation
- **Severity:** High · **Location:** `docs/DISASTER_RECOVERY.md`; `docs/OPERATIONS.md`; `docs/DATA_RESIDENCY_AND_PRIVACY.md`; `docs/API_CONTRACTS.md`; `docs/ARCHITECTURE.md`; `.github/workflows/ci.yml`; `package.json`
- **Evidence class:** E4
- **Verification:** Read each document for named artifacts, retention, restoration ownership, and measured RTO/RPO; search for backup configuration, restore drill records, PITR configuration, and provider contracts. Compare documented routes/providers against the frozen implementation.
- **Root cause:** Documentation was authored as intent and never reconciled to what is implemented, exercised, or owned.
- **Impact:** Backup/restore/PITR and off-site ownership cannot be asserted to a pilot school or a buyer; data-residency and provider claims are partly draft or ahead of the code. This is the kind of gap that turns a technical diligence conversation into a price adjustment.
- **Remediation:** Either evidence each claim (config, drill log, contract, owner) or downgrade the document to match reality. Add a documentation-truth pass that removes or flags anything not present in the frozen implementation.
- **Pilot requirement:** Required — a pilot school will ask what happens if the database is lost.
- **ADQ requirement:** Evidence pack index with owners and dates.

---

## 4. MEDIUM findings

- **M-1 — Internal error text disclosed to clients.** `app/api/auth/reset-confirm/route.ts:21-24` returns `String(e?.message ?? e)` on unexpected failures. *E1.* Unexpected database/internal details reach the reset client. Remediation: return a stable public error and log the detail server-side. Pilot: required. ADQ: error-handling policy.
- **M-2 — Invoice void is not transactional.** `app/api/invoices/[id]/void/route.ts:28-52`. Reads on `db`, then voids and audits on `db`. Balance can change between the read and the void; audit and state change are not atomic. *E1.* Remediation: single transaction spanning read → guard → void → audit. Pilot: required. ADQ: concurrency test.
- **M-3 — Receipt rendering can diverge from the receipt snapshot.** `app/api/receipts/[id]/route.ts:22-40` renders the allocation list from *current* ACTIVE allocations while `receipts.amount_kobo` is frozen at issue time (`app/api/receipts/route.ts:54,78-82`). After a post-issuance reversal, the printed receipt's lines no longer sum to the receipted amount. *E1.* Remediation: render the allocation snapshot captured at issuance, or display reversal effects explicitly. Pilot: required (parent-facing trust). ADQ: receipt reproducibility test.
- **M-4 — Partial allocation reversal is unsupported and hard-fails.** `lib/db/migrations/0001_integrity.sql:549-551`; `lib/db/migrations/0002_financial_fixes.sql:173-175`. A refund that does not align to whole allocations raises `Partial allocation reversal not supported in M2`. *E1/E3.* Remediation: support partial reversal explicitly or define and document the whole-allocation refund rule in the operator UI so staff know to reverse in allocation-sized steps. Pilot: required if refunds occur. ADQ: behaviour must be specified, not discovered.
- **M-5 — REFUND semantics reduce invoice balance while leaving the payment CONFIRMED.** `lib/db/migrations/0002_financial_fixes.sql:191-212`. `unallocated_kobo` is deliberately not restored for `REFUND`, and payment status only changes once no ACTIVE allocations remain. *E1/E3.* Remediation: document the exact expected reporting reading and add a scenario test. Pilot: required. ADQ: documented accounting treatment.
- **M-6 — Result caps may be user-invisible.** Multiple list/queue routes apply fixed limits with no cursor or `hasMore`. Static discovery is not proof that a cap is reachable in practice. *E3.* Remediation: volume test on a synthetic large tenant; expose truncation explicitly. Pilot: required. ADQ: pagination contract.
- **M-7 — Reminder stale-follow-up logic.** `lib/db/repo/reminders.ts:122-189`. *E3.* Remediation: define and test staleness boundaries. Pilot: required.
- **M-8 — Evidence asymmetry between unit/type checks and end-to-end behaviour.** Typecheck and Vitest evidence is materially stronger than the E2E evidence; lint warnings persist; `npm run format:check` fails on 183 files. *E1.* Formatting was deliberately **not** remediated because the tree is frozen and no unrelated refactor is authorised. Remediation: schedule a separate, isolated hygiene change once the freeze lifts. Pilot: acceptable. ADQ: disclose as known debt.
- **M-9 — Documentation claims routes/providers not present in the frozen implementation.** `docs/ARCHITECTURE.md`; `docs/API_CONTRACTS.md`. *E4.* Remediation: truth-align or annotate as roadmap. Pilot: acceptable. ADQ: required before buyer documentation review.

---

## 5. LOW findings

- **L-1 — Cosmetic response inconsistencies.** `app/api/payments/[id]/confirm/route.ts` returns a 400 `NextResponse` from inside a transaction rather than throwing; `app/api/invoices/[id]/issue/route.ts` documents `Idempotent-Replayed` in prose while only setting it on the replay path and returns 200 without an audit event when the invoice is already issued. *E1.* No correctness impact. Cosmetic; fix opportunistically.
- **L-2 — `receipts.allocation_id` is declared with a foreign key but never populated.** `lib/db/migrations/0000_init.sql:437`; `app/api/receipts/route.ts`. *E1.* Harmless today because receipts are per payment; becomes load-bearing if per-allocation receipts are ever introduced. Document the intent.
- **L-3 — Preview surfaces coexist with authenticated routes.** `app/preview/list/[slug]/page.tsx` and preview navigation in `components/ui/nav-shell.tsx`. Useful for demos, but generated screenshots currently come from preview rather than the authenticated product (see H-6). Presentation risk, not a defect.
- **L-4 — Working-tree hygiene.** `docs/security/M11_STAGING_VERIFICATION.md` remains untracked and uncommitted. Handover hygiene; do not delete — it is evidence.

---

## 6. Financial-integrity findings (consolidated)

**Sound and confirmed present:** append-only enforcement on financial tables; trigger-enforced invoice `paid_kobo`/status invariants; single-statement paid/status updates in the corrected trigger set; reversal capped at the payment amount; partial-unique payment reference guard; per-organization document numbering; one-issued-receipt-per-payment; M10 guard requiring `CONFIRMED` + fully allocated payment + accepted candidate before `ALLOCATED`.

**Gaps:** ~~C-1, C-2~~ (closed by R1 — see the R1 status notes above; isolation beneath the ledger is now enforced by connection-scoped context and organization-composite constraints); H-7 (reversal replay unique constraint, receipt issuance transaction, void transaction, optional payment idempotency); M-3 (receipt not reproducible after reversal); M-4 (partial reversal unsupported); M-5 (REFUND semantics undocumented); H-2 (term scoping makes totals disagree across surfaces).

**Note on blast radius:** the reversal trigger caps total reversals at the payment amount, so the H-7 replay defect produces an unintended *complete* reversal rather than a payment exceeding its own value. The invoice and allocation state then reflects a reversal the operator did not intend — a correction-integrity problem, not a money-creation problem. This distinction matters for severity framing and must not be overstated in either direction.

---

## 7. Security findings (consolidated)

Isolation: C-1, C-2. Public surface: C-3, H-3. Privilege/RLS: H-1. Auth lifecycle: H-4, H-5. Disclosure: M-1. Provenance/attribution: the architecture's actor-attribution and audit design is present and largely coherent — actor attribution is weakened only where privileged support access has no sanctioned path (H-8), which creates pressure toward unlogged access.

**Confirmed present and worth crediting:** centralized authorization, CSRF enforcement on protected routes, idempotency-key infrastructure, audit-event recording, RLS with `FORCE` on most sensitive tables, a `SECURITY DEFINER` whitelist, an append-only history model.

---

## 8. UX / product findings (consolidated)

H-8 (shell identity, 390px behaviour, invitation `501`, absent support journey), H-3 (public payer experience and amount divergence), H-2 (unlabelled scope differences between KPIs and queues), M-3 (receipt that no longer matches its lines), M-6 (silent truncation), H-6 (screenshots that show preview rather than the product). The commercial-presentation gap is therefore **not stylistic** — it is that the surfaces a proprietor or buyer would inspect are either unauthenticated previews or are missing a coherent scoping/identity story.

---

## 9. Documentation and operational-readiness gaps (consolidated)

H-9 in full, plus M-9, M-8, and L-4. Present and credible: architecture narrative, API contracts, operations, disaster recovery, data residency and privacy, migration discipline, environment/secrets handling intent. Missing or unproven: evidence that backups exist and restore has been exercised, measured RTO/RPO, named off-site ownership, provider contracts, data-residency proof, ownership/IP artefacts, and a documentation pass reconciling claims with the frozen implementation.

---

## 10. Pilot blockers (must be closed before any real data or real money)

1. C-1 tenant context/connection boundary.
2. C-2 composite financial FKs and organization-scoped trigger lookups.
3. C-3 public-context proof and privilege removal.
4. H-1 privilege re-hardening + `FORCE ROW LEVEL SECURITY` on `reminders` and `app_meta`.
5. H-6 real readiness probe + seeded, authenticated E2E in CI.
6. H-7 reversal uniqueness, receipt-issuance transaction, void transaction, payment idempotency.
7. H-4 transactional registration.
8. H-5 auth cleanup `finally`, reset critical section, logout CSRF alignment.
9. H-3 public-link controls — or an explicit decision to keep public links disabled for the pilot.
10. H-8 minimum viable identity/mobile/invitation/support journey.
11. H-9 backup/restore evidence and a named recovery owner.
12. M-2 void transactionality and M-1 error-disclosure fix (cheap and adjacent to items already in flight).

---

## 11. Acquisition / technical-due-diligence blockers

- C-1, C-2, C-3 — isolation and boundary defects are disqualifying in a technical review on their own.
- H-1 — the privilege matrix a buyer will ask for does not yet exist in hardened form.
- H-6 — CI proves typecheck and unit behaviour, not that the product runs. Buyers discount this heavily because it means every quality claim is unverified.
- H-7 — exceptional-path financial controls are weaker than happy-path controls; expect sustained questioning on corrections and reversals.
- H-2 — no reconciliation artefact tying KPIs to source rows across term boundaries.
- H-9 — recovery, residency, ownership/IP, and provider claims unevidenced.
- M-9 — documentation ahead of implementation.
- M-8 — disclosed debt (183 unformatted files, lint warnings) is acceptable only if disclosed and deliberately deferred.

**Credit that should be surfaced positively:** the authoritative ledger design, append-only history, trigger-enforced invariants, M10's case/evidence/candidate control plane that refuses to mutate financial truth, M11's containment as a workflow layer, and disciplined migration numbering `0000`–`0037`. This is a real architectural asset; the blockers are enforcement and evidence, not design.

---

## 12. Compensating controls for a bounded validation pilot

If the founder chooses to run a pilot before R1–R4 complete, it must be all of the following:

- **single tenant only** in the pilot environment, with no second organization co-resident;
- **synthetic or pseudonymised data** — no real student records, no real parent contact details, no real money movement;
- **public payment links disabled**;
- **no platform/privileged support access** used against live pilot data;
- **one operator, one named environment, one documented freeze point**;
- **export-based backup** taken before each session and verified by test-restore at least once;
- **written pilot acceptance criteria** limited to journey completeness and UX feedback, explicitly excluding financial-correctness claims;
- **a hard stop**: any observed interleaving, cap truncation, or total/KPI disagreement ends the pilot immediately pending remediation.

Anything less than the full set is not a mitigated pilot; it is unmanaged production risk.

---

## 13. Recommended remediation order

**R0 — Preservation and evidence (done).** Freeze confirmed; this document plus the acquisition checklist. No product change.
**R1 — Isolation (C-1, C-2, C-3).** R1-a tenant context/connection; R1-b composite FKs and trigger scoping; R1-c public-context proof and privilege removal. Each with negative tests. *Blocks everything else.*
**R2 — Privilege and RLS hardening (H-1).** Before/after privilege matrix as the deliverable.
**R3 — Auth lifecycle (H-4, H-5, M-1).** Transactional registration, guaranteed cleanup, reset critical section, logout CSRF, error disclosure.
**R4 — Financial exceptional paths (H-7, M-2, M-3, M-4, M-5).** Constraint additions and transaction wrapping first, then receipt snapshot rendering, then documented refund/reversal semantics.
**R5 — Public surface (H-3, C-3 follow-through).**
**R6 — Observability and release evidence (H-6, H-9).** Readiness probe, seeded CI E2E, multi-browser pass, backup/restore drill record.
**R7 — Aggregation contracts and pagination (H-2, M-6, M-7).** Scoping contract, truncation signals, term-boundary and prior-term-debt tests.
**R8 — UX and support (H-8).**
**R9 — Documentation truth and hygiene (M-9, M-8, L-3, L-4).** Separately scoped; formatting must not ride along with functional changes.
**R10 — Acquisition evidence pack.** Indexed by the checklist in `docs/readiness/ACQUISITION_DUE_DILIGENCE_CHECKLIST.md`.

**Sequencing note:** R1 must be independently verified before R3–R5, because auth and financial tests run under a context that is currently not guaranteed to be the caller's. Any test executed before R1 is fixed may itself be unreliable.

---

## 14. DO NOT TOUCH areas

- Tag `m11-collections-control-plane` and commit `cc0f6af378015aa6c4deba10a4e126ef9d8ff165` — immutable.
- Tag `m10-reconciliation-control-plane`, which must continue to peel to `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`.
- M5–M11 implementation code.
- Migrations `0000`–`0037` as historical artefacts — remediation arrives as **new** migrations, never as edits to applied ones.
- Frozen financial paths: invoice → lines → payment → allocation → reversal/refund → receipt.
- Authoritative ledger architecture, reconciliation architecture, and collections architecture.
- Financial triggers and the M10 `ALLOCATED` guard — any change requires its own reviewed migration and evidence.
- RLS policies, centralized authz, CSRF, idempotency, and audit plumbing **design** — defects are fixed by tightening these, never by bypassing them.
- M10 case/evidence/candidate tables and M11 collections tables — M11 must remain a workflow/control layer that creates no authoritative financial truth.
- Append-only guarantees and any data-deletion path.
- `docs/security/M11_STAGING_VERIFICATION.md` — untracked evidence; preserve.
- The disposable-fixture cleanup technique (`session_replication_role=replica`) — must never be applied to non-disposable data.

---

## 15. Answers to the two standing questions

**Is SCOLAIRA ready for controlled pilot validation?**
**No — not with real data or real money.** It is ready for a **bounded, supervised, synthetic-data validation pilot** under the full compensating-control set in §12, and only if R1 items are either remediated or explicitly excluded from pilot scope by keeping the pilot single-tenant and link-free. The financial model supports a pilot; the isolation boundary and the release evidence do not yet support a pilot that touches a real school's real money.

**Is M12 justified?**
**No.** M12 would add capability on top of three unresolved isolation criticals and exceptional-path financial gaps, and would convert an audit into a product expansion — exactly what the standing mandate prohibits. The correct next move is **remediation and verification of the frozen product (R1–R4)**, followed by re-audit. M12 becomes discussable only after R1–R4 close with evidence and a second audit pass confirms no regression. Until then, M12 is not justified on technical, commercial, or due-diligence grounds.

---

## 16. Preservation statement

- Frozen revision: `cc0f6af378015aa6c4deba10a4e126ef9d8ff165` — unchanged.
- M10 tag peel target: `5841f2e94ff4ee9a908ef6963662feca4a6ec37c` — unchanged.
- Product, schema, migration, seed, financial-path, and database files: **not modified**.
- Git history: **not created, rewritten, amended, or falsified.**
- New files: this document and `docs/readiness/ACQUISITION_DUE_DILIGENCE_CHECKLIST.md` (documentation only, untracked, not committed).
- Pre-existing untracked file: `docs/security/M11_STAGING_VERIFICATION.md` — preserved.
- Audit was **read-only** with respect to the product. No remediation was performed, and none is implied by this document.
