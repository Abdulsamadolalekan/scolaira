# H-2 — Aggregation, Reporting, Term Boundaries & Pagination — CLOSEOUT

**Milestone:** H-2 (a.k.a. register item **R7**; folds in **M-6** and **M-7**).
**Frozen baseline:** `6ba8b149ebf7aeb80ef2ff68da31cbf554cccaab` (H-5).
**Status:** complete — verified on a fresh database, on an in-place 47 → 48 upgrade
carrying legacy rows, and through the typecheck / lint / build / unit+integration /
Playwright gates.
**Not a feature milestone, and not M12.** Historical migrations `0000`–`0047`, M10 and
M11 are untouched; frozen tags were not moved; no tag was created.

New artefacts:

`lib/db/migrations/0048_h2_scoping_pagination.sql`,
`lib/db/repo/{pagination,scoping,aggregates,staleness,financial-periods}.ts`,
`app/api/scoping/settings/route.ts`,
`app/api/financial-periods/{route,[id]/route,[id]/close/route}.ts`,
`tests/db/h2-scoping-pagination.test.ts` (17 tests),
`tests/db/h2-independent-reaudit.test.ts` (10 tests),
`docs/readiness/H2_SCOPE_MAP.md` (scope of record).

---

## 1. Why this milestone was selected

H-2's measured defect was not "a page is slow". It was that **the product showed two
different definitions of "what is owed" on adjacent surfaces, without labelling either**,
and that every capped list truncated **silently**. Measured on a 501-student tenant with a
current term plus prior-term debt (raw evidence: `/tmp/h2-measure-raw.txt`):

| surface | scope in code (pre-H-2) | figure | truth |
| --- | --- | --- | --- |
| dashboard headline | current term only | billed 250,000 / outstanding 250,000 kobo | — |
| debtors workbench | all terms | outstanding 450,000 kobo | — |
| prior-term debt | invisible on the headline | 200,000 kobo | present in the ledger |
| `/api/invoices` | fixed cap 200 | 200 rows of 501 | 301 rows silently missing |
| `/api/debtors` | fixed cap 500 | `debtorCount` 500, outstanding 25,000,000 | 501 debtors, 25,050,000 |
| `/api/students` | no cap at all | unbounded | — |
| severe-follow-up queue | suppressed whenever `severeCount > 0` | stale_followup hidden | — |
| reminder cooldown | literal `4` at the call site | — | threshold not in any contract |

A proprietor could see a current-term total next to an all-term arrears queue and
conclude the numbers were wrong; a bursar could export a register that was 301 invoices
short without being told. The remediation is not a bigger cap — it is an **explicit
contract** on every surface, and a boundary that is enforced by the database.

## 2. Scope of record

`docs/readiness/H2_SCOPE_MAP.md` is the scope of record; its decisions were followed
without amendment during implementation:

1. **Fold M-6 (silent truncation) and M-7 (staleness boundaries) into H-2.**
2. **One declared scope per surface**, from an explicit, auditable per-organization
   setting (`invoice_scope`: `ALL_TERM` default, `TERM` opt-in). Every payload carries
   its scope plus a human label, so no two surfaces can silently disagree.
