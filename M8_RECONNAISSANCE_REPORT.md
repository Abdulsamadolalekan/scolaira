# M8 Reconnaissance Report — Selecting the Next Strategic Payment to Own

**Milestone:** M8 — STRATEGIC RECONNAISSANCE (no code)
**Date:** 2026-09-19
**Prior frozen tips:** M5 `0c66618e…`, M6 `36688546…`, M7 `86beba9…` (history untouched; M8 builds forward)
**Method:** Direct inspection of schema, repos, API handlers, UI surfaces, migrations, and closeout reports. No customer interviews were conducted; all operational inferences come from code structure and the founder's stated test: "If Scolaira shipped M8 on Monday, what would a school do materially better?"
**Evidence level:** Code-grounded; where data is absent it is marked as such.

---

## 1. Executive Summary

M5 made the books correct. M6 hardened the financial edges, added receipts, and opened a public payment-link lane so parents can pay remotely. M7 turned the data into action with a ranked debtors/aging workbench and immutable reminders.

**What is missing, and what makes every downstream feature wobble, is the act of billing itself.**

Today a bursar must issue invoices one student at a time, manually typing line items, despite the database already containing: (a) `fee_definitions` (named fees with a code — TUITION, DEV_LEVY — but **no amount column yet**, a schema gap M8 fills with `default_amount_kobo`), (b) `fee_assignments` linking fee definitions to `(class, term)` with an `amount_kobo` override and a nullable `class_id` (org-wide fees), (c) `class_enrollments` (which student is in which class this term, uniquely per `(student, term)`), and (d) `terms.billed` / `terms.status` lifecycle columns (`PLANNED → ACTIVE → BILLED → CLOSED`) that are currently written by no code path. The schema was built for bulk term billing; the product does not perform it.

**Selected M8 thesis:** *Make Scolaira the system a school uses to actually bill an entire term in one controlled, auditable pass — taking the configured fee structure and enrolled population and turning them into issued invoices, with a pre-issue preview, per-student overrides, idempotent re-runs, and a term-level "Billed" transition that locks a cohort into the collection cycle the rest of M5/M6/M7 already supports.*

Founder's test, answered in measurable terms: **On Monday morning a bursar who currently spends 4–8 hours manually keying a single invoice per student per term (and 1–2 hours correcting the typos that inevitably follow) will instead (1) click "Bill term," (2) review a preview that lists, per class and per student, which fees will be charged and what the total will be, (3) apply per-student adjustments (scholarship/waiver — formalised in the same pass), and (4) issue every invoice in a single transaction. Time: roughly 10 minutes of review instead of a full working day; missed-student and wrong-amount errors drop from "the normal case" to "the audit-traceable exception."** The Debtors workbench, payment links, reminders, receipts, and dashboard KPIs all become useful immediately because invoices actually exist for every enrolled student on day one.

---

## 2. Current Capability Map (as of M7 freeze `86beba9`)

Layer | Owned by Scolaira today
---|---
**Tenant, auth, RLS, authz** | M5-foundation: org isolation, runtime role `scolaira_app` hardened (NOSUPERUSER/NOINHERIT/NOCREATEROLE/NOCREATEDB/NOBYPASSRLS), SECURITY DEFINER resolvers, CSRF on state-changing routes, permission-gated pages and APIs.
**Academic structure** | `academic_sessions → terms → classes → students → guardians → class_enrollments`. Terms have `billed:boolean` and `status: PLANNED|ACTIVE|BILLED|CLOSED` columns. Enrollments uniquely bind `(student, term)`.
**Fee configuration (data only)** | `fee_definitions` (name, default amount, type) and `fee_assignments` (fee × class × term, with optional override amount) exist in schema and have repo CRUD but have **no UI, no API routes, and no billing path that consumes them**.
**Invoices** | Single-student create (POST `/api/invoices`) taking manual `lines[]`; issue; void; detail; list. Numbering DB-assigned. Lines may carry a `fee_assignment_id` FK, but no caller ever sets it.
**Payments** | Record (manual entry) with optional allocations; PENDING→CONFIRM; ALLOCATE (one invoice at a time through the UI — multi-invoice only via direct API); REVERSE/REFUND/CORRECTION append-only. Overpay is held as `unallocated_kobo` on the payment (no student-level credit ledger).
**Receipts** | Auto-numbered, amount = sum of ACTIVE allocations (correct under partial payment), printable per payment. Idempotent.
**Public payment links** | Narrow RLS path `/p/[token]` with PII-minimal view and a public submit that creates a PENDING payment only — no allocations, no confirm, no invoice mutation. Link management API exists but is **not exposed in the invoice UI** (no button on the invoice detail page to copy a shareable link).
**Accounts Receivable / Debtors** | Ranked aging list, per-student detail, printable statement, immutable reminders with 4h cooldown, severe-aging and stale-follow-up alerts on the dashboard.
**Dashboard KPIs** | Billed / collected / outstanding / collection rate, current-term scoped, severe-aging attention panel.
**Communications plumbing** | `reminders` table (PRINT only wired to action; SMS/EMAIL/WHATSAPP accepted as PENDING for future providers).
**Audit** | Append-only `audit_events` on every financial write, with immutable triggers on financial entities and reminders.

**Gaps (schema present, product dormant):** fee_definitions have no UI or API routes and the repo only supports `create/get/listForOrg` (no update/archive); fee_assignments have no UI or API routes and the repo only supports `create/get/listForTerm` (no replace, no list-for-classes, no activation); `feeAssignments.status` (DRAFT/ACTIVE/ARCHIVED) and `feeAssignments.classId` being nullable (signaling org-wide fees that apply to every student regardless of class) are unconsumed by any code path; term billing (the `billed` flag never flips); term close / carry-forward; opening balances; student-level credit/wallet; scholarships/waivers/discounts as a first-class concept; bulk invoice generation; invoice-level shareable payment-link action; statement-as-a-ledger across terms. The authorization actions `fee_definition.manage` and `fee_assignment.manage` are already granted to OWNER/SCHOOL_ADMIN/FINANCE_OFFICER in `lib/authz/permissions.ts` but nothing routes to them.

