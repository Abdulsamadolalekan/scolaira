# SCOLAIRA — Decision Log (REVISED v2)

> Every significant decision is classified: MUST / SHOULD / MAY / DEFER and tagged with domains.
> Format: `D-<id> | <date> | <classification> | <tags> — <summary>`

---

## Section I — Approved in This Revision (Founder Corrections)

### D-011 | 2026-09-15 | MUST | ARCHITECTURE, OPERATIONS

**Decision:** Stack is approved architecturally as Next.js + TypeScript + PostgreSQL (via Supabase) + Drizzle + Vercel + Vitest + Playwright. Exact versions are NOT hard-coded; they are selected at scaffolding time based on current stable production-supported releases, compatibility, and security, and recorded in `package.json` + lockfile.
**Why:** Per Founder Correction 1. Pinning Next.js 14 at this stage would be brittle; we commit to the stack _shape_ and let the current stable versions be chosen at implementation time.
**Benefit:** Uses best available stable versions at build time; avoids known-vulnerable versions.
**Risk:** Framework minor-version differences could introduce surprises; mitigated by lockfile pinning + CI + upgrade discipline.
**Status:** APPROVED.

### D-012 | 2026-09-15 | MUST | OPERATIONS, INFRA

**Decision:** GitHub remote is a HARD PRE-CODE GATE. No application code is created until: (1) founder-owned private repo exists; (2) local git initialized (already done); (3) remote configured; (4) initial documentation pushed; (5) remote verified (`git ls-remote`); (6) default branch is `main` (already renamed). At every major milestone: COMMIT → PUSH → VERIFY REMOTE. Backups are not claimed unless verified.
**Why:** Per Founder Correction 2 and §47 of the directive. The project must NEVER again exist only in an Arena sandbox.
**Status:** APPROVED; GATE NOT YET PASSED. Needs founder to create repo and grant push access.

### D-013 | 2026-09-15 | MUST | INFRA, LEGAL

**Decision:** All critical company infrastructure is ultimately owned and controlled by the founder/company: GitHub, Domain, Vercel, Supabase, Paystack, Resend, monitoring, email, future messaging providers. Arena is an engineering environment only.
**Why:** Per Founder Correction 3. Founder controls the company; infrastructure ownership cannot rest with a contractor, employee, or sandbox.
**Status:** APPROVED.

### D-014 | 2026-09-15 | MUST | INFRA, ARCHITECTURE

**Decision:** Domain architecture: public `scolaira.com`; app `app.scolaira.com`; parent pages `app.scolaira.com/pay/:token` initially (future `pay.scolaira.com` migration designed to be straightforward); platform admin lives on an isolated `/admin` route during pilot, to migrate to `admin.scolaira.com` later.
**Why:** Per Founder Correction 4. Keep pilot simple; design so later migration to dedicated subdomains is not a rewrite (canonical URL helper env-driven; cookies scoped appropriately).
**Status:** APPROVED.

### D-015 | 2026-09-15 | MUST | UX, DESIGN

**Decision:** Do NOT invent a new visual identity. Use the founder-established brand direction (private bank × distinguished school; deep forest/emerald green, rich gold, white, warm ivory, near-black). Color is implemented through SEMANTIC DESIGN TOKENS, not hard-coded hex values in components. Interim token values draw from the founder-provided references (`#1B4332`, `#D4AF37`, `#FDFBF6`, `#17201C` and `#0B3D2E`, `#C9A227`) but are NOT final. Final palette to be established via the design system review process.
**Why:** Per Founder Correction 5.
**Status:** APPROVED.

### D-016 | 2026-09-15 | MUST | PRODUCT, PROCESS

**Decision:** The pilot school is important but NOT a blocker for foundational engineering. Build Phase 1 (Financial Truth) on documented domain assumptions; mark assumptions explicitly; pilot school will validate/refine. Do not wait indefinitely; do not pretend assumptions are facts.
**Why:** Per Founder Correction 6.
**Status:** APPROVED.

