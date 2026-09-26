# Exceptional-Path Financial Integrity — Closeout

**Milestone:** post-M11 remediation, milestone selected as **R2 — Exceptional-Path Financial Integrity**
(H-7 core, with M-2 and M-3 closed as satellites of the same code paths)
**Predecessor:** R1 — Tenant Isolation Hardening (C-1/C-2/C-3 + C-4), commit `0683702`
**Frozen baseline untouched:** `m11-collections-control-plane` → `cc0f6af378015aa6c4deba10a4e126ef9d8ff165`,
`m10-reconciliation-control-plane` → `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`
**Migrations added:** `0045_r2_exceptional_path_integrity.sql` (forward-only; `0000`–`0037` untouched)
**Date:** 2026-09-23

Every claim below is labelled **PROVEN** (executed against the running system, evidence named),
**ASSUMED** (reasoned, not executed) or **NOT YET VERIFIED**.

---

## 1. Why this milestone was selected

Reconnaissance re-verified every audit finding against the code and the running database. C-1, C-2, C-3 and
C-4 were already closed by R1. Of what remained, three facts decided the order:

1. **H-7 was the only remaining finding classified "Hard gate" with no configuration mitigation.** H-3
   (public payment link) is also a hard gate, but the audit itself records the mitigation "disable public
   links for the pilot"; the exceptional-path defects cannot be switched off — they fire on ordinary
   bursar behaviour.
2. **The failure mode is silent corruption of authoritative financial truth with no adversary required.**
   A retried submit, a double-click, or a flaky network is enough. Everything else on the list is an
   operational, UX or evidence gap.
3. **Measured, not asserted.** Before writing any fix, the pre-R2 behaviour was reproduced on the running
   database (probe output in §3). The financial hierarchy in the standing directive puts isolation first
   (closed in R1) and financial integrity second (this milestone).

---

## 2. Findings, classified

| # | Finding (from `POST_M11_READINESS_AUDIT.md`) | Classification | Evidence |
|---|---|---|---|
| H-7.1 | Reversal idempotency is SELECT-then-INSERT; no `UNIQUE (payment_id, reference)` on `reversals` | **CONFIRMED** | Catalog: only `reversals_org_number_idx`. Probe: two connections replaying the route's exact sequence both passed the guard and both inserted → **2 reversals with the same reference**, invoice `paid_kobo` 1,000,000 → **0 / ISSUED** (an unintended *full* reversal built from two individually-legal halves) |
| H-7.2 | Payment creation has "no unique constraint" on the reference | **PARTIALLY DISPROVEN, then narrowed** | `payments_org_reference_unique_idx` has existed since `0001_integrity.sql:126`. Two real gaps remained: the predicate omitted method `OTHER` (measured: **2 `OTHER` payments sharing one reference**), and it had no status predicate, so a `FAILED` attempt permanently blocked the legitimate retry the application explicitly permits — which then died as a raw `23505` → 500 |
| H-7.3 | `Idempotency-Key` optional on payment creation, reversal, allocation, receipt, void | **CONFIRMED** | No handler required it; the shipped UI sent none at all (`record-payment-form.tsx`, `payment-actions.tsx`, `invoice-actions.tsx`), so the protection was absent in practice, not merely optional |
| H-7.4 | Receipt issuance and invoice void read their preconditions outside a transaction | **CONFIRMED** | `app/api/receipts/route.ts`, `app/api/invoices/[id]/void/route.ts` read on `db`, then mutated on `db` |
| M-3 | A receipt renders from live ACTIVE allocations while `amount_kobo` is frozen | **CONFIRMED** | `receipts` had no snapshot column; `GET /api/receipts/[id]` joined current ACTIVE allocations |
| M-2 | Invoice void not transactional | **CONFIRMED** | same route as H-7.4 |
| **R2-1** (new) | The printable receipt page never rendered: it POSTed with neither CSRF header nor key and read `data.receiptId`, a field the route never returned | **CONFIRMED** | `app/(app)/payments/[id]/receipt/page.tsx` always fell through to "Could not issue receipt" |
| **R2-2** (new) | The route boundary read `error.code`, but Drizzle wraps driver errors, so the SQLSTATE was undefined and database-enforced conflicts surfaced as 500 | **CONFIRMED** | Re-audit B4: allocation duplicate answered `INTERNAL` instead of 409 |
| **R2-3** (new) | Unmapped `P0001` from the financial triggers surfaced as 500 | **CONFIRMED** | Re-audit B4: a partial reversal (documented as unsupported in M2) answered 500 rather than the operator instruction the trigger already writes |

