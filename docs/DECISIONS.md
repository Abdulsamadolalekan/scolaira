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

---

## Section IV — H-9 Operational Decisions (2026-09-26)

Recorded during H-9 Tranche 1. Each is a decision about what is *claimed*, not a change to the
product: they exist so no reader has to guess whether an operational control is present.

### D-029 | 2026-09-26 | MUST | OPERATIONS

**Decision:** The readiness dependency set stays exactly what H-6 shipped — **three required checks:
`database`, `schema`, `auth`** — pinned by `e2e/readiness.spec.ts`. No check is added by H-9.
**Why:** `/api/ready` answers "can this build serve traffic against this database". Every candidate
addition was measured against that question and rejected: a *backup* check would assert a control
that does not exist (H9-F1) and would turn a missing capability into a permanent `503`; a *financial
invariant* check would require the probe to read tenant data on every request, widening the runtime's
data access on a public endpoint; an *alert consumer* check is not a readiness property at all. H-6's
measured failure modes (`database_unreachable`, `schema_behind`, `auth_crypto_broken`, …) already
cover every way this build can be unable to serve, and each has a measured `503` behind it.
**Consequence:** H-6's `lib/ops/readiness.ts`, `app/api/ready/route.ts` and `e2e/readiness.spec.ts`
are **not modified**, so no H-6-verified file is touched and the tested SHA `dca6a84` stays valid.
**Status:** DECIDED. Revisit only if a new dependency becomes load-bearing for serving traffic.

### D-030 | 2026-09-26 | MUST | OPERATIONS

**Decision:** Until an environment exists to run it in, alerting is **manual**: a daily check of
`/api/ready` and of the `readiness_failed` log event, owned by the founder/support, documented in
`docs/ops/INCIDENT_SEVERITY.md`. No alert consumer is built by H-9 and **no alerting capability is
claimed**.
**Why:** `readiness_failed` already emits a machine-readable line (H-6), so the signal exists; what
does not exist is a host, a log sink and a destination. Building a consumer against an unselected
provider would be inventing an integration (H9-F12). A manual cadence is the honest interim control,
and its limits are written down rather than implied.
**Consequence:** `docs/OPERATIONS.md` §V states plainly that nothing is delivered anywhere.
**Status:** DECIDED (interim). Superseded by the first real deployment's alerting evidence (H9-9).

### D-031 | 2026-09-26 | MUST | DATA

**Decision:** The `communications` table **stays as it is** — provider-shaped, unused, and documented
as unused. No writer or reader is added, no provider is integrated, and no migration is created by
H-9.
**Why:** There is no e-mail/SMS provider, no delivery channel beyond link copy and print, and no
authorised work to add one (H9-F13 is a separate, later authorisation). Dropping or altering the
table would mean editing an applied migration, which is forbidden while history is frozen; leaving it
undocumented would let a reader mistake a schema shape for a capability.
**Consequence:** Operational documents no longer list e-mail/SMS delivery as a working channel.
**Status:** DECIDED. Revisit only if provider delivery is authorised (that work would add `0051`+).

### D-032 | 2026-09-26 | MUST | OPERATIONS, FINANCIAL

**Decision:** A restored database is **verified before it serves traffic**, using
`scripts/verify-restored-db.ts` (read-only; catalog + financial-invariant + privilege checks). A run
that reports `SKIPPED` checks is `NOT VERIFIED` and does not count as a pass.
**Why:** "The restore finished" is not evidence that financial truth survived it, and a human
eyeballing rows cannot check 42 row-level-secured tables and six invariants. The tool also makes the
privilege posture part of a restore, which is how the E2E seed divergence (H9-F24) was found.
**Consequence:** The restore runbook (`docs/ops/RESTORE_TO_CLEAN_DATABASE.md` §6) makes this step
mandatory, and the tool is exercised against deliberate damage in
`tests/db/h9-restore-verification.test.ts` so a silent PASS is itself a failing test.
**Status:** DECIDED. Applies from the first real restore (T2) onward.
