# SCOLAIRA — Product Roadmap

> Phase-gated. Phase 1 must be trustworthy before we build anything from later phases.

---

## Phase 0 — Foundation & Approval (Current)

**Goal:** Stand up the architecture, docs, repo, and get founder approval.

**Deliverables:**

- [x] Documentation foundation (this set).
- [x] Executive architecture review.
- [x] Gap analysis.
- [ ] Founder approval on decisions D1–D15 (see `/docs/ARCHITECTURE.md` §T).
- [ ] Git remote configured; first push.
- [ ] Provisioning of Supabase + Vercel projects.
- [ ] CI pipeline running lint + type-check + unit tests.
- [ ] Scaffold Next.js app with auth, basic layout, design tokens.

**Exit criteria:** approved stack, remote backup, production-ready scaffolding, CI green, core schema migrated to dev database.

---

## Phase 1 — Financial Truth

**Goal:** The ledger is correct. A finance officer can record students, set up a term, bill students, record cash/transfer/POS payments, allocate them, see accurate outstanding balances, and view an audit trail. Reconciliation is manual but clear.

**Slices:**

1. Auth + roles + memberships + organization setup.
2. Onboarding wizard: org → session → term → classes → fee catalog → students (manual entry, no CSV yet).
3. Students CRUD + guardians; class enrollment per term.
4. Fee catalog + fee assignments.
5. Billing: preview → run (DRAFT invoices) → issue.
6. Invoices list/detail (statuses DRAFT/ISSUED/PAID/PARTIALLY_PAID/VOID).
7. Record payment (cash/transfer/POS/manual) with deterministic auto-allocation.
8. Manual allocation UI (reallocate within open period).
9. Receipt generation (print view).
10. Basic Command Center (billed/collected/outstanding for current term; totals only).
11. Audit log viewer for OWNER.
12. Permission enforcement across every endpoint.
13. Full financial test matrix for manual-payment flows.
14. Security test matrix for cross-tenant + privilege escalation.

**Exit criteria:**

- Invariants F1–F15 hold under automated concurrency tests.
- A finance officer can bill and collect for a sample 200-student school accurately.
- Proprietor can see billed/collected/outstanding with confidence.
- No fake "demo" data paths; every number is derived from the ledger.

---

## Phase 2 — Payment Completeness

**Goal:** Every payment method a school uses is first-class. Payment links work. Parents can view and pay online.

**Slices:**

1. Paystack integration (test then live): inline payment via parent page + webhook processing (idempotent).
2. Parent payment page (`/pay/:token`): mobile-first, itemized, status, success page.
3. Payment link generation + lifecycle (ACTIVE/PAID/EXPIRED/REVOKED).
4. CSV import for students (dry-run, per-row errors, rollback on bad data).
5. CSV import for historical invoices/payments (pilot migration path).
6. Reconciliation for online payments (PENDING → CONFIRMED).
7. Duplicate-suspect detection (same external reference + same amount within window).
8. Email receipts via Resend.
9. Partial payments and multi-invoice allocation polish.
10. Previous-term debt carry-forward (invoices in non-current terms visible separately).

**Exit criteria:**

- Paystack webhooks are idempotent under duplicate/replay/out-of-order tests.
- Cash, transfer, POS, online payments all produce identical ledger outcomes.
- A parent can pay via a link without creating an account.
- Pilot school can import their student list via CSV successfully.

---

## Phase 3 — Reconciliation (Flagship)

**Goal:** Reconciliation becomes the product's strongest differentiator. Unknown money flows through a clear, low-friction review path.

**Slices:**

1. Reconciliation queue: TO CONFIRM, TO ALLOCATE, DUPLICATE_SUSPECT, FLAGGED, UNMATCHED.
2. Match-student suggestions for unmatched transfers (by amount + date + class + parent name hints).
3. Confirm-with-evidence (finance officer attaches note/bank screenshot reference).
4. Excess-payment handling (partial allocation + unallocated remainder visible).
5. Reversal / refund workflow with required reason + audit.
6. Duplicate resolution (link to original; reject).
7. Bank-statement CSV import (Parse corporate bank statement CSV; match against recorded transfers; flag unmatched both ways).
8. Reconciliation performance metrics (time-to-reconcile, unreconciled aging).

**Exit criteria:**

- A finance officer can go from "unknown ₦500,000 transfer" → fully reconciled in <60 seconds per transaction for routine cases.
- Reconciliation queue is empty only when all recorded money is allocated and confirmed.
- Reconciliation report shows exactly what money is unresolved and why.

---

## Phase 4 — Command Center Intelligence

**Goal:** Within seconds, a proprietor knows: what's billed, what's collected, what's outstanding, what's overdue, what's unreconciled, what needs attention, what to do next.

**Slices:**