Nothing was declared closed on the strength of the audit's own text.

---

## 3. Measured pre-fix evidence (PROVEN)

Executed as the runtime principal against the migrated database, before any remediation:

```
[probe] connection A saw 0 existing reversals before insert
[probe] connection B (same reference, concurrent): inserted (saw 0 existing)
[probe] reversals with the SAME reference for one payment: 2
[probe] invoice after the duplicate reversals: paid_kobo=0 status=ISSUED
[probe] OTHER payments sharing one reference (no DB guard): 2
```

Both connections followed the route's own sequence (guard `SELECT`, then `INSERT`); each reversal was
individually legal; together they reversed a payment nobody had agreed to reverse.

---

## 4. Remediation

### 4.1 Database (`0045_r2_exceptional_path_integrity.sql`) — PROVEN

1. **`reversals_payment_reference_unique_idx` — `UNIQUE (payment_id, reference) WHERE reference IS NOT NULL`.**
   The guarantee the route's own header comment already claimed, now enforced where concurrency can be
   arbitrated.
2. **`payments_org_reference_live_unique_idx` — `UNIQUE (organization_id, reference) WHERE reference IS NOT NULL
   AND method <> 'CASH' AND status NOT IN ('FAILED','REJECTED')`**, replacing the `0001` index. This is the
   invariant the application always intended: *one live payment per teller reference*, every non-cash method
   covered by the database, and a superseded attempt no longer blocking a retry.
3. **`receipts.allocations_snapshot` (jsonb)** with a `jsonb_typeof = 'array'` CHECK and a write-once trigger
   (`receipts_snapshot_immutable_trg`). The document of record can no longer be rewritten by a later
   reversal — nor by direct SQL.
4. **Fail-closed pre-checks.** If a database already contains a conflicting pair (possible only through the
   race this migration closes), the migration aborts naming the rows rather than silently picking a winner.
   Because `reversals`/`payments` are FORCE-RLS tables and the migration runs as the owning role, the
   pre-check lifts FORCE **transactionally only**; DDL is transactional, the runtime role is unaffected
   either way, and the self-audit fails the migration if `relforcerowsecurity` is not restored.
5. **Self-audit** asserting both indexes exist with the intended predicates, the superseded index is gone,
   the column and trigger exist, and FORCE RLS is intact.

### 4.2 Application — PROVEN

| Route | Change |
|---|---|
| `POST /api/payments` | `Idempotency-Key` **required** (existing `lib/m9/idempotency` boundary); a `23505` from the new guard is mapped to the conflict the route always intended, naming the surviving payment |
| `POST /api/payments/[id]/reverse` | key required; the reference layer is kept and now *replays the committed winner* when the database refuses a duplicate |
| `POST /api/payments/[id]/allocate` | key required; `23514`/`23505` mapped to 409 with the trigger's operator-facing message |
| `POST /api/receipts` | one transaction: read payment → read allocations → guard → insert receipt **with its snapshot** → audit → complete the key. Concurrent issues converge on the single ISSUED document (M9 index) and the loser re-reads the winner |
| `POST /api/invoices/[id]/void` | one transaction: read → balance guard → void → audit; key required so a retry replays instead of re-deciding on a fresh read |
| `POST /api/p/[token]/submit` | a duplicate live reference answers a stable 409 ("A payment with this reference has already been recorded…") instead of echoing a constraint name |
| `lib/db/pg-error.ts` (new) | bounded cause-chain SQLSTATE/message reader — the reason R2-2 existed |
| UI (4 components) | the client actually sends `Idempotency-Key` on every financial mutation; the receipt page sends its CSRF token, a key, and reads `receipt.id` |

