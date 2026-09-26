# R1 — Tenant Isolation Hardening: Closeout

**Milestone:** R1 — Tenant Isolation Hardening (C-1, C-2, C-3)
**Baseline:** `cc0f6af378015aa6c4deba10a4e126ef9d8ff165` (`m11-collections-control-plane`, frozen)
**M10 frozen baseline:** `5841f2e94ff4ee9a908ef6963662feca4a6ec37c` (`m10-reconciliation-control-plane`, frozen)
**Status:** R1 complete — C-1, C-2 and C-3 independently demonstrated closed; no known cross-tenant exploit remains.

Evidence labels used throughout: **PROVEN** (measured against the running
database, reproducible by a test in this repository) · **ASSUMED** (reasoned but
not measured) · **NOT YET VERIFIED** (out of this milestone).

---

## 1. Why R1 was selected

The pre-R1 reconnaissance reproduced three tenant-isolation defects against the
frozen tree as the runtime role (`scolaira_app`), which the priority hierarchy
places above every other category of work:

| Finding | Reproduced pre-R1 behaviour |
| --- | --- |
| C-1 | Context set by one request remained readable on the pooled connection by the next unrelated statement (5 of 11 identity variables were cleared; correctness depended on `max: 1`) |
| C-2 | No `(organization_id, id)` constraint existed anywhere; children referenced parents by bare `id`, and FK checks bypass RLS, so a cross-org reference was accepted and made triggers recompute **the other tenant's** money |
| C-3 | `auth_set_public_context('<org>')` with **no bearer token** returned `true`; afterwards `SELECT count(*) FROM invoices` returned another tenant's invoice and `auth_is_tenant_authorized()` returned `true` |

---

## 2. Root causes and remediation

### C-1 — request context bleeding between requests

**Root cause.** Authorization context was written with `set_config(…, is_local
=> false)` (SESSION scope) on whatever pooled connection served the statement.
Cleanup was a best-effort application call (`clear_app_context()`) that covered
5 of the 11 identity-bearing variables; `acting_role`, `platform_admin_id`,
`platform_token`, `tenant_token`, `public_context` and `public_link_token` were
never reset. Nothing failed closed: an absent or invalid context simply meant
"no rows" rather than "refuse to run".

**Remediation (forward-only).**

* Migration `0039_r1_scoped_context.sql` — `auth_r1_scope_active()` plus
  `auth_scope_{system,seed,tenant,platform}_local()`, all writing with
  `is_local => true`; the legacy session-scoped setters become scope-aware so
  existing callers cannot silently write at the wrong layer.
* `lib/db/scope.ts`, `lib/db/context.ts`, `lib/db/scope-registry.ts` — a scope
  owns the connection that runs its queries (reserved connection when the pool
  can spare one, serialized shared connection when it cannot), establishes
  context transaction-locally, publishes it through AsyncLocalStorage so every
  `getSql()`/`getDb()` inside the callback resolves to that connection, and at
  exit clears **every** identity variable on both layers and reads them back,
  raising `ScopeIntegrityError` if the connection cannot be proven neutral.
* `lib/db/index.ts`, `lib/db/tenant.ts`, `lib/auth/index.ts` — every
  identity-bearing flow (session trust gate, login/logout, registration,
  password reset/change, organisation switch, tenant routes, platform support)
  now runs inside a scope. Pool size is configurable and is **not** a security
  boundary.

**Deliberate non-reliance:** the guarantee does not depend on `max: 1`, on
application cleanup running, or on the connection being fresh — Postgres itself
reverts the context when the scope's transaction ends, and the read-back catches
anything that survived.

### C-2 — cross-tenant financial parent references

**Root cause.** Children referenced parents by `id` alone. Foreign keys are
enforced without consulting row security, so with no `(organization_id, id)`
constraint, a child row belonging to org A could reference a parent belonging to
org B — and the financial triggers resolve those parents by id, so the reference
did not merely "point" at another tenant's data, it caused the database to
recompute the other tenant's `paid_kobo` / `unallocated_kobo`.

**Remediation.** Migration `0038_r1_organization_composite_fks.sql`: 16 unique
`(organization_id, id)` parent indexes and 37 organization-composite foreign
keys across 17 tables, plus a self-audit that fails the migration if any
relationship was missed and `auth_org_composite_fk_count()` for monitoring.
Trigger bodies were **not** modified.

### C-3 — public-context and payment-link authorization

**Root cause (three layers, all reached and closed).**