3. **Partition, don't hide.** Invoices are classified once, in SQL, into an exhaustive
   3-way partition — `CURRENT_TERM`, `PRIOR_TERM` (carried forward: different term and
   due before the active term's start), `OTHER_TERM` — and `sum(buckets) = headline` is
   the tie-back invariant.
4. **Cursor or count on every capped list**: a shared `page` block
   (`{surface, limit, cap, capSource, returned, total, hasMore, nextCursor}`), with
   `total: null` only where a surface cannot count cheaply (the union reconciliation
   queue, which declares its overflow through `hasMore` + cursor).
5. **Term boundaries become a control**, not a convention: financial periods are
   bounded, non-overlapping windows enforced by the database, and a close is refused
   while the window still holds unresolved or unapplied money.
6. **Forward-only**: one new migration (`0048`); no historical migration edited.

Explicitly **out of scope** (unchanged, not started): H-4, H-6, H-8, H-9, A5, M12, CSV/PDF
export, billing-order enforcement, and any change to the authoritative ledger or to
RLS/FORCE-RLS posture beyond the two new tables and the `reminders` FORCE-RLS completion.

## 3. What was built

**Migration 0048** (six sections, each self-audited at the end):

1. `invoice_scope` enum + `surface_scope_settings` (one row per organization;
   `FORCE ROW LEVEL SECURITY`; the runtime role has no `DELETE`).
2. `financial_periods` (inclusive-day windows) + `trg_financial_period_no_overlap`
   (exclusion constraint, `23P01`) + `trg_financial_periods_immutable` (a closed period
   cannot be rewritten) + `trg_financial_periods_set_org`.
2b. `ALTER TABLE reminders FORCE ROW LEVEL SECURITY`.
3. `auth_invoice_scope_buckets(uuid, date)` — the exhaustive partition with billed /
   collected / outstanding / overdue / draft figures.
4. `auth_period_valuation(uuid)` — the as-of report for a window, including the
   `ALL_TERM` tie-back row that is emitted **even for an empty window**.
5. Grants: read on the two functions, `SELECT/INSERT/UPDATE` (never `DELETE`) on the two
   new tables.
6. A self-audit block that **refuses to complete the migration** unless RLS + FORCE RLS
   are on for `invoices, payments, payment_allocations, terms, students, reminders,
   surface_scope_settings, financial_periods`, both new functions are app-callable and
   free of `SECURITY DEFINER`, and the invariants it claims hold in *this* database.

**Application surface**

* `lib/db/repo/pagination.ts` — surface limits, base64url cursors bound to a surface,
  a **microsecond** sort key (`sortKeyUs`) used by both the SQL ordering and the emitted
  cursor, and `assertCursorKeys` (a malformed key is a 400, never a 500).
* `lib/db/repo/scoping.ts` — the declared scope, its labels, and the audited writer.
* `lib/db/repo/aggregates.ts` — the SQL partition, the JS mirror, register totals, the
  period valuation, `toIsoDay` normalisation.
* `lib/db/repo/staleness.ts` — `FOLLOWUP_THRESHOLDS` (7d / 14d / 4h, strict `>`),
  `AGING_THRESHOLDS`, `classifyReminderStaleness` → `NONE | FRESH | STALE | UNATTENDED`.
* `lib/db/repo/financial-periods.ts` — create / list / close with the immutability and
  money-state preconditions.
* Rewired: dashboard summary, invoices (register + page + per-row scope labels),
  payments, payment-links, students (now capped **and** declared), debtors (totals,
  staleness, thresholds), collections queue, reconciliation queue, collections detail
  audit and reconciliation payment detail audit (both now paged).
* UI: dashboard, invoices, debtors and students pages carry the declared scope and the
  truncation banner; the invoice register labels carried-forward rows.
* `remind`: the cooldown is echoed from the shared constant in the 429 body.

## 4. Contract (as implemented)

* **Scope** — every scoped payload carries `scope: {scope, label, isDefault, setting,
  termId, termName, cutoverOn, asOf}`. The dashboard adds `scope.kpis`, the invoice
  register `scopeClass`/`scopeLabel` per row, debtors `scope` + `thresholds`.
* **Pages** — `page: {surface, limit, cap, capSource, returned, total, hasMore,
  nextCursor}`; `returned ≤ limit ≤ cap`; `hasMore ⇒ nextCursor ≠ null`; a terminal page
  has `nextCursor: null`. Caps are **per surface** and declared in the payload, which
  supersedes the old global "max limit = 100" rule in `docs/API_CONTRACTS.md §III`.
* **Cursors** — base64url `{v:1, s:<surface>, k:[…]}`; foreign-surface, wrong-shaped or
  non-base64 cursors are `400 BAD_REQUEST`. Timestamp keys are microsecond integers, so a
  same-millisecond bulk insert can no longer be skipped between pages.
* **Periods** — `POST /api/financial-periods` requires `Idempotency-Key`, refuses
  overlaps with `409 PERIOD_OVERLAP`; `POST /api/financial-periods/{id}/close` answers
  `201` (closed), `200 {alreadyClosed:true}` (replay, frozen state unchanged), or `409`
  with `PERIOD_HAS_UNRESOLVED_PAYMENTS` / `PERIOD_HAS_UNALLOCATED_PAYMENTS` plus the
  measured counts in `details`.
* **Permissions** — `financial_period.manage` (OWNER, SCHOOL_ADMIN) and
  `financial_period.read` (+ FINANCE_OFFICER); the scope setting uses
  `org.settings.update`, so a FINANCE_OFFICER can read the declared scope but cannot
  change what the headline means (asserted).

## 5. Defects found while verifying (and fixed)

Each of these was found by evidence, not by reading code; none was fixed by weakening a
control.

1. **Carried-forward invoices were labelled `OTHER_TERM`.** The register classified
   scope by comparing a *display-formatted* due date (`"28 Nov 2025"`) against an ISO
   cut-over, which is a text comparison. Found by the contract suite (A3) on real data.
   Fixed by classifying on the stored day and adding `toIsoDay()` so no call site can
   feed a display string into a date comparison.
2. **A closed window's report moved.** `outstanding`/`overdue` were summed over the
   invoice's *current* status while `collected` was summed as-of, so a payment allocated
   *after* the window flipped an invoice to `PAID` and moved a closed window's
   outstanding by 21,000 kobo. Found by the independent re-audit. Fixed by deriving the
   as-of open population from as-of money (`total − collected_asof > 0`), so the report is
   genuine boundary evidence; a `PAID`-as-of invoice contributes nothing and no invoice
   is double-counted.
3. **ISO-truncated cursors skipped rows.** The cursor carried `toISOString()`
   (millisecond) keys while the ordering used full-precision timestamps: page 2 of a
   505-row fixture returned **zero** rows. Fixed with a microsecond sort key shared by the
   predicate and the cursor, on every keyset surface (invoices, payments, payment-links,
   audit, reminders, collections).
4. **Period overlap surfaced as a 500.** The repository read `e.code` while the driver
   error arrives wrapped (`DrizzleQueryError`), so a correct database refusal became
   "Internal error". Fixed by walking the cause chain → `409 PERIOD_OVERLAP`.
5. **Close refusals were not machine-readable.** The 409 buried the reason in
   `details.code`; the two reason codes are now the envelope's `error.code` (counts stay in
   `details`), matching the cooldown precedent.