---

## 3. How We Got Here — M5→M7 Evolution

Milestone | What it bought us | What it deliberately did not do
---|---|---
M5 (`0c66618e`) | Correct kobo-precise ledger: invoices, payments, allocations, reversals, trigger-maintained balances, idempotency, tenant RLS, runtime-role hardening. | Manual one-by-one creation only; no approval flow; no public pay; no receipts; no debtors view.
M6 (`36688546`) | Receipts (correct under partial allocation), public payment links with narrow RLS, student archive/restore guard, dashboard current-term scoping, idempotency hardening. | Payment links have API but no UI affordance on the invoice page; public submit creates PENDING only (no auto-match); confirm endpoint is scaffolded.
M7 (`86beba9`) | Debtors/aging workbench, per-student detail, printable statements, immutable reminders with cooldown, severe-aging dashboard alerts. | Reminders operate only on invoices that already exist; there is no mechanism for getting the *right* invoices to exist in the first place at scale.

The pattern: each milestone assumes the prior step's invoices are the complete, correct set of obligations. None of them creates that set at scale.

---

## 4. The Current Financial/Operational Loop, End to End

Reconstructed from code inspection (not from a site visit — marked honestly):

1. **Before term starts:** Bursar/proprietor configures classes, admits/enrolls students (M5 `POST /api/students`, implicit class assignment). The `fee_definitions` / `fee_assignments` tables sit empty or are ignored because there is no UI and no API to populate them.
2. **First week of term:** Bursar opens `/invoices/new`, picks a student from a dropdown (pre-filled with their outstanding balance from a prior term), picks the current term, types a description like "First Term Tuition", types an amount, clicks *Issue invoice*. Repeats. For every student. For every fee head (tuition, development levy, uniform, exam, feeding…). At a school of 300 students × 4 fee heads that is ~1,200 manual form submissions.
3. **During term:** Parents pay by transfer, cash, POS. Bursar records at `/payments/new`. The form auto-picks the *first* open invoice for that student (see `record-payment-form.tsx` `useEffect` defaulting to `studentInvoices[0]`) and applies the payment to that single invoice only; excess is left as `unallocated_kobo`. Bursar later visits `/payments/[id]`, clicks *Allocate to invoices*, and one invoice at a time draws down the unallocated balance.
4. **Chase:** M7 debtors page lists students with outstanding balances; bursar prints reminders per student. The debtor pool depends entirely on which invoices were actually created in step 2; students who were missed are invisible to collection.
5. **Term end:** No close-out flow. The term's `billed` flag never flips to true; `status` never reaches `BILLED` or `CLOSED`. Outstanding invoices from the finished term simply coexist with next term's invoices in the same open aging pool, and next term's billing cycle starts again at step 2.

The weakest link in this loop — and the one every other link is built on — is step 2.

---

## 5. Remaining Friction Inventory (evidence-graded)