### D-017 | 2026-09-15 | MUST | PRIVACY, LEGAL

**Decision:** Before production student data is introduced, a specific DATA RESIDENCY & PRIVACY DECISION document will be completed covering: selected Supabase region, why selected, residency considerations, subprocessors, backup locations, international transfer considerations, retention, deletion/erasure, NDPR considerations, school responsibilities, SCOLAIRA responsibilities, and items requiring legal review. Selecting a hosting region does not itself equal legal compliance.
**Why:** Per Founder Correction 7.
**Status:** Skeleton drafted at `/docs/DATA_RESIDENCY_AND_PRIVACY.md`; completion required before production go-live.

### D-018 | 2026-09-15 | MUST | PRODUCT, DISCOVERY

**Decision:** Before finalizing Reconciliation (Phase 3), execute the REAL-WORLD FINANCIAL WORKFLOW DISCOVERY PLAN covering every cash/transfer/POS/online/edge-case workflow enumerated by the founder, including: sibling payments, multi-invoice payments, previous-term debt, over/under payments, wrong-account, unidentified payments, duplicates, refunds, reversals, discounts/scholarships/waivers, manual receipts, bank statement reconciliation, finance-officer workflow, and proprietor review workflow.
**Why:** Per Founder Correction 8.
**Status:** Plan created at `/docs/discovery/REAL_WORLD_DISCOVERY_PLAN.md`; execution begins as soon as pilot school is identified. Phase 1 (which uses manual reconciliation) proceeds in parallel.

### D-019 | 2026-09-15 | MUST | ARCHITECTURE, DATA

**Decision:** State machines explicitly defined for Student, Invoice, Payment, Payment Allocation, Receipt, Reversal, Refund, Payment Link, Communication, Term, Fee Assignment. Each specifies: valid states, allowed transitions, who triggers each, DB changes, audit event, failure behavior.
**Why:** Per Founder Correction 9.
**Status:** Defined in `/docs/state-machines/`.

### D-020 | 2026-09-15 | MUST | ARCHITECTURE, DATA

**Decision:** Explicitly classify records as either AUTHORITATIVE FINANCIAL TRUTH (the ledger) or DERIVED / OPERATIONAL / PRESENTATION. Dashboard KPIs and reports never become an alternative source of truth.
**Why:** Per Founder Correction 10.
**Status:** Defined in `/docs/FINANCIAL_TRUTH_MODEL.md`.

### D-021 | 2026-09-15 | MUST | TECHNICAL, FINANCIAL

**Decision:** For each of the 7 concurrency cases (A–G), concrete transaction behavior is specified: lock, constraint, idempotency, transaction steps, state transition, expected result.
**Why:** Per Founder Correction 11.
**Status:** Defined in `/docs/CONCURRENCY_DESIGN.md`. Tests will cover each case.

### D-022 | 2026-09-15 | MUST | SECURITY, AUDIT