6. **Malformed client cursors reached SQL** (`invalid input syntax for type bigint` →
   500). Fixed with `assertCursorKeys` → 400.
7. **One earlier-milestone expectation was superseded — deliberately, and recorded.**
   `tests/auth/m6-hardening.test.ts` asserted the dashboard headline was *implicitly*
   current-term. H-2 makes the default explicit and arrear-visible (`ALL_TERM`, scope map
   decision 2). The test now asserts M6's property under **both** declared scopes (the
   figure must equal an independently computed total for the scope the payload names,
   never a mix), asserts that a FINANCE_OFFICER cannot change it, and additionally pins
   `isDefault`. M6's original assertion still runs — under a scope that is now declared
   rather than assumed.
8. **Harness findings recorded so nobody "fixes" them in the product.** RLS/GUC cleanup
   between handler calls means direct SQL after a route call must re-establish tenant
   context; `INSERT ... SELECT` from an RLS-filtered table inserts **zero rows silently**
   (so a fixture that looks alive may be empty); the per-test `BEGIN`/`ROLLBACK` means
   rows created by another test are gone; `reminders`, `terms` and `collections_cases`
   carry state-consistency check constraints; the ledger refuses an allocation larger
   than the invoice's outstanding; `financial_periods` accepts no `DELETE` from the
   runtime role (asserted, not worked around).
