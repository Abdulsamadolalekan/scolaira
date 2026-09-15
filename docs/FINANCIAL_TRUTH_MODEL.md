# Financial Truth Model

> Dashboard values must never become an alternative financial source of truth.
> Reports must derive from authoritative financial data, not duplicated dashboard state.

This document explicitly classifies every record in the system as either:

- **AUTHORITATIVE FINANCIAL TRUTH (the ledger):** if these records say X, the truth is X; all other numbers must agree with them.
- **DERIVED / OPERATIONAL / PRESENTATION:** can always be recomputed from authoritative records; safe to cache or regenerate; never manually edited.

---

## I. Authoritative Financial Truth (The Ledger)

These tables are the source of truth. If they say ₦Y was collected for an invoice, that is the fact.

### A. Invoices + Invoice Lines
- `invoices` — the bill. Status, total_kobo (derived but stored with trigger-enforced equality), issue_date, due_date, voided status.
- `invoice_lines` — the individual lines that sum to the invoice total.
- **Why authoritative:** An invoice is a legal/operational obligation. BILLED totals come from here.

### B. Payments
- `payments` — money received. Amount is always positive; status transitions are constrained; references and methods recorded.
- **Why authoritative:** COLLECTED comes from payments in CONFIRMED status (net of reversals).

### C. Payment Allocations
- `payment_allocations` — ties a specific portion of a payment to a specific invoice.
- **Why authoritative:** Without allocations, you know money came in but not what it belongs to — Reconciliation's job. Allocation determines whether an invoice is PAID or PARTIALLY_PAID and what the outstanding is.

### D. Reversals
- `reversals` — corrections/refunds. Append-only. Type: REVERSAL / REFUND / CORRECTION.
- **Why authoritative:** They are the ONLY mechanism for decreasing collected totals or reopening invoices. History is preserved via these rows, not by mutating payments.

### E. Receipts
- `receipts` — evidence of payment issued to a parent. Receipts are a bit special: they are authoritative as "issued documents" (they have their own lifecycle, receipt number, void state), but they DO NOT back-influence financial truth. If a receipt exists and the payment was reversed, the receipt is VOID — but the reversal is the financial truth, not the receipt.
- **Classification:** Authoritative as documentary evidence; derived in the sense that their amount/scope reflects ledger state at issuance.

### F. Audit Events (financial subset)
- Authoritative as a record of WHO/WHAT/WHEN/BEFORE/AFTER/WHY for mutations to items A–E. They are not financial truth themselves (they don't say how much was collected) but they are authoritative as a record of how truth was changed.

---

## II. Derived / Operational / Presentation Data

These are NOT a source of truth. They may be computed live, cached, or materialized, but they must ALWAYS be recomputable from authoritative tables. If they disagree with the ledger, the LEDGER wins.

### A. Computed Balances & Aggregates
- Outstanding per invoice: `total_kobo - paid_kobo`, where `paid_kobo` is maintained by trigger from allocations/reversals. (Note: `paid_kobo` is trigger-maintained from authoritative allocations, so it is a *materialized* derived value with integrity protections — always derivable from allocations.)
- Outstanding per student: sum across invoices per term.
- BILLED / COLLECTED / OUTSTANDING / OVERDUE per term per organization.
- Collection rate (collected / billed).
- Aging buckets.
- Prior-term exposure vs current-term.

### B. State Fields Maintained by Triggers
- `invoices.paid_kobo` and `invoices.status` (ISSUED/PARTIALLY_PAID/PAID) — derived by trigger from allocations; always recomputable.
- `payments.status` transitions to REVERSED/REFUNDED — derived from presence of full reversal.
- These are treated as *derived* for reasoning purposes, even though they are stored, because the triggers that maintain them are authoritative logic.

### C. Dashboard KPIs & Widgets
- Command Center top-line numbers (BILLED/COLLECTED/OUTSTANDING/OVERDUE/UNRECONCILED).
- Collection rate, deltas, trends.
- Action feed items ("3 accounts 30+ days overdue").
- Priority scores.
- **Never stored as manually-editable values.** Computed at query time (or via periodically-refreshed materialized views for performance on larger datasets). Every KPI is traceable to its underlying SQL.

### D. Reports
- All reports — summary, aging, collection by class, fee-line recovery, payment-method breakdown, prior-term exposure, reconciliation status, term comparison — are computed from ledger tables.
- Reports may be exported to CSV/PDF; exported files are snapshots, not new sources of truth.

### E. Collection Priority Scores
- Deterministic computed score from amount outstanding, days overdue, prior-term debt, payment history, etc. The formula is documented; the score is never a stored field that drifts.

### F. Payment Link State (except financial outcome)
- A payment link's lifecycle (ACTIVE/PAID/EXPIRED/REVOKED) is authoritative for link access but NOT for financial truth; the payment record created when payment is made is authoritative. If a link is marked PAID but the payment was reversed, the financial truth is the reversal.

### G. Communication Events
- Authoritative as a record of what was sent when (important for compliance and follow-up tracking) but they do not create or alter financial state.

### H. Onboarding State / Subscriptions / Settings
- Operational metadata; they do not enter into financial calculations.

### I. Search Indexes / Caches
- Any Redis/edge/in-memory caches or search indexes (if introduced) are derived; they can be fully rebuilt.

### J. CSV Exports, Print-ready Receipts, PDFs
- Presentation artifacts; can be regenerated from authoritative data.

---

## III. Rules Enforcing This Separation

1. **No service endpoint mutates a derived value directly.** There is no "set outstanding to ₦X" endpoint. All changes happen via mutations to the authoritative ledger (invoices/payments/allocations/reversals).
2. **Reports and dashboards call read-only functions** that query the ledger; they don't read from "dashboard state" tables (we don't have such tables for financial values).
3. **Trigger-maintained fields** (like `paid_kobo`) are NOT directly editable by application code; only triggers change them.
4. **If a discrepancy is ever detected between a derived value and the authoritative computation, it is a P0 bug.** The fix is always to rebuild the derived value (refresh materialized view, fix the bug, correct the trigger), not to adjust the authoritative records to match the dashboard.
5. **Materialized views, if introduced, must:**
   - Have a single source function that computes from authoritative tables.
   - Include a `refreshed_at` timestamp displayed in the UI for cached data staleness awareness.
   - Be refreshable transactionally (concurrent refresh) so they never serve partially-updated data.
   - Be covered by tests that compare their output to live computation.