1. `0013_public_context_fix.sql:55-74` and `0034:107-145` — the public marker
   was self-asserted: `auth_set_public_context(organization_id)` accepted a
   caller-chosen tenant. Migration `0040_r1_public_context_proof.sql` replaced
   it with a proof bound to `(token, organization, backend pid)`, minted only by
   an owner-executable SECURITY DEFINER, revoked the self-asserted setters,
   gated every public policy on the proof, made unusable links raise SQLSTATE
   `28000`, and resolves the tenant from the link row — never from a parameter.
2. `auth_is_tenant_authorized()` (historical, migration 0013) returned `true`
   whenever the public marker was set with an organisation present. Because
   every legacy `*_tenant_isolation` policy is an `ALL` policy containing
   `auth_is_tenant_authorized() AND organization_id = app.organization_id`,
   **one valid link token conferred full row-level access — read, insert, update
   and delete — to that organisation's tenant tables.** Measured before the fix
   in public context with one legitimate token: `UPDATE invoices … RETURNING id`
   → 1 row, `UPDATE students … RETURNING id` → 1 row, `INSERT INTO payments
   (… 'CONFIRMED' …)` → accepted. Migration
   `0042_r1_public_context_not_tenant.sql` removes the shortcut (public context
   is anonymous bearer authorization, never membership) and additionally makes
   `audit_events_public_insert` require the bearer proof — previously it
   checked only `app.organization_id` and no credential at all.
3. The public submission route wrote `INSERT INTO payments … RETURNING …`.
   Under row security a `RETURNING` row must also be SELECT-visible, which a
   public bearer correctly is not — so the route had only ever worked *because*
   of the over-authorization removed in (2). Migration
   `0043_r1_public_submit_entrypoint.sql` moves the mutation into
   `auth_public_submit_payment(token, …)`: authority is the bearer token, it
   re-resolves the link, validates the invoice inside the token's own tenant,
   mints the proof, writes the PENDING payment and its audit row **through the
   existing proof-gated policies** (it satisfies RLS, it does not bypass it),
   returns the identifiers explicitly, and restores the caller's context on both
   the success and the error path. Public context now has **no direct write
   privilege to any table**.

Also in R1: `0041_r1_public_probe_fix.sql` — `auth_probe_public_link()`
reported `'ACTIVE'` for tokens that do not exist, because it consulted `FOUND`
after a later `PERFORM` had reset it (so the "not found" branch was
unreachable); the probe now reports the truth, restores the GUC it used, and an
absent token fails closed with the same `28000` class as a revoked one.

### Additional finding closed inside R1 (found by the independent re-audit)

Migration `0044_r1_runtime_privilege_hardening.sql`. The post-migration grant
step (`scripts/migrate.ts`, `tests/global-setup-db.ts`,
`scripts/provision-db.sh`) ran `GRANT ALL PRIVILEGES ON ALL TABLES … TO
scolaira_app` and only then revoked a hand-picked list — re-granting everything
the migrations had revoked, including `REVOKE ALL ON app_meta` from 0010.
Measured before the fix: `has_table_privilege('invoices','TRUNCATE') = true`
and `has_table_privilege('app_meta','SELECT') = true`. **TRUNCATE is not
subject to row-level security**, so RLS, FORCE RLS and every append-only
`REVOKE UPDATE, DELETE` in the schema were powerless against it: a
runtime-role compromise could have destroyed authoritative financial history and
the tenant-context HMAC secret. The runtime role now holds SELECT/INSERT/UPDATE/
DELETE only, `app_meta` is owner-only, `CREATE` on schema `public` is removed
from the runtime role, and the grant step itself now grants the explicit DML
set so a fresh install cannot re-open the hole.

---

## 3. Migrations introduced (forward-only; `0000`–`0037` untouched)

| # | Migration | Purpose |
| --- | --- | --- |
| 0038 | `r1_organization_composite_fks` | C-2: 16 parent unique indexes, 37 composite FKs, self-audit, `auth_org_composite_fk_count()` |
| 0039 | `r1_scoped_context` | C-1: scope-local context functions; legacy setters made scope-aware |
| 0040 | `r1_public_context_proof` | C-3: proof-bound public context; self-asserted setters revoked; unusable link `28000` |
| 0041 | `r1_public_probe_fix` | C-3: truthful link-status probe; GUC-restoring resolvers; `search_path` hardening |
| 0042 | `r1_public_context_not_tenant` | C-3: public context is not tenant context; public audit insert proof-gated |
| 0043 | `r1_public_submit_entrypoint` | C-3: credential-gated public submission; no public table write privileges; `next_doc_number` restricted |
| 0044 | `r1_runtime_privilege_hardening` | Privileges: no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN; `app_meta` owner-only; no schema CREATE |