9. **R1's composite-FK count test defined its set by coincidence.** It compared
   `auth_org_composite_fk_count()` (which counts the `*__org_fkey` convention) with a
   query counting FKs whose *parent* side includes `organization_id`. H-2's two new
   tenant tables made the two populations differ (43 vs 41). The test now asserts the
   helper against its documented set **and** asserts the composite-parent population
   separately, keeping both floors.

## 6. Evidence

**Suites.** `npx vitest run` → **44 files, 524 tests, 0 failures** (H-5 baseline: 42
files / 497 tests; +2 files and +27 tests are H-2's). `npx tsc --noEmit` clean.
`npm run lint` 0 errors (the repository's existing warning set only). `npm run build`
succeeds. `npx playwright test` → **36 passed**.

**Contract suite** `tests/db/h2-scoping-pagination.test.ts` — 17/17: declared scope and
partition tie-back; carried-forward debt visible, hiding it explicit and audited once;
page blocks on every capped surface; totals independent of page size; cursor walks that
cover every row exactly once (invoices 505, students 1005, debtors 505, payments,
collections, reconciliation queue); surface-bound and cap-respecting cursors; tenant
crossover; staleness boundaries; cooldown boundary; terminal pages; period overlap,
close refusal, idempotent replay, immutability, tenant isolation, no `DELETE`.

**Independent re-audit** `tests/db/h2-independent-reaudit.test.ts` — 10/10: an SQL
formulation written outside the app reproduces every bucket; the headline equals its own
partition and the source rows; the carried-forward row is labelled; a closed window does
not move when later money arrives and ties back to ledger timestamps; page blocks are
bounded and honest and a walk covers exactly `total`; wrong-shaped cursors are refused
(400); the two new functions are app-callable, invoker-rights, write-free and
tenant-scoped; the new tables are FORCE-RLS with no runtime `DELETE`; another tenant
cannot see or name them; overlapping windows are refused by the schema **with the API
bypassed**.

**Fresh install.** `scolaira_h2fresh` dropped and created empty, then migrated by the
runner: `new=48 total=48`, with the §6 self-audit notices and no exceptions. Objects
confirmed: `invoice_scope = {TERM, ALL_TERM}`; both tables `rowsecurity=true,
forcerowsecurity=true`; `reminders` FORCE RLS true; both functions app-callable;
triggers `financial_periods_{set_org,immutable,no_overlap}`; runtime `DELETE` = false on
both tables. Both H-2 suites then ran **against that database: 27/27**.

**Upgrade 47 → 48.** A purpose-built 47-state database was seeded with legacy rows
(organization, user, membership, session, term, 2 invoices, confirmed payment,
allocation, reminder, audit event) as the owner, under the application's own context
mechanism. Before/after the migration, per-table row fingerprints (`md5` of the ordered
row dump, under a valid tenant context) were **identical for all 11 tables** — the
upgrade neither rewrites nor re-derives historical data. After the upgrade the migration
runner reported `new=1 total=48`, and the **runtime role** (app role + tenant context)
reads the legacy rows (2 invoices, 1 payment, 1 reminder) with the new tables empty
(no backfill). Both H-2 suites then ran against the upgraded database: **27/27**.

**Databases.** `scolaira` 48, `scolaira_test` 48, `scolaira_h2fresh` 48, `scolaira_upgrade`
48. `scolaira_scratch` remains the 47-state manual playground it always was (it is not a
gated database and carries no ledger).

## 7. Preservation statement

* M10/M11 frozen history, tags and the authoritative financial ledger: untouched.
* R1 (context binding, composite FKs, public-context proof), R2 (privilege and RLS),
  R3 (auth lifecycle, public surface), H-5 (operational hardening): all invariants still
  asserted by their own suites, which pass. The new SQL functions follow R1's rules —
  read-only, invoker-rights, `auth_%`-named, no writes to any ledger table (scanned by
  the R1 re-audit's definition-based ledger-writer check).
* `reminders` gains FORCE RLS (the register's H-1 completion for that table); no policy
  was narrowed, no privilege was added beyond `SELECT/INSERT/UPDATE` on the two new
  tables and `EXECUTE` on the two new read-only functions.
* Idempotency (M9/M10) and audit controls are unchanged; the new mutating endpoints
  require `Idempotency-Key` and write audit events exactly once.

## 8. Classifications

**PROVEN** — one declared scope per surface with a labelled, audited setting; the
partition is exhaustive and ties back to source rows and to the headline on real data; a
carried-forward invoice is labelled as carried forward; every capped surface declares
`limit/cap/returned/total/hasMore` and walks to exhaustion covering each row exactly
once; cursors are surface-bound, shape-validated (400 not 500) and microsecond-precise;
staleness and cooldown boundaries are declared constants, enforced server-side and echoed
to the client; periods cannot overlap (database-enforced, proven with the API bypassed),
a close is refused while the window holds unresolved or unapplied money, a replay is
idempotent, a closed window does not move when later money arrives, and its figures tie
back to ledger timestamps; the two new tables are tenant-isolated with FORCE RLS and no
runtime `DELETE`; the two new functions are app-callable, invoker-rights and write-free;
fresh install and 47 → 48 upgrade both verified, the latter with legacy row fingerprints
byte-identical and readable by the runtime role afterwards.

**ASSUMED** — that a school's declared scope choice is made once and revisited
deliberately (the change is audited, but nothing prompts a review); that proprietors read
the truncation banner on very large registers rather than exporting the first page.

**NOT-YET-VERIFIED** — performance at production volume: the caps and the walk are
correctness-verified on ~1,000-row tenants, but no soak test was run on a
1,000,000-invoice database, and the reconciliation queue's `total` is deliberately
`null` (an uncounted union) so a very large queue's overflow is signalled by `hasMore`
rather than by a count; the period valuation's cost on a wide window is unmeasured; UI
behaviour of the truncation banners was exercised by the existing Playwright suite, not
by a new dashboard/register E2E scenario for a >cap tenant; an upgrade from a
*production* 47-state copy (verified on a purpose-built database with seeded legacy rows).

## 9. Residual risks and limitations

* The declared scope is organization-wide (one setting), not per-surface independent
  values. That is the recorded decision (decision 2) and it is what makes "no two
  surfaces disagree" structurally true; a future request for per-user scope is a
  different conversation.
* The as-of valuation is derived from ledger timestamps, not from a stored snapshot. That
  is what makes a closed window immovable under *later* money; it also means a
  back-dated allocation (one whose `allocated_at` falls inside the window) is reflected —
  by design, because the ledger's timestamps are authoritative.
* `total` on the reconciliation queue is `null` by contract; consumers must use
  `hasMore`/`nextCursor`.
* The invoice register's per-row scope label is computed in TypeScript from the stored
  day; the SQL partition and the JS mirror are both tested against source rows, but they
  are still two evaluation sites (this is why the display-date defect existed and why
  `toIsoDay` is enforced).

## 10. How to verify this yourself

```bash
set -a; . ./.env.test; set +a
npx vitest run                                   # 44 files / 524 tests
npx vitest run tests/db/h2-scoping-pagination.test.ts tests/db/h2-independent-reaudit.test.ts
npx tsc --noEmit && npm run lint && npm run build
npx playwright test                              # 36 passed

# fresh install
sudo -u postgres dropdb --if-exists scolaira_h2fresh
sudo -u postgres createdb -O scolaira_owner scolaira_h2fresh
DATABASE_MIGRATION_URL=postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_h2fresh \
  npx tsx scripts/migrate.ts                     # new=48 total=48 + H-2 self-audit notices

# upgrade (any 47-state database)
DATABASE_MIGRATION_URL=…47-state-db… npx tsx scripts/migrate.ts   # new=1 total=48
```