Friction | Evidence in code | Severity
---|---|---
**Invoices are created one student at a time.** `app/(app)/invoices/new/new-invoice-form.tsx` is a single-student form; `POST /api/invoices` takes one `studentId` and one line array; no bulk route exists. | ⬛ Code fact | **Critical** — blocks every scaled school.
**Fee configuration is dead schema.** `fee_definitions`, `fee_assignments` exist; repo CRUD exists; zero API route, zero page, zero caller sets `invoice_lines.fee_assignment_id`. | ⬛ Code fact | **High** — the product invites configuration it cannot act on.
**`terms.billed` / `terms.status` lifecycle is unconsumed.** Columns exist with `PLANNED|ACTIVE|BILLED|CLOSED`; no route flips them; dashboard does not branch on them; the only code touching `status` is the default. | ⬛ Code fact | **High** — the schema already models the exact milestone transition we need.
**Payment allocation is one-invoice-at-a-time in the UI.** `payment-actions.tsx` `AllocateForm` holds a single `<select>` and one amount input; the API accepts an array, but no UI exploits that. | ⬛ Code fact | Medium — once bulk billing creates a full invoice set, FIFO/multi-invoice allocation becomes more important.
**Unallocated cash has no student-level home.** Overpay lives on `payments.unallocated_kobo`; no wallet/credit/deposit table, no "apply to student account" abstraction. | ⬛ Code fact | Medium — surfaces after multi-invoice billing lands (a parent may pay more than one invoice's exact remaining).
**Payment links are invisible in the invoice UI.** `/api/payment-links` and `/p/[token]` work; there is no "Copy payment link" button on `/invoices/[id]`. | ⬛ Code fact | Medium — cheap win but not the bottleneck; collecting against missing invoices is impossible regardless of link UX.
**Public submit creates PENDING payments with no suggested allocation.** `POST /api/p/[token]/submit` ignores the invoice the link was issued against for allocation (by design, for safety); a bursar must manually allocate every online payment. | ⬛ Code fact | Medium — directly repairable once the billing base is solid.
**No term-close / carry-forward.** No route, no migration, no logic for rolling outstanding balances forward as opening balances (or a "brought forward" line) into a new term. | ⬛ Code fact | High for multi-term schools, but cannot be designed correctly until term billing is real and every student has an invoice for the current term.
**No scholarships/waivers/discounts as a first-class entity.** `invoice_lines.adjustment_kobo` exists per line (negative adjustments would model a discount) but nothing names, approves, or reports on them. | ⬛ Code fact | Medium — overlaps with bulk billing (per-student overrides at bill-time are a natural place to introduce waivers).
**No bank-statement import / automated matching.** No integration, no parser, no matching logic. | ⬛ Code fact | High long-term, but schools that are still hand-keying invoices lose more to missed billings than to slow reconciliation.
**No statement spanning multiple terms.** `/debtors/[studentId]/statement` prints open invoices but no prior-term history, no running balance. | ⬛ Code fact | Medium — prerequisite is predictable term boundaries from billing + close.
**Reminder history is PRINT-only; SMS/EMAIL/WHATSAPP are placeholders.** Channels exist as enum values but nothing dispatches. | ⬛ Code fact | Medium — provider wiring is out-of-scope for a milestone; M8 should not introduce external side effects.

---

## 6. Data → Action Gaps

These are places where Scolaira already holds the data but cannot act on it:

1. **Enrollment → invoice.** `class_enrollments` tells us exactly who should be billed for this term; Scolaira never uses that to produce invoices.
2. **Fee assignment → invoice line.** `fee_assignments` tells us how much each class owes for each fee; no code produces lines from them.
3. **Term lifecycle state → lock.** `terms.billed` and `terms.status` exist; nothing gates them or uses them to prevent duplicate billing.
4. **Overpay/unallocated → future-invoice application.** The system tracks overpay precisely (`unallocated_kobo`) but will not automatically offer it against the next open invoice for the same student.
5. **Reminder → next action.** M7 records "reminded at X"; there is no follow-up state (promise-to-pay, dispute, escalated) that drives the next contact.
6. **Public payment link → pre-filled allocation.** When a parent pays through a link created against a specific invoice, the resulting PENDING payment carries no invoice hint for the bursar.

Gaps 1–3 are the ones M8 closes. Gaps 4–6 are deferred on purpose (see §15 Non-goals, §16 Deferred work).

---

## 7. Opportunities to Become System of Record

A school uses Excel or a competitor wherever Scolaira does not yet own a step. The steps Scolaira does not yet own, in the order that creates lock-in:

- **Billing day** — currently the bursar's spreadsheet or a legacy MIS generates the invoices; Scolaira only records what the bursar re-keys. Owning this step makes Scolaira the authoritative source of *what is owed*, not just *what was paid*.
- **Term close / new-term opening** — currently done on paper or in a workbook ("brought forward" balances). Owning it eliminates the second ledger.
- **Bank reconciliation** — currently a person matches bank alerts to payments. Owning it closes the last leak.
- **Communication dispatch (SMS/WhatsApp)** — currently done from a phone. Owning it completes the loop.
- **Reporting to proprietor / government** — currently an export-and-rekey.

M8 should take the **highest-leverage, lowest-coupling** of these. Billing day is the root of the tree: nothing else (term close, reconciliation, reporting, automated reminders) is fully honest until billing is complete and correct.

---

## 8. Candidate Directions Considered

Each candidate is graded against the founder's test: would a bursar/proprietor notice the improvement on Monday, in measurable operational terms?

### Candidate A — Bulk Term Billing (fee definitions + enrollments → issued invoices)
- **What:** API + UI to define fee templates per class, assign fees to a term, preview the bill run per student, and issue every invoice in one transaction. Flips `terms.billed = true` and `terms.status = BILLED`; subsequent runs are idempotent (only newly enrolled / missing students get invoices); per-student adjustments (waivers) are entered at preview time and land as negative `adjustment_kobo` lines with a typed reason.
- **Evidence it matters:** schema already built (fee_definitions, fee_assignments, class_enrollments, terms.billed/status); current invoice creation is one-by-one; every downstream feature (debtors, reminders, payment links, dashboard collection rate) is only as good as the completeness of the invoice population.
- **Measurable win:** ~1,200 manual form submissions per term → one preview-and-confirm action; missed-student errors go from "likely" to "zero (if enrollment is current)"; debtor list reflects 100% of enrolled students on day one.
- **Risk / cost:** medium — one new migration (billing-batch / waiver-reason + constraints), new API routes for fee definitions, fee assignments, and term bill-run, new pages (fee setup + bill-term preview). Idempotency design is subtle (what happens if a student enrolls after billing day?).

### Candidate B — Smart Allocation (auto-FIFO + multi-invoice + unallocated cash wallet)
- **What:** when a payment is recorded, auto-apply it to the student's oldest open invoices (configurable order); surface unallocated cash on the student record as a credit balance; allow one allocation form to split a payment across many invoices in one submit.
- **Evidence it matters:** current UI allocates one invoice at a time; overpay sits on the payment with no student-level view.
- **Measurable win:** clicks-per-payment drops from N (one per invoice) to 1.
- **Why not M8:** this is still a "reconciliation speed" feature. It helps *after* invoices exist. It cannot fix a debtor list that is missing 30% of students because billing was incomplete. Better as an M8.x / M9.1 once a full invoice set exists.

### Candidate C — Bank Statement Import & Auto-Match
- **What:** upload CSV/Excel from bank statement; parser extracts date/ref/amount; matcher proposes payments against open invoices (exact ref, then amount+name fuzzy, then student-code-in-ref); bursar confirms.
- **Evidence it matters:** the current record-payment form is manual; school bursars in Nigeria reconcile from bank alerts throughout the day.
- **Measurable win:** minutes-per-payment drops from ~2 minutes to ~10 seconds of review; missed payments drop.
- **Why not M8:** very high scope (file parsers per bank, fuzzy matching rules, UX for unmatched rows, duplicate detection). Worse, matching against an *incomplete* invoice set silently hides unbilled students — it makes it easier to collect from the people you already billed while doing nothing for the ones you missed. Depends on a complete invoice population.

### Candidate D — Term Close & Carry-Forward
- **What:** close a term (only when all fees for that term have been billed), roll outstanding balances into the next term as a "Brought forward" line or opening balance; lock historical invoices from further edits (soft-lock, not immutable).
- **Evidence it matters:** `terms.status` has `CLOSED`; current system lets last term's invoices forever age alongside this term's, distorting current-term KPIs.
- **Measurable win:** dashboard KPIs become trustworthy per-term; proprietor sees true current-term collection rate against true current-term bill.
- **Why not M8:** a term cannot be honestly closed until every enrolled student has been billed for it — i.e. **Candidate A is a prerequisite**. Doing close before billing codifies an incomplete ledger.

### Candidate E — Payment-Link UX on Invoice Detail ("Share link" button) + Auto-suggest Allocation on Public Submit
- **What:** add a "Copy payment link" button on the invoice page that creates/reuses a link; attach `invoiceId` as a *suggested* allocation on the PENDING payment created by public submit (visible to the bursar as a pre-filled allocation when confirming).
- **Evidence it matters:** the API exists; zero UI.
- **Measurable win:** time-to-collect for digitally-savvy parents drops; fewer mistaken allocations.
- **Why not M8:** small surface, high delight, but it is a polish item on top of an incomplete billing base. Can ship as a fast-follow (single commit) after M8.

### Candidate F — Discount/Waiver/Scholarship as a First-Class Entity
- **What:** a `waivers` table linking to an invoice line (or invoice) with reason, approver, amount; reporting on total waivers per term; permission-gated.
- **Evidence it matters:** `adjustment_kobo` exists on `invoice_lines` but is unnamed; many schools have scholarship students, sibling discounts, staff-children concessions.
- **Measurable win:** waivers stop being invisible adjustments in a memo field.
- **Why not M8:** most naturally introduced *inside* bulk billing (per-student override at preview time). Shipping it standalone without a bulk bill run forces bursars back into one-by-one invoice edits. Treat it as a feature **of** M8, not a separate milestone.

### Candidate G — Guardian Portal / Self-Service Statement
- **What:** authenticated guardian login showing their ward's invoices/payments/receipts; pay online.
- **Why not M8:** massive surface (auth flows for a second user class, invite flow, reset-password, multi-ward households). Premature until the billing data is complete; a portal with missing invoices is worse than no portal.

### Candidate H — Multi-Channel Reminders (SMS/WhatsApp/Email dispatch)
- **Why not M8:** requires external provider contracts, message templates, deliverability monitoring, opt-out compliance. Data is ready (`reminders` table stores any channel); M8 should not introduce external side effects.

### Candidate I — Richer Reporting (export debtors to CSV, P&L by class/term, fees collected by type)
- **Why not M8:** reports are only as honest as the data. Missing invoices ⇒ misleading reports. Build on top of a complete bill run.

---

## 9. Selected M8 Thesis — One Sentence

**M8 will let a school bill every enrolled student for the current term's assigned fees in one auditable, previewable, idempotent pass — creating a complete and correct invoice population that makes the existing Debtors, Payments, Receipts, Payment-links, Reminders, and Dashboard features finally operate over the full ledger, not the subset a bursar had time to key by hand.**

---

## 10. Product Contract (What "Done" Looks Like for M8)

Concrete, testable outcomes:

1. **Fee setup.** An `OWNER`, `SCHOOL_ADMIN`, or `FINANCE_OFFICER` (all three already hold `fee_definition.manage` + `fee_assignment.manage` in the existing policy matrix in `lib/authz/permissions.ts`) can
   - create and edit fee definitions (`code` — e.g. `TUITION`, `DEV_LEVY`; `name`; `description`; `default_amount_kobo` — a new column in migration 0020 because the current schema has **no** amount on fee_definitions, only `code/name/description/isActive`; `isActive`), scoped to the tenant; `code` is unique per org via the existing `fee_defs_org_code_idx`;
   - assign a fee definition to a specific class, or leave `classId = NULL` to indicate an **org-wide** fee that applies to every enrolled student in the term (the column is already nullable), with a per-(fee,class,term) override amount (the existing `amount_kobo`) and optional `dueDate` and `adjustment_kobo`; assignments transition DRAFT → ACTIVE before billing (the `fee_assignment_status` enum DRAFT/ACTIVE/ARCHIVED already exists in `enums.ts` but is unused); ARCHIVED assignments are skipped.
2. **Bill-term action.** From the term (or a new "Bill run" page), an authorized user can click "Bill term" for the current ACTIVE term. A new action `term.bill` is added to the permission matrix (granted to OWNER and FINANCE_OFFICER; explicitly **not** to SCHOOL_ADMIN — finalising a term's bill is a proprietor/finance-gate step, distinct from configuring fees). The system:
   - refuses if the term is `PLANNED` or already `CLOSED` (409);
   - computes a **preview**: for each enrolled student in each class, the list of applicable fees (via `class_enrollments × fee_assignments`), the per-line amount, any per-student adjustment already on file, and the invoice total; shows class-level and term-level totals;
   - highlights students who already have an invoice in this term for the same fee assignment (to prevent double-billing);
   - allows the user to add per-student adjustments (waiver/discount with a reason drawn from a fixed enum + optional note) before issuing;
   - on "Issue", runs a single transaction that: (a) creates DRAFT invoices, inserts lines (with `fee_assignment_id` FK populated), ISSUEs each, (b) records one `audit_events` row summarizing the batch (count, total kobo, term), and (c) flips `terms.billed = true`, `terms.status = 'BILLED'` (with `billed_at`, `billed_by`).
3. **Idempotency.**
   - Re-running "Bill term" on an already-BILLED term does **not** create duplicate invoices. Instead it tops up: for every currently-enrolled student who does not yet have an invoice covering a given (fee_assignment, term), it issues one. This handles post-billing enrolments (a new student admitted mid-term) without duplicating existing lines.
   - A second run on the same preview without new enrollments/changes returns 200 with `"unchanged": true` and zero new invoices.
   - Idempotency is enforced by a partial unique index on `invoice_lines (fee_assignment_id)` where the parent invoice is not VOID — once a fee assignment has been billed for a student it cannot be billed again for that term. (If a fee was genuinely missed and must be added, that is an explicit "Add fee to billed term" action, not a silent re-run.)
4. **Waivers / adjustments at bill time.** A per-student waiver during preview writes an `invoice_lines.adjustment_kobo` (negative) with a structured reason (SCHOLARSHIP, SIBLING_DISCOUNT, STAFF_CHILD, EARLY_PAYMENT, OTHER) recorded in a new `waivers` table (or a structured JSON column on the line with an audit log — to be decided at implementation). The total waiver kobo per term is queryable for reporting.
5. **No silent mutations.** Every invoice created in a bill run is a normal invoice, moving through the existing DRAFT→ISSUED state machine, with trigger-maintained balances, identical to an invoice created one-by-one. There is no "batch" state that bypasses existing invariants. All existing M5/M6/M7 tests continue to pass unchanged because the entities produced are ordinary invoices and lines.
6. **Dashboard adapts.** The Command Center continues to show KPIs, but now those KPIs reflect a complete billed set. A small "Term not yet billed" banner appears on `/dashboard` and `/debtors` when `terms.status = 'ACTIVE' AND billed = false`, nudging the bursar to run billing before chasing debts.
7. **Payment link affordance (fast-follow, small):** a "Copy payment link" button on `/invoices/[id]` creates (or reuses) a payment link via the existing `/api/payment-links` endpoint and copies `{origin}/p/{token}` to the clipboard. This is deliberately tiny and can ship in the same milestone because it reuses M6's API unchanged.
8. **Permissions.** The policy matrix in `lib/authz/permissions.ts` already contains `fee_definition.manage` and `fee_assignment.manage` (granted to OWNER / SCHOOL_ADMIN / FINANCE_OFFICER). M8 adds exactly one new action: `term.bill`, granted to OWNER and FINANCE_OFFICER only — finalising a term's bill is a proprietor/finance gate, distinct from configuring fee templates (which school admins can do). SCHOOL_ADMIN can therefore set up fees but cannot pull the trigger; STAFF and read-only roles get neither. All pages and routes are permission-gated via the existing `withAuthorizedRoute` and `checkPermission`, preserving the matrix-as-code invariant documented at the top of `permissions.ts`.
9. **Audit.** Bill runs produce: (a) individual `invoice.create` audit events per generated invoice (same as manual creation — reuse the existing audit call so audit tooling doesn't fork), and (b) a single `term.bill` audit event per batch with metadata `{ termId, invoicesCreated, totalKobo, waiversKobo }`.

Out of scope is defined in §15.

---

## 11. Architecture Impact

### Schema changes (one migration, `0020_term_billing.sql`)

- Add to `fee_definitions`: `default_amount_kobo BIGINT NOT NULL DEFAULT 0 CHECK (default_amount_kobo >= 0)` (the column is missing today — bulk billing cannot work without it; drizzle schema file updated accordingly). Add a comment documenting that class/term overrides live on `fee_assignments.amount_kobo`.
- Add to `terms`: `billed_at timestamptz`, `billed_by uuid references users(id)` (the existing `billed boolean` flag and `term_status` enum already include `BILLED` and are reused; no enum change needed).
- Add `waivers` table (or widen `invoice_lines` with a waiver reason column) — exact shape to decide at implementation; must carry: `organization_id`, `invoice_line_id` (or `invoice_id`), `reason` enum (`SCHOLARSHIP | SIBLING_DISCOUNT | STAFF_CHILD | EARLY_PAYMENT | OTHER`), `amount_kobo` (negative, `CHECK (amount_kobo <= 0 AND -amount_kobo <= invoice_lines.amount_kobo)` enforced via trigger since cross-table), `approved_by`, timestamps, standard RLS, tenant foreign keys, and an immutable-after-insert trigger mirroring `trg_reminders_immutable`.
- Partial unique index on `invoice_lines (fee_assignment_id, <student via invoice>)` — prevents re-billing the same fee to the same student for the same term even across re-runs. (Implementation note: an FK from `invoice_lines.invoice_id` to `invoices.id` already gives access to `student_id`, `term_id`; the unique index spans `(invoice_id → fee_assignment_id)` via the join, which may require a trigger or a redundant `student_id`/`term_id` on the line. To be decided.)
- Optional: `billing_batches` table, one row per "Bill term" click, with inputs snapshot (term, fee-assignment version hash) and outcome counts — for audit/debug. Useful but not strictly required; decide against if it introduces a second source of truth.

### Repos

- Extend `lib/db/repo/fee-definitions.ts`: currently has only `create`, `get`, `listForOrg`; add `update`, `archive` (soft by flipping `is_active = false`, preserving history).
- Extend `lib/db/repo/fee-assignments.ts`: currently has only `create`, `get`, `listForTerm`; add `listForClass(es)`, `replaceForTerm` (set/replace assignments for a term in a single transaction), and an `activate`/`archive` pair that transitions `fee_assignment_status` DRAFT → ACTIVE and * → ARCHIVED.
- New `lib/db/repo/billing.ts`: `previewTerm(termId)` returning the per-student preview without writing (joins `class_enrollments × fee_assignments WHERE status='ACTIVE' AND (class_id IS NULL OR class_id = enrollment.class_id)`); `billTerm(termId, overrides[])` performing the transactional batch using existing `invRepo.createDraft`, `lineRepo.addLines`, `invRepo.issue` calls so money invariants and trigger-maintained balances are untouched.
- Add `termRepo.markBilled(tx, ctx, termId, byUser)` flipping `billed=true`, `status='BILLED'`, and setting the new `billed_at`/`billed_by` columns atomically.

### API routes (all gated by existing `withAuthorizedRoute`)

- `GET  /api/fee-definitions` / `POST /api/fee-definitions` / `PATCH /api/fee-definitions/[id]` — fee definitions CRUD (`fee_definition.manage`).
- `GET  /api/terms/[id]/fee-assignments` / `PUT /api/terms/[id]/fee-assignments` — list/replace assignments for a term (`fee_assignment.manage`).
- `GET  /api/terms/[id]/bill-preview` — returns the preview structure (`term.bill`).
- `POST /api/terms/[id]/bill` — executes the bill run with per-student overrides; idempotent via `Idempotency-Key` header and via the DB-level unique guard (see §11 Schema); returns `{ created: N, unchanged: M, totalKobo, waiversKobo, termStatus }` (`term.bill`).
- **No route changes** to invoices, payments, allocations, receipts, reminders, payment links, or the public `/p/[token]` boundary. Existing `POST /api/invoices` continues to work for ad-hoc (one-off) invoices so ad-hoc charges like damages, field trips, and late-registration penalties are not forced into the bulk path.

### UI

- `/settings/fees` — fee definition CRUD (or under `/terms/[id]`); plus per-term fee assignment matrix (class × fee → amount).
- `/terms` list gets a "Bill" action per ACTIVE term; `/terms/[id]/bill` shows preview, per-student waiver entry, issue button, and a "Last billed" summary.
- Dashboard and Debtors surfaces: a small "Term not yet billed" callout when `billed = false` on the current term (only visible to users who can bill).
- `/invoices/[id]` gets a tiny "Copy payment link" button — calls existing `/api/payment-links` POST, copies to clipboard, no backend changes.

### Security / invariants preserved

Every guarantee called out in §3 of the M7 closeout remains intact. Specifically:

- **No second ledger.** Bill runs produce ordinary invoices and invoice_lines; `total_kobo`, `paid_kobo`, `unallocated_kobo` remain trigger-maintained. The new `waivers` table is an audit record of *why* an `adjustment_kobo` exists, not a competing balance.
- **No UI as financial authority.** All money writes go through the same repos and the same state machine (DRAFT→ISSUED), with triggers as the hard guarantee. The preview is read-only; the issue action is server-validated.
- **Tenant isolation / RLS.** All new tables carry `organization_id`, standard RLS policies, and foreign keys to `organizations(id) ON DELETE CASCADE`. Queries run inside `withTenant`; `scolaira_app` retains its hardened attributes.
- **Authz.** `fee_definition.manage` and `fee_assignment.manage` already exist in the policy matrix and are default-deny; M8 adds exactly one new action `term.bill`, granted only to OWNER and FINANCE_OFFICER, and uses `checkPermission` on every new page. The matrix-as-code invariant (no database-driven permissions; every change is code-reviewed) is preserved.
- **CSRF** on all POSTs via existing `csrfHeaders()`.
- **Idempotency** enforced by database unique index on billable (fee_assignment × student × term), not by client state. The bill run endpoint also accepts an `Idempotency-Key` for the batch itself (defence against double-click).
- **Public-submit boundary unchanged.** The fast-follow payment-link button uses the existing, M6-hardened endpoint; no new public routes, no widening of public RLS, no auto-allocation on public submit.
- **Receipt correctness unchanged.** No new receipt path.
- **Reminder immutability unchanged.**
- **Auditability preserved** — in fact strengthened: invoices created by a bill run carry `created_by` and produce the same `invoice.create` audit events plus a batch-level `term.bill` event.

### Financial safety properties (must be verified in tests)

1. Billing an ACTIVE term with no enrollments → 0 invoices created, term status does NOT flip to BILLED (still ACTIVE), user gets an "No enrolled students" warning (400/422?).
2. Billing a PLANNED/CLOSED term → 409.
3. Re-billing a BILLED term does not duplicate invoices; a new enrollee added between the two runs gets exactly one new invoice; all existing invoices are untouched (verified by counting invoices per fee_assignment before/after).
4. A waiver cannot make a line total negative (server-side invariant, test).
5. A cross-tenant user cannot bill another org's term; cannot read another org's fee definitions; cannot write waivers against another org's invoices.
6. A user without `term.bill` (e.g. SCHOOL_ADMIN, STAFF) gets 403 on POST bill and AccessDenied on the page.
7. Unauthenticated → 401; CSRF-less POST → 403/401.
8. Bill runs leave `invoices.total_kobo = sum(invoice_lines.amount_kobo)` (existing trigger), and the resulting invoices appear in the existing `/api/debtors` list with the expected balance on day one.
9. The fast-follow payment-link button respects the same `paymentLink.create` permission used today; revoking/reuse semantics match existing behaviour.

---

## 12. Verification Strategy (M8 will be EXECUTED, not inspected)

When M8 is implemented, "VERIFIED" means:

- **Adversarial test file(s)** covering at minimum:
  - permissions (unauth, CSRF, wrong-role, cross-tenant on every new route);
  - billing lifecycle (planned→rejected, active→billed, closed→rejected, empty-enrollment→rejected);
  - idempotency (double-issue = 0 new invoices; post-billing enrollee is picked up; re-bill with no changes = unchanged);
  - waiver invariants (negative line amount, capped at line total, permission-gated approval);
  - that the produced invoices are byte-for-byte compatible with manual invoices (show up in `/api/invoices`, `/api/debtors`, dashboard KPIs, accept allocations, produce receipts);
  - RLS on the new tables using the existing `SET LOCAL ROLE scolaira_app` + SAVEPOINT pattern established in M7.
- **Regression gates**: existing 232 M5/M6/M7 tests pass unchanged (any change to existing tests must be justified, and in almost all cases there should be none — M8 adds additive routes and tables, not mutations to existing ones).
- **tsc** and **`next build`** clean; the new pages appear as dynamic routes in the build output.
- **Runtime role attributes** (`NOSUPERUSER/NOINHERIT/NOCREATEROLE/NOCREATEDB/NOBYPASSRLS`) re-verified after the new migration.
- **Working tree clean** before freeze commit.

Real-device, bank integration, and backup/restore drills remain unverified as in M7 — called out honestly.

---

## 13. Risks

1. **Over-scoping M8 into "full AR automation."** Mitigation: hard non-goals in §15; bank import, auto-allocation, statement-as-ledger, and multi-channel reminders are explicitly out.
2. **Double-billing on re-run.** Mitigation: database-level partial unique index (not application logic) guards against duplicate lines for the same fee_assignment+student+term; re-run only tops up missing enrollee invoices.
3. **Introducing a competing ledger via waivers/batches.** Mitigation: waivers are structured reasons attached to existing `invoice_lines.adjustment_kobo`; they are not a separate balance. No new aggregate numbers are introduced at the KPI layer.
4. **Per-student waiver UX becoming a backdoor for arbitrary edits.** Mitigation: waivers reason is an enum; amount is capped at line total; requires explicit permission; audit event logged; waivers are immutable after the invoice is ISSUED (adjustment after issue must go through a credit-note flow, deferred).
5. **Breaking the invoice state machine.** Mitigation: bill run uses the existing `createDraft → addLines → issue` repo functions; it does not bypass them.
6. **Cross-migration coupling.** Mitigation: one numbered migration (`0020`) with idempotent DDL where possible; test DB is migrated from 0000 forward to verify.
7. **Founder test perceived as "just a bulk form."** Mitigation: the framing is not "we added a button"; the framing is "for the first time the system owns the moment at which a term's obligations come into existence, and every M5/M6/M7 feature becomes correct because the invoice population is complete." Measured by (a) time-to-bill, (b) debtor-list coverage = enrolled count on billing day.

---

## 14. What a School Does Better on Monday Morning (founder's test, concretely)

**Before M8.** Bursar arrives the first week of term, opens the invoice form, picks the first student, types "First Term Tuition — ₦150,000", clicks Issue. Repeats. And repeats. At 60 seconds per invoice × 4 fee heads × 300 students, that is 200+ minutes of pure data entry — in practice a day or two, interrupted by corrections. Some students are missed (admissions office added them last week and the bursar didn't get the list). Some amounts are mistyped (₦15,000 instead of ₦150,000). Debtors workbench shows 230 debtors instead of 300; reminder print-outs go to the wrong parents for the wrong amounts; the proprietor sees a 77% collection rate on the dashboard and thinks things are going well when billed coverage was actually 77% — so the real collection rate is 59%. The invoice set is wrong, and every downstream number is wrong with it.

**Monday after M8 ships.** Bursar (or proprietor) opens *Bill term* for 2026/2027 First Term. A preview renders in under a second:

| Class | Students | Fees | Expected total |
|---|---|---|---|
| JSS 1A | 38 | Tuition ₦150,000; Dev levy ₦20,000; Uniform ₦15,000 | ₦7,030,000 |
| JSS 1B | 36 | … | ₦6,660,000 |
| … | … | … | … |
| **Total** | **300** | | **₦57,450,000** |

Below: a per-student grid with a waiver column. The bursar marks the proprietor's two children "STAFF_CHILD 100%" and three scholarship students "SCHOLARSHIP 100%", and one sibling pair "SIBLING_DISCOUNT 10%". Clicks *Issue*. ~300 invoices (one per student, with correct line items, linked to fee assignments for future reporting) are created and issued in one transaction; the term flips to BILLED; audit events are written; dashboard KPIs refresh against the complete set. **Elapsed wall-clock time for the core billing event: roughly 10 minutes of review instead of a working day.**

The debtors workbench now shows all 300 students (minus the scholarship ones who net to zero) from day one. Reminders go to the right parents for the right amounts. The collection rate on the dashboard is honest. A new student admitted in week 3 gets billed when the bursar re-runs "Bill term" — no double-billing, no missed student.

That is material. That is what makes Scolaira the system of record instead of a reconciliation tool on top of a spreadsheet.

---

## 15. Non-Goals (M8 will NOT do these)

To keep M8 shippable and safe:

1. **No bank-statement import, no auto-matching, no fuzzy reconciliation.**
2. **No payment-provider integration beyond what M6 already supports.** Paystack webhooks, SMS/WhatsApp/email dispatch, and any external side effects are out.
3. **No term-close / carry-forward of outstanding balances.** This is the next obvious milestone after M8 (Candidate D), but it depends on a complete billed set and is explicitly deferred.
4. **No auto-FIFO allocation or multi-invoice smart allocation.** Existing allocation flow is untouched; the UI still allows one-at-a-time allocation as today. Smart allocation is deferred.
5. **No student-level wallet / credit / deposit ledger.** Overpay continues to live on `payments.unallocated_kobo`.
6. **No guardian self-service portal.** No new user class, no invites, no password reset for guardians.
7. **No edits to invoices after ISSUE for waiver purposes.** Waivers entered at bill-preview time are applied at draft time before issue; post-issue concessions will be a later credit-note flow.
8. **No removal of the single-student invoice form.** It remains the escape hatch for ad-hoc fees (one-off damages, field trips, late registration) that don't fit the per-term fee structure.
9. **No changes to existing RLS, runtime role, SECURITY DEFINER resolvers, idempotency, receipts, reminders, payment-link security, or dashboard term scoping.** Any change to those is a bug.
10. **No customer research or interviews.** This report is code-and-structure grounded.

---

## 16. Deferred Work (explicit backlog, in suggested order)

Order | Item | Why it comes after M8
---|---|---
D1 | **Payment-link affordance on invoice detail** (Candidate E, the tiny fast-follow) | Ships in M8's tail if time allows; zero backend risk.
D2 | **Multi-invoice allocation UI** (Candidate B) | Once a full invoice set exists per student, splitting a parent's transfer across tuition + levy + uniform is the daily reconciliation pain point.
D3 | **Suggested allocation on public payment submit** | Attach `invoiceId` to PENDING payments created via a link (non-authoritative hint) and pre-fill the confirm/allocate form. Safe because final allocation still requires the bursar.
D4 | **Term close & carry-forward** (Candidate D) | Requires BILLED to be meaningful; produces "Brought forward" line on next term's invoices for students with residual balances; flips `status = CLOSED`, locks further invoice creation on that term.
D5 | **Student credit / unallocated-cash wallet** | The clean home for overpay and for deposits before enrolment; needed before instalment/payment-plan work makes sense.
D6 | **Bank statement import & match** (Candidate C) | CSV upload + matcher; build on a complete invoice base.
D7 | **Payment plans / instalment agreements** | Requires scheduled partial-payment obligations, due dates per instalment, early/late tracking.
D8 | **Multi-channel reminder dispatch** (SMS via Termii/AfricasTalking, WhatsApp, email) once a provider is chosen.
D9 | **Guardian portal** — multi-ward, invoices/receipts/pay online, after invoice data is guaranteed complete.
D10 | **Richer reporting** (CSV export, fees-collected-by-type, class-by-class collection rate, waiver totals).

The ordering matters: D4 (close) depends on M8; D5/D6/D7 depend on a clean billed-and-closed cycle; D9 depends on everything before it.

---

## 17. Build Sequence (suggested, for the M8 implementation milestone)

1. **Migration `0020_term_billing.sql`**: add `billed_at`, `billed_by` to terms (already has `billed`/`status`); add `waivers` table; add the partial unique index that prevents double-billing of the same fee assignment to the same student for the same term; add RLS; add audit trigger mirroring existing tables.
2. **Repo layer** (no routes): extend fee-definitions and fee-assignments repos; add `billing.previewTerm` (read-only) and `billing.billTerm` (transactional, reuses existing invoice/lines/issue repos); add `termRepo.markBilled`.
3. **Authz**: add the single new action `term.bill` to the `Action` union and the POLICY sets for OWNER and FINANCE_OFFICER only in `lib/authz/permissions.ts` (`fee_definition.manage` and `fee_assignment.manage` already exist with the correct role grants). Add `term.bill` to the audit action enum and to the audit action whitelist.
4. **API routes**: fees CRUD, fee-assignments PUT/list for a term, bill-preview GET, bill POST. All behind `withAuthorizedRoute` with CSRF; bill endpoint supports `Idempotency-Key`.
5. **UI**: settings/fees page (or term-scoped fee matrix); bill preview page with per-student waiver entry; "Term not billed" callout on dashboard and debtors for authorized users.
6. **Fast-follow**: "Copy payment link" button on invoice detail (no backend changes).
7. **Tests**: new adversarial test file(s) covering the scenarios in §11; run alongside the existing 232 tests; assert zero regressions.
8. **Verification gates**: `tsc`, `next build`, runtime role re-check, working tree clean.
9. **Closeout report** (`M8_CLOSEOUT_REPORT.md`) following the M5/M6/M7 template, with final executed test counts and explicit non-verified items (real device, PSP integration, backup/restore remain).
10. **Freeze commit** with `git -c user.name="Scolaira" -c user.email="dev@scolaira.app"`.

---

## 18. Open Questions to Resolve at Implementation Time (not at recon time)

These are design decisions that should be made when coding, not now:

- **Waivers shape.** Add a `waivers` table, or put `waiver_reason` on `invoice_lines` with a JSONB column, or both? A separate table is cleaner for reporting but requires an extra insert per waiver; a column is simpler. Recommendation: separate `waivers` table with FK to `invoice_lines.id`, immutable after INSERT, RLS + audit.
- **Billing batches table.** Is a `billing_batches` entity worth it for audit, or is a `term.bill` audit event sufficient? Default: skip the table; the batch-level audit event plus per-invoice audit events are enough. Reintroduce only if the preview-to-issue flow needs to persist a draft preview.
- **Handling post-billing enrolments precisely.** Re-running Bill term picks up any enrolled student missing invoices for any assigned fee. Should this be automatic on student enrollment (eager) or explicit (lazy, on bursar re-click)? Default: explicit — bursar clicks "Bill new enrolments" (same Bill term endpoint, same idempotency semantics) so a newly admitted student isn't silently invoiced before the bursar has reviewed their concessions.
- **Multi-currency?** Out. Schema has `currency` on payments; invoices inherit NGN via org default (which exists implicitly today). No change.
- **What if a fee definition's amount changes mid-term?** Invoices already issued keep their line amounts (that is the whole point of issued invoices); future re-runs (new enrollee invoices) use the current fee-assignment amount. This is correct behaviour.

---

## 19. Evidence Gaps Honestly Acknowledged

Per the founder's directive:

- **No school visits, no bursar interviews, no support tickets, no analytics** informed this report. The friction ranking is derived from code structure (e.g., the allocation UI supports only one invoice at a time; the invoice form takes one student; fee tables exist but have no routes). It is possible that a real bursar would rank bank-statement import higher than bulk billing — but the code shows that bulk billing is the precondition for bank matching to be correct, and the schema literally has a `billed` lifecycle column waiting to be flipped, which is the strongest possible signal that bulk billing was always intended as the next step.
- **No data on average invoice-per-student ratio or term size in real usage.** The 300-students × 4-fee-heads example is illustrative; the structural argument holds for any school larger than ~20 students.
- **No competitor benchmarking was performed.** No web research was used; conclusions are internal to the codebase.

If the founder has direct field evidence that contradicts the friction ranking, Candidate B/C/D/E can be revisited with no cost — this report commits to no code, only to a direction.

---

## 20. Recommendation

Proceed with **M8 = Bulk Term Billing (Candidate A)**, with the small payment-link UX fast-follow (Candidate E) folded in if time permits, and with the explicit non-goals and deferred list above. The work is scoped to one migration, a small set of additive routes/pages, and zero changes to existing financial invariants or to the public security boundary. It moves the system from "you can record what happens" to "you drive the start of the term," which is the position Scolaira must occupy before term-close, reconciliation, or self-service can be built honestly.