No trigger body, policy, RLS setting, ledger semantic or state machine was modified. The M10 `ALLOCATED`
guard, the M11 collections machine, append-only tables, CSRF, authorization and audit controls are untouched.

---

## 5. Adversarial tests added (PROVEN)

| Suite | Tests | Focus |
|---|---|---|
| `tests/db/r2-exceptional-path-integrity.test.ts` | 20 | mandatory key on five routes; replay/reuse semantics; concurrent reversal, payment, receipt, allocation; receipt snapshot reproducibility and write-once; **raw-SQL race replay of the pre-R2 sequence** (both connections pass the guard, database refuses the second, invoice moves once); retry-after-FAILED allowed; guard scoped per organization; void audit coupling; full lifecycle tie-out |
| `tests/db/r2-independent-reaudit.test.ts` | 16 | written against the contract, not the implementation: key bypass, cross-user and cross-tenant key reuse, key repurposing, trimmed-reference replay, raw-SQL duplicate, spoofed tenant, legitimate no-reference corrections, forged/cleared snapshot shape, receipt after full reversal, PENDING duplicate, CASH/casing rules, cross-org reference, cross-tenant reach on all four routes, and a cross-cutting invariant sweep |

The independent re-audit **failed twice against the first implementation** (R2-2, R2-3) and both defects
were fixed before the milestone was called complete.

Existing suites were updated only where the new mandatory contract requires a header, and the assertions
were kept or strengthened (receipt replay now asserts the stored status *and* the `Idempotent-Replayed`
header). No assertion was weakened, and no test was deleted.

---

## 6. Regression results (PROVEN)

| Check | Result | Reference |
|---|---|---|
| Vitest (full) | **37 files / 414 tests pass** | R1 baseline 35/378; M11 baseline 31/279 |
| M10 reconciliation (db + routes) | **11/11** | frozen control plane |
| M11 collections (db + routes) | **15/15** | frozen control plane |
| R1 isolation suites | **99/99** | unchanged |
| Playwright (chromium) | **32/32** | baseline match |
| Production build | **exit 0, 48/48 pages** | baseline match |
| TypeScript | **clean** | — |
| Migration upgrade path (M11 → current) | **new=0 total=45** | replay on the previously migrated database |
| Migration fresh path (empty schema) | **new=45 total=45** | full apply incl. self-audits |
| Migration re-run | **new=0 total=45** | idempotent |
| RLS / FORCE RLS | **37 / 35** | unchanged (the two exemptions remain deliberate) |
| Runtime-role TRUNCATE | **0 tables** | R1/C-4 posture preserved |
| `git diff --check` | **clean** | — |

---

## 7. Financial non-interference (PROVEN)

* **Lifecycle tie-out** (`F1`): invoice 1,000,000; payment A 400,000 allocated and receipted; payment B
  600,000 allocated → `paid_kobo` 1,000,000 / `PAID`; B reversed in full → `paid_kobo` 400,000 /
  `PARTIALLY_PAID`, allocations `[ACTIVE 400,000, REVERSED 600,000]`, payments
  `[400,000 CONFIRMED 0 unallocated, 600,000 REVERSED 600,000]`, and the receipt still reports 400,000 from
  its own snapshot. Every figure is asserted literally.
* **Invariant sweep after every attack** (`re-audit F1`): invoice `paid_kobo` equals the sum of ACTIVE
  allocations; `0 ≤ unallocated ≤ amount`; reversal totals never exceed the payment; every VOID invoice has
  exactly one audit row and no refused void has any; every snapshot sums to its receipted amount.
* **No second source of truth was introduced.** The snapshot is document data captured at issue time, not a
  ledger: allocations remain the only authority for invoice balances, and `reversals` remains append-only.
* **Refund semantics unchanged** (M-5): the receipt investigation exercised `type: 'REFUND'` and observed the
  existing `REFUNDED` terminal state — behaviour preserved, not reinterpreted.
* **Whole-allocation reversal rule unchanged** (M-4): still enforced by the frozen trigger; the only change
  is that the refusal now reaches staff as a 400 carrying the trigger's instruction instead of a 500.