**Decision:** Audit model defines financially significant events (enumerated per founder's list) with the seven required questions: WHO, DID WHAT, WHEN, TO WHICH RECORD, BEFORE, AFTER, WHY. Audit table is append-only (INSERT-only DB role), tamper-evident hash chain deferred post-pilot.
**Why:** Per Founder Correction 12.
**Status:** Defined in `/docs/AUDIT_MODEL.md`.

### D-023 | 2026-09-15 | MUST | PRODUCT, DISCOVERY

**Decision:** Maintain a PRODUCT DISCOVERY BACKLOG categorized VALIDATED / ASSUMED / UNKNOWN. UNKNOWN requirements must not silently become architecture.
**Why:** Per Founder Correction 13.
**Status:** Created at `/docs/discovery/PRODUCT_DISCOVERY_BACKLOG.md`.

### D-024 | 2026-09-15 | MUST | BUSINESS

**Decision:** Pricing/commercial model uses the company brief as source of truth. No new pricing is invented during implementation. If a pricing decision requires reconsideration, it is entered in this decision log rather than silently changed. Billing integration is deferred to Phase 9; `organizations.plan` included in schema for future use.
**Why:** Per Founder Correction 14.
**Status:** APPROVED.

### D-025 | 2026-09-15 | MUST | UX, DESIGN

**Decision:** Before building many screens, create a real SCOLAIRA design system foundation (typography, spacing, color tokens, semantic colors, borders, radii, shadows, buttons, inputs, tables, badges, status indicators, dialogs, drawers, navigation, empty/loading/error states, confirmation patterns, financial number formatting). Screens are composed from these primitives.
**Why:** Per Founder Correction 15.
**Status:** Plan created at `/docs/design-system/DESIGN_SYSTEM_PLAN.md`; implementation as M1 milestone post-gate.

### D-026 | 2026-09-15 | MUST | UX, PRODUCT

**Decision:** UX priority order: (1) OWNER — Command Center → financial truth → action; (2) FINANCE OFFICER — Payment → allocation → reconciliation → receipt; (3) PARENT — View obligation → understand amount → pay / know how to pay → confirmation. Everything else supports these journeys.
**Why:** Per Founder Correction 16.
**Status:** APPROVED; IA updated in `/docs/ARCHITECTURE.md` §M.

### D-027 | 2026-09-15 | MUST | PROCESS

**Decision:** After incorporating all 17 founder corrections, STOP ONCE MORE and present the revised gate (decision register, state machines, financial truth model, discovery plan, risk register, architecture, design system plan, implementation sequence, pre-code checklist). Do NOT scaffold until this revised gate is approved.
**Why:** Per Founder Correction 17.
**Status:** This document is part of that STOP.

### D-028 | 2026-09-15 | MUST | PRODUCT, PHILOSOPHY

**Decision:** SCOLAIRA is not to be the most technically complicated school-fee product. It is to be the most TRUSTWORTHY, CLEAR, OPERATIONALLY USEFUL, and FINANCIALLY CORRECT system a Nigerian private-school proprietor can use. Complexity belongs underneath; clarity belongs on top. Build for the first school; architect for thousands. Protect financial truth as if the company's reputation depends on every naira — because it does.
**Why:** Final Founder Principle.
**Status:** APPROVED as guiding principle.

---

## Section II — Previously Recorded Decisions (Carried Forward)

### D-001 | 2026-09-15 | MUST | ARCHITECTURE, PROCESS

**Decision:** Do not code on day 1; produce documentation and architecture review first.
**Status:** Done and extended by D-027 (double stop-gate).

### D-003 | 2026-09-15 | MUST | FINANCIAL, DATA

**Decision:** Internal money = INTEGER KOBO (BIGINT); external API = NAIRA STRING.
**Status:** Canonical invariant; unchanged.

### D-004 | 2026-09-15 | SHOULD | FINANCIAL

**Decision:** Default deterministic allocation: overdue-first → current-term due-date order → prior-term oldest-first; remainder stays unallocated for review. Finance officer can reallocate.
**Status:** In code plan; to be validated during Discovery.

### D-005 | 2026-09-15 | MUST | SECURITY

**Decision:** Defense-in-depth tenant isolation (app scoping + Postgres RLS).
**Status:** Unchanged.

### D-006 | 2026-09-15 | MUST | UX

**Decision:** Parents do NOT create conventional accounts; transactional signed-link experience.
**Status:** Unchanged.

### D-007 | 2026-09-15 | MUST | DATA

**Decision:** Local Postgres from day one (no SQLite dev; no SQLite-specific logic).
**Status:** Unchanged.

### D-009 | 2026-09-15 | MUST | FINANCIAL, UX

**Decision:** Confirmed payments cannot be deleted; reversal/correction with reason is the only correction path.
**Status:** Unchanged; codified in state machines.

---

## Section III — Remaining Open Items From D1–D15, Updated

Original D1–D15 have been resolved by D-011 through D-028 except where noted below. Items still needing explicit founder sign-off in the revised gate are listed in the executive review §DD (Approval Checklist).