All seven apply cleanly on a fresh database (44 migrations total) and are
idempotent on replay (`new=0 total=44`).

## 4. Database constraints, privileges and RLS changes

* **Constraints:** 37 organization-composite FKs + 16 unique `(organization_id,
  id)` indexes; all `NOT NULL`-validated and non-deferrable (asserted by test).
* **Privileges:** runtime role reduced to DML; `app_meta`, `login_attempts` and
  `rate_limits` corrected; `next_doc_number(text)` no longer executable by the
  runtime role; no `CREATE` on `public`; only
  `auth_public_submit_payment(text,bigint,text,text,text,text)` is app-executable
  among `auth_public_*` functions.
* **RLS:** 37 tables with RLS, 35 with FORCE RLS. The two exceptions are
  deliberate and bounded: `app_meta` (owner-only, no policies, read solely by
  SECURITY DEFINER minters — FORCE would break them) and `reminders` (owner-side
  SECURITY DEFINER paths read it without tenant context). Neither is reachable
  by application traffic: the runtime role is **not** the table owner, so RLS
  applies to it on both tables — **PROVEN**.
* **Public policies** remain proof-gated and are now defence in depth rather
  than the only line: `invoices_public_lookup`, `students_public_lookup`,
  `organizations_public_lookup`, `payment_links_public_token_lookup`,
  `payments_public_insert(2)`, `audit_events_public_insert`.

