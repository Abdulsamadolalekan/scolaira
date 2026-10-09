# H-2 RECONNAISSANCE — MEASURED SCOPE MAP
**Milestone:** H-2 Aggregation, reporting, term-boundary & pagination hardening
**Baseline:** `6ba8b149ebf7aeb80ef2ff68da31cbf554cccaab` (H-5, frozen)
**Method:** read-only inspection of the frozen tree + a temporary measurement harness (`tests/db/tmp-h2-measure.test.ts`, deleted before commit). Raw output: `/tmp/h2-pre-measure.txt`.
**Register:** `docs/readiness/POST_M11_READINESS_AUDIT.md` §4 (H-2) + §13 R7 (H-2 + M-6 + M-7).

---

## 1. Register findings claimed (verbatim scope)

| Item | Sev | Register claim | Register locations |
|---|---|---|---|
| H-2 | High | "Aggregation scope, term boundaries, and pagination are inconsistent across headline KPIs and queue views" — two scoping conventions with no labelled contract; caps with no cursor/`hasMore` | `app/api/dashboard/summary/route.ts:102-250`, `lib/db/repo/reminders.ts:122-189`, `lib/db/repo/collections.ts:123-171` |
| M-6 | — | Invisible caps: a capped list silently truncates; no truncation signal | grouped with H-2 by §13 R7 |
| M-7 | — | Reminder staleness: boundaries are implicit/undocumented | `lib/db/repo/reminders.ts:122-189`; §13 R7 |
| H-2 ADQ | — | "reconciliation test set demonstrating KPI totals tie back to source rows" | §4 |

## 2. Measured base (what the tree actually does)

### 2.1 Aggregation scope — measured, not assumed
A tenant with **one prior term** (term A, due 2025-10-01, 300,000 kobo, 100,000 kobo allocated) and **one current term** (term B, two invoices 150,000 + 100,000, one overdue 120 days):

```
dashboard KPIs           billed=250000 collected=0 outstanding=250000 overdue=150000 unreconciled=0
dashboard scopes in code TERM-only: billed/outstanding/overdue/collected + drafts + topOverdue(3) + recentInvoices(6)
                         ALL-TERM: unreconciledPayments, aging aggregate, reconciliationPays(2), recentPayments(6), activity(6)
debtors queue totals     outstandingKobo=450000 overdueKobo=350000 severeCount=2 debtorCount=3
source rows              all_term_outstanding=450000  current_term_outstanding=250000  prior_term_outstanding=200000
```
* **The same word — "outstanding" — means two different numbers on one screen** (250,000 vs 450,000). Neither payload carries a scope label; the divergence is only discoverable by hand-summing source rows.
* Prior-term debt (200,000 kobo) is **absent from every headline KPI** (billed=250000 excludes it) but present in the queue total. Register's "two scoping conventions without a labelled contract" is confirmed exactly.
* `activeStudents` = all ACTIVE students (all-term) while the dashboard hint text in `app/(app)/dashboard/page.tsx` renders it as term-flavoured — a mislabelled figure.
* Every term-scope figure silently degrades to 0 when no term is current (`termRepo.getCurrent` → null): deliberate, but nowhere stated in the payload.

### 2.2 Caps — measured on a synthetic 501-invoice tenant
```
debtors rows returned     500        (cap LIMIT 500 in listDebtors)
debtors totals.debtorCount 500        vs true ACTIVE students 501
debtors totals.outstanding 25000000   vs true source rows     25050000
invoices rows returned    200         (cap limit(200)) of 501
invoices page strip sum   10000000    vs true tenant billed    25050000
payload truncation signal (absent on all of them: hasMore/limit/total)
```
* `app/(app)/invoices/page.tsx` `computeStats(rows)` sums the ≤200 fetched rows into the page's Billed/Collected/Outstanding/Overdue strip → **a silently wrong headline on a >200-row tenant (measured under-report: 15,050,000 kobo)**.
* `app/api/debtors/route.ts` computes `totals` by looping the returned (capped) rows → totals are page-derived, not source-derived.
* Only cursor in the codebase: `app/api/reconciliation/queue/route.ts` (`limit` 1–100 default 50 + `cursor` 1–512 chars). All other caps: invoices 200, payments 200, payment-links 100, collections 50/clamp 100, audit 50, reminders `listForInvoice` 20, `/api/students` **unbounded** (no declared cap at all).