6. **CSV imports write directly to authoritative tables** (inside a transaction with validation) — they do not populate staging tables that later become "a second truth."
7. **Webhooks write to authoritative tables** (payments/allocations) once idempotency and signature verification pass — they never set dashboard numbers directly.

---

## IV. Reconciliation is the Bridge Between Unknown Money and the Ledger

Unidentified/unconfirmed/unmatched payments are held in states (PENDING, DUPLICATE_SUSPECT, unallocated) that are AUTHORITATIVE about their unknown-ness:

- The payment record exists (authoritative).
- It is NOT counted in COLLECTED until CONFIRMED.
- It is NOT allocated until finance officer (or deterministic rule) resolves.
- Reconciliation queue views are DERIVED (count of payments in non-CONFIRMED states, or CONFIRMED with unallocated remainder).

**Uncertainty is explicitly represented, not papered over.** If a payment is not fully reconciled, the UNRECONCILED total shows that honestly. We never manufacture a number just because the UI expects one (F15).

---

## V. Summary Table

| Record | Classification | Editable? |
|---|---|---|
| organizations, users, memberships | Operational (authoritative for access control) | via authorized services |
| sessions, terms, classes | Operational (authoritative for academic structure) | via authorized services |
| students, guardians | Operational (authoritative for people records) | via authorized services; financial history never altered by edits |
| fee_definitions, fee_assignments | Operational/billing structure | constrained edits after billing |
| invoices, invoice_lines | **AUTHORITATIVE ledger** | only via documented transitions; lines frozen after issuance |
| payments | **AUTHORITATIVE ledger** | only via documented transitions; never deleted |
| payment_allocations | **AUTHORITATIVE ledger** | created via allocation rules; reversed via reversals only |
| reversals | **AUTHORITATIVE ledger (append-only)** | INSERT only; never mutate after insert |
| receipts | Authoritative documentary evidence | ISSUED / VOID via documented transitions |
| payment_links | Operational (authoritative for link lifecycle) | via documented transitions; never source of payment truth |
| communication_events | Operational record | append-only |
| audit_events | **AUTHORITATIVE audit log** | INSERT only |
| idempotency_keys | Operational (deduplication) | INSERT with TTL |
| webhook_events | Operational record | INSERT only |
| subscriptions, onboarding_state | Operational metadata | via services |
| invoice.paid_kobo, invoice.status, payment.status | *Stored derived* (trigger-maintained) | updated only by triggers |
| outstanding_kobo (anywhere) | *Computed derived* | computed on read (or in materialized views) |
| dashboard KPIs, reports, priority scores | *Computed derived presentation* | never written; computed at query time |
| CSV exports, PDFs, cached views | *Presentation artifacts* | regenerated on demand |