1. Command Center redesign with KPI hierarchy (AMOUNT → STATUS → WHO → WHY → NEXT ACTION).
2. Trends: week-over-week, term-to-date collection velocity.
3. Overdue concentration (classes, fee lines, guardians).
4. Prior-term exposure widget.
5. Unreconciled count/amount with one-click-to-queue.
6. Action feed ("3 accounts 30+ days over ₦200k", "9 payments awaiting review").
7. Class performance leaderboard (collection rate).
8. Fee-line recovery (which fees are hardest to collect).
9. Payment-method breakdown (cash vs transfer vs POS vs online).
10. Reports module v1 (all core reports from API contracts §M).

**Exit criteria:**

- Proprietor questions from Section 75 of the directive are answered within 10 seconds of opening the app.
- Every number on the Command Center opens a drilldown that shows the underlying transactions.
- No decorative charts — every visual supports a decision.

---

## Phase 5 — Collection Priority

**Goal:** Deterministic, explainable prioritization of which accounts to follow up, in what order.

**Slices:**

1. Priority scoring algorithm (amount × age × prior-term debt × promised-pay status × invoice age).
2. Priority list in Financial Action Centre: each item explains WHY it's high priority.
3. Promised-payment tracking (finance officer logs "parent promised ₦150k on 12 Oct"; SCOLAIRA flags if missed).
4. Follow-up task list for finance officers (not personal to-do, team-visible).
5. Class-level exposure ranking.
6. Guardrail: never "AI recommends"; always show the factors.

---

## Phase 6 — Financial Memory

**Goal:** SCOLAIRA becomes the permanent, trusted financial memory of the school. Term-over-term, year-over-year.

**Slices:**

1. Multi-term, multi-session history browser.
2. Student financial profile: every invoice, every payment, every receipt, every term.
3. Payment behavior patterns (payer-type, frequency, typical timeliness).
4. Sibling/family grouping awareness (optional; helps with collections).
5. Annual/term comparison reports.
6. Archived/withdrawn student access (read-only history preserved).
7. Year-end close workflow (lock term, produce summary, carry forward balances).

---

## Phase 7 — Communication / Workflow Refinement

**Goal:** The school can move from insight to action within SCOLAIRA.

**Slices:**

1. SMS reminders (provider TBD per D10).
2. WhatsApp messaging via Business API (consider Termly, Twilio, or 360dialog).
3. Bulk reminder by segment (overdue > 30d, prior-term balance, etc.).
4. Receipt delivery via email/WhatsApp.
5. Template library in clear, plain English/Hausa/Igbo/Yoruba? (ASSUMPTION: English at pilot; local languages later).
6. Print-ready statements for paper distribution.
7. Communication history per student/guardian.
8. Opt-out management per channel.

---

## Phase 8 — Parent Experience Refinement

**Goal:** The parent experience becomes as premium and simple as the school console.

**Slices:**

1. Parent-facing balance page refresh (premium, mobile).
2. Multi-invoice payment flow (parent selects what to pay, sees balance before/after).
3. Instant digital receipt (WhatsApp/email).
4. Payment-history view via signed link (no account).
5. USSD payment option exploration (Nigeria-relevant; RESEARCH, not commit).
6. Progressive engagement: reminder link → view balance → pay → receipt.

---

## Phase 9 — Platform Scalability

**Goal:** Move from pilot-grade operations to a scalable multi-school platform.

**Slices:**

1. Observability upgrade (metrics platform, tracing, SLOs).
2. Performance: indexes, query review, caching where safe (never for mutable financial totals).
3. Subscription/billing automation (per-Term simple pricing; paystack-powered).
4. Onboarding automation (self-serve for new schools).
5. Support tooling (audited support sessions, impersonation).
6. Bulk school operations (platform admin).
7. Load testing at 100-school scale.
8. Automated backup verification + quarterly restore drills.

---

## Phase 10 — Financial Infrastructure (Long-term)

**Goal:** Deeper payment infrastructure where it serves the school's interest without SCOLAIRA becoming a custodian of funds.

**Slices (exploratory; do NOT start now):**

- Deeper bank integrations for automated statement ingest.
- Virtual accounts per student/parent (with partner bank; funds settle to school).
- Direct debit / standing-order style arrangements for parents with bank access.
- Pay-with-transfer (dynamic account numbers).
- SCOLAIRA Collections service.

**Important:** Funds must always settle directly to the school's own account; SCOLAIRA must not casually become custodian. Build only when unit economics and regulatory posture support it.

---

## Out of Scope (Indefinitely)

- AI chatbot
- Gamification
- Attendance, grading, timetables, academic management
- Parent social network / feed
- Decorative analytics / vanity metrics
- Complicated SaaS pricing tiers
- Microservices before they're needed

## Decision Record Requirement

Any change to phasing (e.g., "let's do payment links before reconciliation is perfect") requires:

1. A decision record in `/docs/DECISIONS.md` tagged PHASE_CHANGE.
2. An explicit statement of what we gain.
3. An explicit statement of what risk we accept.
4. Founder sign-off if it affects Phase 1–3 (core trust layers).