---

## 8. Preservation evidence

* Frozen tags verified before and after: `m11-collections-control-plane` → `cc0f6af3…`,
  `m10-reconciliation-control-plane` → `5841f2e9…`. No history was rewritten; `0000`–`0037` are byte-identical.
* The only DDL touching an existing object is `DROP INDEX payments_org_reference_unique_idx` — a *guard*
  index, replaced by a strictly-stronger-and-correctly-scoped one in the same transaction; no data or
  constraint semantics were reinterpreted.
* M10/M11 suites and the R1 suites are green unmodified (only M6/M7 call sites gained the now-required header).

---

## 9. Residual limitations (honest)

* **Public submission is still the weakest financial path (H-3, next milestone).** It has no rate limit and
  no idempotency boundary; the payer-supplied amount is not yet bound to the link's fixed amount; and the
  bearer token is still persisted in `payments.notes` / audit metadata by `auth_public_submit_payment`.
  This milestone only makes a duplicate *reference* answer a clean 409. **NOT YET VERIFIED for closure.**
* **H-4 (registration transactionality), H-5 (auth lifecycle/reset critical section), H-6 (health/E2E
  evidence), H-2 (aggregation scope), H-8, H-9** are untouched by design. **OPEN.**
* **Reference matching is exact and case-sensitive** (documented contract; `'ref'` ≠ `'REF'`), and `CASH`
  remains exempt from the reference guard because cash has no meaningful reference. Both are deliberate;
  a future normalisation would be a semantic decision, not a defect fix.
* **Partial (sub-allocation) reversal remains unsupported** (M-4). The milestone makes the refusal
  operator-readable; it does not add the capability. **ASSUMED acceptable for pilot** — staff must reverse
  in allocation-sized steps, and the rule is not surfaced in the UI yet.
* **M-5 refund accounting treatment is still undocumented** beyond the trigger's behaviour (a decision for
  the accounting-facing docs, not a code change).
* **Test-harness caveat (not a product defect):** inside the integration harness's per-test ambient
  transaction, two *overlapping* in-process route calls share one connection and each wraps itself in a
  SAVEPOINT; a failure in one can invalidate the other's savepoint. Production scopes open their own
  `BEGIN`, and the concurrency group in the R2 suite leaves the ambient transaction deliberately, so the
  route-level concurrency assertions run under production-like conditions. The deterministic
  same-reference proof runs on two independent connections.

---

## 10. Exit criteria

| Criterion | Status |
|---|---|
| Duplicate reversal under concurrency impossible | **PROVEN** (migration + D1 + B1 + re-audit B2/B3) |
| One live payment per reference for every non-cash method | **PROVEN** (migration + D2/D3 + B2 + re-audit D1–D3) |
| Every financial mutation refuses to run untracked | **PROVEN** (A1–A6 + re-audit A1) |
| Receipt issuance and invoice void atomic with their audit rows | **PROVEN** (E1–E3, B3, C1–C3) |
| A receipt cannot drift from what it receipted | **PROVEN** (C1–C3, re-audit C1–C3, F1) |
| No financial truth changed by the remediation | **PROVEN** (§7) |
| Frozen M10/M11 history and control planes preserved | **PROVEN** (§6, §8) |
| Independently re-audited | **PROVEN** (16 tests; two real defects found and fixed) |

---

## 11. Recommended next milestone

**R3 — Public Surface Hardening (H-3).** In this order: bind the submitted amount to the link's fixed amount
server-side; stop persisting the raw bearer token in `notes`/audit metadata (and rotate affected links rather
than rewriting append-only history); add a submission idempotency boundary plus rate limiting/attempt caps on
`/api/p/[token]/*`; minimise the public payload (no full student identifiers). It is the last "Hard gate"
still open, it is the only unauthenticated mutation in the product, and it is the boundary R1's own
closeout already flagged as residual risk. Behind it: H-5 (auth lifecycle), H-4 (registration
transactionality), then H-6 (health/readiness + authenticated E2E evidence).