### 2.3 Staleness (M-7)
* Dashboard hardcodes two boundaries inline: severe aging = 90+ days **and** no reminder in the last **14 days**; `stale_followup` = overdue and last reminder > **7 days**; `stale_followup` is suppressed entirely when `severeCount > 0`.
* Reminder cooldown is a call-site literal `4` hours (`app/api/debtors/[studentId]/remind/route.ts:120`); the repo takes it as a parameter.
* Debtors rows expose a raw `lastReminderAt` with **no staleness classification and no thresholds in the payload** — a client cannot tell "fresh" from "unattended" without duplicating the constants. Measured row: `lastReminderAt=…-7 days 1 hour` classified nowhere.

### 2.4 Term boundaries
* Terms are created as `PLANNED`, activated to make one current (`is_current`), with `starts_on`/`ends_on`/`due_date`. **Nothing uses `starts_on` as a cut-over**: an invoice whose `due_date` predates the current term's start is reported exactly like a current-term invoice, and invoices carrying a previous `term_id` are invisible in the term-scope KPIs (2.1).
* There is **no close/freeze control anywhere**: no period table, no as-of valuation, no precondition preventing a period from being closed over unallocated or unresolved money. `Payment.allocations` history means a payment created in a closed window can still be re-pointed afterwards with no boundary check.

## 3. Decisions taken from the measurements (scope of record)

1. **Fold M-6 and M-7 into H-2** — §13 R7 groups them by construction (same files, same defect family) and the register provides no separate milestone for them. No H-4/H-6/H-8/H-9/A5/M12 work is entered.
2. **One declared scope per surface**, not a global switch: headline KPIs + term-scope figures are `TERM` or `ALL_TERM` by an explicit, auditable per-org setting (default **`ALL_TERM`** — arrear visibility is the safer default); arrears/aging, the invoice register, collections and reconciliation queues are `ALL_TERM` and say so. Every payload carries its scope + human label, so no surface can silently disagree with another.
3. **Partition, don't hide.** Outstanding invoices are classified once, in SQL, into an exhaustive 3-way partition used by every surface: `CURRENT_TERM` (billed by the active term), `PRIOR_TERM` (`term_id ≠ current` **and** `due_date < active term starts_on` — genuinely carried-forward debt), `OTHER_TERM` (earlier term, not yet due at cut-over; also all invoices when no term is current). `sum(buckets) = headline` is the tie-back invariant for the ADQ.
4. **Every capped list declares itself**: `page { limit, cap, capSource, returned, total, hasMore, nextCursor }` on invoices, payments, payment-links, students, debtors and the collections queue; the existing reconciliation cursor is kept and gains the shared `page` block. Headline strips are computed from **source rows**, never from the fetched page.
5. **Term-boundary control = financial periods** (forward migration): named `starts_on`/`ends_on` windows, an **as-of valuation** report, and a **close** operation that refuses to close while the window holds unresolved (PENDING / DUPLICATE_SUSPECT) or unallocated CONFIRMED money. Prior-term *reporting* is by derived classification (decision 3) — no new billing friction is added, and no enforcement of billing order is claimed.
6. **Staleness is data**: one shared constant module feeds the dashboard, the reminder cooldown and per-debtor classification (`NONE|FRESH|STALE|UNATTENDED`) with the thresholds echoed in the payloads. Boundary values (6d vs 7d vs 7d1h, 14d vs 15d) are tested.
7. **New permission actions are minimal**: `financial_period.read` / `financial_period.manage` (OWNER + SCHOOL_ADMIN for manage — a close is a control decision, deliberately *not* delegated to FINANCE_OFFICER). The invoice-scope setting reuses `org.settings.read`/`org.settings.update`: a finance officer cannot change what the headline means.
8. **Forward-only**: single new migration `0048` (journal idx 47). No historical migration is touched; no M10/M11 or R1–H-5 artefact is edited except existing tests being extended and the H-5/R1 re-audit pins if a new app-callable function must be listed. All new SQL is additive; rollback for a bad deploy is `git revert` + a new forward migration, never an edit of `0048` after it ships.

## 4. Explicitly out of scope (recorded, not started)
* H-4, H-6, H-8, H-9, A5, M12.
* Any change to the authoritative ledger, RLS/FORCE-RLS posture, idempotency or audit controls.
* CSV/PDF export surfaces for the new reports (not demanded by the register; the ADQ is satisfied by tie-back tests).
* Enforcing that a prior term is billed before a later one (a product policy, not a defect proven by measurement).