## 5. Regression coverage added (permanent)

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/db/r1-context-isolation.test.ts` | 14 | scope/connection binding, exclusivity, pool reuse, concurrency across 2 orgs, serialized single-connection pools, nested scopes, forged/stale/absent context, session-scoped writes inside a scope, revocation on error, system scope limited to identity tables |
| `tests/db/r1-composite-fk.test.ts` | 48 | catalog completeness, per-relationship forged inserts (37 relations), enforcement-layer matrix, trigger lookups against foreign parents, legitimate-path regression, coverage guards |
| `tests/db/r1-public-context.test.ts` | 20 | forged marker/org/token/proof, revoked-setter privilege, tenant-session escalation attempts, cross-tenant reads/writes, unusable-token matrix, replay after re-issue, entry-point contract + audit attribution |
| `tests/db/r1-independent-reaudit.test.ts` | 17 | independent re-audit (section 6) |
| **Total added** | **99** | |

Existing suites were strengthened, never weakened: `tests/db/m10-reconciliation.test.ts`
(forged-context insert now expects a fail-closed refusal and keeps a
forged-GUC probe), `tests/auth/m8-term-billing.test.ts` (self-contained under
transaction-local scoping), `tests/support/seed.ts` (unique slugs/e-mails so
committed fixtures cannot collide). No test was deleted, skipped or converted
into a mock.

## 6. Independent re-audit (conducted against the security contract)

`tests/db/r1-independent-reaudit.test.ts` was written from the threat model —
identity forgery, credential substitution, cross-tenant reach, write authority,
context persistence, privilege surface — and executed against the frozen
implementation. It **found one real defect** (runtime privileges, section 2) and
it also falsified three of my own test expectations, which were corrected in
favour of the stricter reading (audit rows are re-attributed by the binding
trigger; `RETURNING` visibility is the reason the public write needed an entry
point; rejections may legitimately come from the constraint layer).

Final re-audit result: **17/17 passed**, including:
* 9 forged-identity combinations, none of which authorises anything;
* 10 token variants (case, whitespace, truncation, prefix, foreign, revoked,
  expired, empty, SQL-ish) — only the exact live token authorizes;
* proof replay across transactions — no cross-tenant effect;
* public context performing 10 write attempts — zero mutations outside the one
  sanctioned PENDING path;
* a tenant session attempting 10 cross-tenant writes — zero reach;
* pool neutrality after tenant/public/system scopes and after a poisoned error
  path;
* 7 privilege/DDL escalation attempts — all refused with `42501`.

## 7. Tenant isolation under concurrency (evidence)

PROVEN by `tests/db/r1-context-isolation.test.ts`: 8 interleaved scope-pairs
across two organisations (16 concurrent scopes) on a 4-connection pool — each
scope observed its own `app.organization_id`, saw zero rows of the other tenant
both by primary key and by predicate, and mutated zero foreign rows; both
fixture inserts reported distinct backends (real concurrency, not
serialization). On a 1-connection pool, four concurrent scopes serialized
(maximum in-flight = 1) instead of sharing a transaction, each still seeing its
own context. Connection reuse after a scope leaves the pooled connection
identity-free (verified by reserving *every* connection in the pool and reading
all 11 context variables back).

## 8. Financial non-interference

PROVEN. In the C-2 suite the canonical forgery (org A payment allocated to an
org B invoice) is refused and org B's `invoices.paid_kobo`, `total_kobo`,
`status`, `payments.unallocated_kobo`, `status` and allocation count are
**byte-for-byte identical** before and after, as is org A's own payment. The
public submission path produces exactly one `PENDING` payment with
`unallocated_kobo = 0` and one audit row attributed to the link's tenant —
authoritative money is still created only by the bursar's confirm path. No new
ledger, shadow balance or competing truth was introduced: R1 changed *who may
write* and *on which connection*, never *what is written* or how it is derived.

## 9. M10 / M11 preservation

* M10: `tests/auth/m10-reconciliation.test.ts` and
  `tests/db/m10-reconciliation.test.ts` green; the `ALLOCATED` guard, candidates,
  evidence and reconciliation state machine are untouched; the only test edit
  widened a *forged-context* expectation to accept the fail-closed guard that
  now fires first (`['42501','23514']`) — the assertion was strengthened, not
  relaxed.
* M11: `tests/db/m11-collections.test.ts` and
  `tests/auth/m11-collections-routes.test.ts` green; the collections state
  machine, case events and reminder surfaces were not modified.
* `0000`–`0037` unmodified; the `m10-reconciliation-control-plane` tag still
  peels to `5841f2e9…` and `m11-collections-control-plane` to `cc0f6af3…`.

## 10. Full regression result

| Check | Reference | R1 result |
| --- | --- | --- |
| Vitest (full) | 31 files / 279 tests | **35 files / 378 tests — PASS** |
| Playwright (chromium) | 32/32 | **32/32 — PASS** |
| Production build | 48/48 pages | **48/48 pages — PASS** (exit 0) |
| TypeScript | PASS | **PASS** (`npx tsc --noEmit`) |
| Migration fresh install | — | 44/44 applied from empty schema |
| Migration replay | — | `new=0 total=44` |
| Runtime privileges | — | 0 tables with TRUNCATE; `app_meta` owner-only; no schema CREATE |
| RLS / FORCE RLS | — | 37 RLS / 35 FORCE (exceptions argued in §4) |
| `git diff --check` | clean | clean |

Environment: PostgreSQL 17.11, Node v20.20.2.

## 11. Residual limitations and risks

1. **Rate limiting on the public submission path.** A valid link token can
   create repeated PENDING payments (each consuming a document number). This is
   a resource-abuse risk, not an isolation breach; link revocation is the
   current mitigation. Recommend an explicit rate limit / attempt cap.
2. **`reminders` and `app_meta` are not FORCE RLS** — deliberate, argued in §4;
   the runtime role is subject to RLS on both. Enabling FORCE would require
   first removing owner-side SECURITY DEFINER reads that legitimately run
   without tenant context.
3. **Re-audit scope.** The independent re-audit attacked the C-1/C-2/C-3
   surfaces and the runtime privilege model. It is not a general product
   security review: CSRF, idempotency and authz semantics were inspected only
   for interference and were not re-derived.
4. **Probe-and-resolve double read.** The public routes resolve the link once
   outside the scope for status disambiguation and again inside the scope for
   authorization. Both are bearer-bound and fail closed; the duplicate read is
   a performance, not a security, characteristic.
5. **Out-of-R1 findings remain open** (unchanged by this milestone): non-atomic
   payment reversal path, optional `Idempotency-Key`, dashboard/reminder
   aggregation scope correctness, health endpoint always reporting `ok`,
   `format:check` drift across 183 files, and the REFUND path leaving
   `unallocated_kobo` unrestored.

## 12. R1 exit criteria

| Criterion | Status |
| --- | --- |
| C-1 independently demonstrated closed | **PROVEN** |
| C-2 independently demonstrated closed | **PROVEN** |
| C-3 independently demonstrated closed | **PROVEN** |
| No known cross-tenant exploit remains | **PROVEN** within the audited surface |
| Every correction has root cause → smallest remediation → permanent regression test → adversarial test → concurrency proof → direct-SQL bypass check → RLS/FORCE check → privilege check → M10 regression → M11 regression | **PROVEN** (§2, §5, §6, §7, §9) |
| Frozen history preserved | **PROVEN** (§9) |
| Acquisition-readiness evidence updated only where closure is proven | **DONE** — labels only where §7/§8 evidence exists; no PASS flips without proof |
