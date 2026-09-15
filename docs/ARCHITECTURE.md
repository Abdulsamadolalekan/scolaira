# SCOLAIRA — Architecture (REVISED v2)

> Build today's product such that tomorrow's platform remains possible.
> **Complexity belongs underneath. Clarity belongs on top.**
> **Build for the first school. Architect for thousands.**

---

## A. Executive Summary

SCOLAIRA is a multi-tenant financial SaaS for proprietor-owned Nigerian private schools. It owns the fee financial chain — bill → collect → allocate → reconcile → report — across every payment method a school uses (cash, transfer, POS, online). Parents never need a conventional account.

The architecture must deliver, in priority order:
1. **Trustworthiness & financial correctness** (integer-kobo ledger, transactional mutations, immutable audit history).
2. **Clarity** for the proprietor ("where is my money?" answered within seconds), for the finance officer ("what do I record/reconcile/follow up?"), and for the parent ("how much do I owe and how do I pay?").
3. **Operational usefulness** for daily finance work in real Nigerian schools.
4. **Tenant isolation** at database, API, business-logic, and UI layers.
5. **Lean operation** (low operational overhead, inexpensive for pilot) — without compromising correctness.
6. **Scalability path** from 1 school → 10 → 100 → 1000 without rewrite.

The goal is NOT to be the most technically complicated school-fee product. It is to be the most TRUSTWORTHY, CLEAR, OPERATIONALLY USEFUL, and FINANCIALLY CORRECT one.

## B. Founder Mandates Reflected In This Revision

This architecture reflects 17 founder corrections applied on 2026-09-15:
1. **Stack versioning** — framework versions are not hard-coded; we select current stable production versions at scaffolding time and record them.
2. **GitHub is a pre-code hard gate** — D2 must be verified complete (repo created, remote configured, docs pushed, remote verified, `main` branch established) before any application code.
3. **Founder ownership** — all critical infrastructure (GitHub, domain, Vercel, Supabase, Paystack, Resend, monitoring, messaging) is founder/company-owned. Arena is an engineering environment only.
4. **Domain architecture** — public: `scolaira.com`; application: `app.scolaira.com`; parent: `app.scolaira.com/pay/:token` initially (future `pay.scolaira.com`); platform admin: isolated `/admin` in pilot, future `admin.scolaira.com`.
5. **Brand system** — do not invent a new visual identity; use documented brand direction; design tokens are centralized so palette can be adjusted without rewriting components.
6. **Pilot school** — important but not a blocker for foundational engineering; we build on documented domain assumptions and mark assumptions explicitly; pilot school then validates/refines.
7. **Data residency/privacy** — a specific decision document required before production student data; selecting a region is not compliance.
8. **Real-world financial workflow discovery plan** — required before finalizing reconciliation.
9. **Domain state machines** — explicitly defined for all core entities before scaffolding.
10. **Financial ledger vs operational/presentation data** — distinction documented and enforced.
11. **Concurrency design** — concrete transaction behavior specified for 7 named races.
12. **Audit model** — financially-significant events enumerated; each audit record answers who/what/when/to-which-record/before/after/why.
13. **Product discovery backlog** — VALIDATED / ASSUMED / UNKNOWN explicitly separated.
14. **Business model** — use company brief as source of truth; any pricing change goes through decision log; do not invent pricing.
15. **Design system** — create a real SCOLAIRA design system foundation before building many screens.
16. **UX priority** — three journeys in order: (1) Owner Command Center → truth → action; (2) Finance Officer payment → allocation → reconciliation → receipt; (3) Parent view → understand → pay → confirmation.
17. **Implementation gate** — after incorporating changes, STOP again and present revised gate; do not scaffold until approved.

## C. Current State

| Area | Status |
|---|---|
| Repository | Local git at `/home/user/scolaira/`, branch `main`, commits verified (current: updated commit after this revision). |
| Remote (GitHub) | **NOT YET CONFIGURED — HARD GATE (D2).** No application code will be written until remote is configured, initial docs pushed, and remote verified. |
| Application code | None — per pre-code gate. |
| Framework versions | Not pinned yet; will be selected at scaffolding per D1 (corrected). |
| Infrastructure (Vercel/Supabase/Paystack/Resend) | Not provisioned; to be created under founder-owned accounts (D3). |
| Documentation | Complete revised set, including this document. |
| Domain | `scolaira.com` (recommended per D4); DNS not configured. |
| Pilot school | Not yet identified (D7); not blocking foundation engineering. |

## D. Target Architecture (Pilot Phase 1–3)

### D.1 Stack (Founder-Approved)

> Exact versions will be selected at scaffolding time based on current stable, production-supported releases, compatibility and security. They will be recorded in the repository (README + `package.json` lockfile).

| Layer | Choice (architectural) | Notes |
|---|---|---|
| **Frontend framework** | Next.js + TypeScript | App Router pattern preferred; SSR/CSR hybrid; exact Next.js major version chosen at scaffold time. |
| **UI** | Tailwind CSS + shadcn/ui + SCOLAIRA design tokens | Centralized token system (color, typography, spacing, radii, shadows) per D8/D15; no hard-coded palette in components. |
| **Backend** | Next.js Route Handlers + Server Actions (for privileged mutations) + domain service layer | Modular monolith; same language across stack. |
| **Database** | PostgreSQL (Supabase managed) | Production-grade, RLS, backups, PITR. |
| **ORM / Query** | Drizzle ORM | Type-safe, SQL-aligned, explicit migrations, lightweight. |
| **Auth** | Supabase Auth (email/password; 2FA roadmap) | Secure sessions; integrates with RLS. |
| **Online Payments** | Paystack (webhook-driven) | Test mode for development; settlement to school's own account. |
| **Hosting** | Vercel (app) + Supabase (DB/auth) | Zero-ops for pilot; founder-owned accounts. |
| **File Storage** | Supabase Storage (or S3-compatible) | Receipts, CSV imports, exports; server-side validation. |
| **Email** | Resend (transactional) | Receipts, password reset, login alerts; founder-owned account. |
| **Observability** | Vercel logs + Sentry (errors) + Supabase logs + `/health` endpoint | Lean; upgrade post-pilot. |
| **Testing** | Vitest (unit/integration/financial/security) + Playwright (E2E/visual/a11y) | Exact versions selected at scaffold. |

**No microservices. No AI gimmicks. No premature distributed architecture.**

### D.2 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                      │
│  ┌─────────────────────┐   ┌───────────────────────────┐    │
│  │ School Console      │   │ Parent Payment Pages      │    │
│  │ (app.scolaira.com)  │   │ (app.scolaira.com/pay/…)  │    │
│  │ Auth-gated          │   │ No account required       │    │
│  └──────────┬──────────┘   └──────────┬────────────────┘    │
└─────────────┼─────────────────────────┼─────────────────────┘
              │ secure cookie           │ signed URL token
              ▼                         ▼
┌─────────────────────────────────────────────────────────────┐
│            NEXT.JS APPLICATION (Vercel)                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Route Handlers (JSON API) + Server Actions            │   │
│  │  /api/auth, /api/students, /api/billing, /api/payments│   │
│  │  /api/reconciliation, /api/reports, /api/comms        │   │
│  │  /api/admin/* (PLATFORM_ADMIN role-gated, isolated)   │   │
│  └──────────────────────────┬───────────────────────────┘   │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │  Domain Service Layer                                 │   │
│  │  - BillingService, PaymentService, AllocationService  │   │
│  │  - ReconciliationService, ReportingService            │   │
│  │  Enforces invariants; wraps transactions; emits audits│   │
│  └──────────────────────────┬───────────────────────────┘   │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │  Drizzle ORM (transaction-aware)                      │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              │ TLS
                              ▼
┌─────────────────────────────────────────────────────────────┐
│            POSTGRES (Supabase)                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ - Per-tenant RLS (defense-in-depth)                   │   │
│  │ - Authoritative financial tables                      │   │
│  │ - Append-only audit_events                            │   │
│  │ - Idempotency keys                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         ▲                       ▲                         ▲
         │ webhooks              │ uploads                 │ auth
         │                       │                         │
    ┌────┴─────┐           ┌─────┴─────┐            ┌──────┴──────┐
    │ Paystack │           │ Supabase  │            │  Supabase   │
    │          │           │ Storage   │            │    Auth     │
    └──────────┘           └───────────┘            └─────────────┘
```

### D.3 Code Layout (Planned)

```
scolaira/
├── apps/
│   └── web/
│       ├── app/                     # Next.js App Router
│       │   ├── (auth)/              # login, logout, reset
│       │   ├── (school)/            # authenticated school console
│       │   │   ├── command-center/
│       │   │   ├── students/
│       │   │   ├── billing/
│       │   │   ├── invoices/
│       │   │   ├── payments/
│       │   │   ├── reconciliation/
│       │   │   ├── reports/
│       │   │   ├── communication/
│       │   │   └── settings/
│       │   ├── (admin)/             # Platform admin (isolated segment)
│       │   ├── pay/                 # Public parent payment pages
│       │   └── api/                 # Route handlers
│       ├── components/
│       │   └── ui/                  # Design system primitives
│       ├── lib/
│       │   ├── domain/              # Financial domain services
│       │   ├── db/                  # Drizzle schema + migrations
│       │   ├── auth/
│       │   ├── money/               # kobo/naira utilities
│       │   ├── invariants/          # Invariant guards
│       │   ├── idempotency.ts
│       │   ├── audit.ts
│       │   └── validators/          # Zod schemas
│       └── styles/                  # Design tokens (Tailwind config)
├── docs/                            # All documentation
└── ...
```

Single Next.js app at pilot. Monorepo packages only introduced when duplication demands.

### D.4 Key Architectural Principles (Founder-Aligned)

1. **Trust over cleverness.** Financial correctness outranks visual cleverness, speed of shipping, and feature count.
2. **Server-side authority.** Authz and financial decisions happen server-side; UI is never trusted.
3. **Explicit financial truth vs derived/presentation data.** (See /docs/FINANCIAL_TRUTH_MODEL.md.) Dashboard numbers are always read-side derivations from the ledger; they never become a source of truth.
4. **Transaction boundaries.** Every financial mutation runs inside a Postgres transaction.
5. **Idempotency by default.** Mutating endpoints accept idempotency keys; webhooks dedup.
6. **Append-only audit log.** Financial history cannot be silently destroyed; reversals/corrections are explicit.
7. **Defense-in-depth tenant isolation.** App scoping + RLS; never rely on a single layer.
8. **Money is integer kobo.** Arithmetic on kobo; formatted to naira strings only at edges.
9. **Domain services own invariants.** Route handlers validate input and call services; services enforce invariants and emit events. Route handlers never perform financial math directly.
10. **Fail closed.** If invariants cannot be verified, reject. No "best effort" with money.
11. **Explicit state machines.** All core entities have finite, documented state machines (see `/docs/state-machines/`).
12. **Backwards-compatible migrations.** Additive where possible; destructive changes use multi-step migrations.
13. **Centralized design tokens.** Palette, spacing, typography, radii, shadows live in one place; components never hard-code hex values or ad-hoc spacing.
14. **Journey-priority UX.** Design for owner journey first, finance officer second, parent third; everything else supports these.

## E. Domain Model (Revised)

Full schema in `/docs/DATABASE.md`. Core entities grouped by kind:

**Tenant & access:** organizations, users, memberships (with role).
**Academic structure:** sessions, terms, classes, student_class_enrollments.
**People:** students, guardians.
**Billing structure:** fee_definitions, fee_assignments.
**Authoritative financial records (ledger):** invoices, invoice_lines, payments, payment_allocations, receipts, reversals.
**Supporting financial records:** payment_links, communication_events.
**System records:** audit_events, idempotency_keys, webhook_events, subscriptions, onboarding_state.

For every core entity, explicit lifecycle state machines are defined in `/docs/state-machines/`. See §F.

## F. State Machines

Per founder item 9, each of the following has a full state machine defined in `/docs/state-machines/`:

- Student (ACTIVE / ARCHIVED / WITHDRAWN)
- Invoice (DRAFT / ISSUED / PARTIALLY_PAID / PAID / VOID)
- Payment (PENDING / CONFIRMED / DUPLICATE_SUSPECT / REVERSED / REFUNDED / FAILED)
- Payment Allocation (ACTIVE / REVERSED)
- Receipt (ISSUED / VOID)
- Reversal (RECORDED — effectively append-only)
- Refund (RECORDED — append-only, modeled as reversal with type=REFUND)
- Payment Link (ACTIVE / PAID / EXPIRED / REVOKED)
- Communication (PENDING / SENT / DELIVERED / FAILED)
- Term (PLANNED / ACTIVE / CLOSED)
- Fee Assignment (DRAFT / ACTIVE / ARCHIVED)

Each state machine document specifies: valid states, allowed transitions, who may trigger each, DB changes, audit event, and failure behavior.

## G. Financial Truth Model (Authoritative vs Derived)

Per founder item 10, documented in `/docs/FINANCIAL_TRUTH_MODEL.md`. Summary:

**AUTHORITATIVE FINANCIAL TRUTH (the ledger):**
- invoices + invoice_lines
- payments
- payment_allocations
- reversals
- receipts (as issued evidence; derived from allocations/payments but never back-influences them)

**DERIVED / OPERATIONAL / PRESENTATION:**
- Outstanding balances (computed: total − paid + reversals)
- Collection rate (computed)
- Overdue status (computed from due_date + outstanding)
- Dashboard KPIs (computed)
- Reports (computed)
- Priority scores (computed, deterministic)
- "Collection velocity" trends (computed from timestamps)
- Command Center action feed (computed)
- Payment link state is authoritative for link lifecycle but is not the source of payment truth (the payment record is)

**Rule:** Derived values may be cached in materialized views for performance, but they can ALWAYS be recomputed from authoritative tables; they are never manually mutated; any discrepancy is resolved in favor of the ledger.

## H. Financial Invariants

See `/docs/FINANCIAL_INVARIANTS.md`. 15 invariants (F1–F15) unchanged in principle, with added concurrency behavior (§J below) and clarified ledger boundaries (§G).

## I. Concurrency Design (Per Founder Item 11)

Concrete transaction behavior for the 7 specified race cases is documented in `/docs/CONCURRENCY_DESIGN.md`.

Summary:
- Pessimistic locking (`SELECT … FOR UPDATE`) on payment and invoice rows during allocation.
- Unique constraints on idempotency keys, webhook event IDs, and external references.
- Strict state-machine transition checks inside every transaction.
- User-initiated retries are protected by client-generated idempotency keys.
- Webhook retries are protected by `(provider, event_id)` unique key.
- Refund/success out-of-order cases route to review queue rather than silent application.

## J. Audit Model

Defined in `/docs/AUDIT_MODEL.md`. A financially-significant event is any event that affects: who owes what, who paid what, where money is allocated, or who can perform those actions. The 15 event classes enumerated by the founder are all included, with full WHO/DID WHAT/WHEN/TO WHICH RECORD/BEFORE/AFTER/WHY shape.

The `audit_events` table is append-only; the application DB role has INSERT-only (no UPDATE/DELETE). Platform admins cannot delete audit entries.

## K. Security Model

See `/docs/SECURITY.md`. Unchanged in structure; updated to reflect:
- Separate platform admin surface (`admin.scolaira.com` future; `/admin` on app domain during pilot with strict role gate and isolated middleware).
- Founder-owned infrastructure means credential/ownership is outside the engineering environment; rotation/recovery is founder-controlled.
- Data residency decision is deferred to a specific document (see `/docs/DATA_RESIDENCY_AND_PRIVACY.md`) required BEFORE production student data is introduced.

## L. Role / Permission Matrix

See `/docs/SECURITY.md` §III.2. OWNER / SCHOOL_ADMIN / FINANCE_OFFICER / STAFF / PLATFORM_ADMIN matrix preserved. Platform admin actions are purpose-specific and audited.

## M. Product Information Architecture (Revised — Journey-Prioritized)

Per founder item 16, the IA supports three journeys in priority order.

**Journey 1 — Owner (Command Center → truth → action):**
`COMMAND CENTER` (home) · REPORTS · INVOICES · PAYMENTS · RECONCILIATION · STUDENTS · AUDIT HISTORY · SETTINGS.

**Journey 2 — Finance Officer (payment → allocation → reconciliation → receipt):**
`PAYMENTS` (record/manage) · `RECONCILIATION` (queue) · `INVOICES` · `RECEIPTS` · `STUDENTS` · `BILLING` · `FEE CATALOG` · `TERMS`.

**Journey 3 — Parent (view → understand → pay → confirm):**
Single page at `/pay/:token` — school identity, student, itemized balance, payment options, confirmation, receipt.

Modules not on these critical paths (Staff/Permissions, Comm setup, etc.) are available but not primary navigation in pilot.

Sidebar adapts to role; owner sees audit/reports more prominently; finance officer sees payments/reconciliation at the top.

## N. UX Strategy & Design System

See `/docs/UX_PRINCIPLES.md` and `/docs/design-system/DESIGN_SYSTEM_PLAN.md`.

- **Palette tokens** (semantic, not hard-coded hex in components):
  - Brand direction tokens: `--color-forest`, `--color-gold`, `--color-ivory`, `--color-ink`, `--color-white`.
  - Brand references provided by founder are the starting point:
    - `#1B4332` (deep forest reference) and `#0B3D2E` (refined deep emerald).
    - `#D4AF37` (rich gold reference) and `#C9A227` (refined gold).
    - `#FDFBF6` (warm ivory) and `#FFFFFF` (white).
    - `#17201C` (near-black).
  - Final palette is NOT hard-coded yet. Tokens will be refined via the design system process (§D15) and reviewed against real screens.
- **Typography:** Inter (default), tabular-nums for money; scale and weights defined in design tokens.
- **Spacing:** 4px grid scale defined in tokens.
- **Semantic colors:** success / warning / danger / info mapped via tokens.
- **Borders/radii/shadows:** tokenized; tight shadows, restrained radii (≤8px).
- **Components:** button, input, select, table, badge, status chip, dialog, drawer, nav, empty/loading/error states, confirmation patterns — all built from tokens before screens are built.
- **Financial number formatting** is a single utility used by every screen and component; never ad-hoc formatting.

## O. Data Strategy (Revised)

- PostgreSQL (Supabase). All authoritative financial tables have `organization_id NOT NULL` + FK + RLS.
- Money: BIGINT kobo; naira strings only at API edge.
- Timestamps: TIMESTAMPTZ; display timezone Africa/Lagos.
- Reports/Command Center derive from ledger; materialized views are allowed only as performance caches that can be fully recomputed; they carry `as_of` timestamp.
- CSV import is a risk boundary: strict server-side validation, dry-run preview, no silent bad writes.
- **Data residency:** Selected region documented in `/docs/DATA_RESIDENCY_AND_PRIVACY.md` BEFORE production data. Founder must review and approve.

## P. Real-World Financial Workflow Discovery Plan

Per founder item 8, documented in `/docs/discovery/REAL_WORLD_DISCOVERY_PLAN.md`. Covers all required workflow investigations: cash, bank transfers, POS, online, one-payment-multiple-students (siblings), multi-invoice payments, prior-term debt, over/under payments, wrong-account, unidentified, duplicates, refunds, reversals, discounts, scholarships, waivers, manual receipts, bank-statement reconciliation, finance-officer workflow, proprietor review.

Reconciliation is NOT finalized until discovery is completed with at least one real school finance officer. Phase 3 (Reconciliation flagship) build will incorporate findings. Phase 1 (Financial Truth) is built from domain truths that are unlikely to change (money in = recorded, allocation can't exceed outstanding, etc.) and uses the manual-reconciliation path so finance officers can always correct.

## Q. Testing Strategy (Revised)

See `/docs/TESTING.md`. Summary unchanged in structure; now also includes:
- Explicit concurrency tests for each of the 7 named cases (A–G).
- Tests for every state-machine transition (valid + invalid).
- Tests verifying that derived/presentation views always match authoritative ledger (invariant F14 expanded).
- The 32-case financial matrix and 15-case security matrix remain required.

## R. Deployment Strategy (Revised per D4)

- **Public marketing (future):** `scolaira.com`.
- **Application:** `app.scolaira.com` (school console) once domain is provisioned; during pilot pre-domain, Vercel preview URLs are fine.
- **Parent payment pages:** `app.scolaira.com/pay/:token` initially. Architecture must make migration to `pay.scolaira.com` straightforward (token resolution is server-side; no hard-coded origin dependencies in payment logic).
- **Platform admin:** isolated `/admin` route under `app.scolaira.com` during pilot, gated by PLATFORM_ADMIN middleware; migrate to `admin.scolaira.com` when needed (cookie scoping designed to allow this without breaking sessions).
- Migrations, environments, CI/CD, rollback, backups unchanged in principle (see `/docs/DEPLOYMENT.md`, `/docs/DISASTER_RECOVERY.md`).

## S. Product Discovery Backlog

Per founder item 13, documented in `/docs/discovery/PRODUCT_DISCOVERY_BACKLOG.md`. Items are categorized as VALIDATED, ASSUMED, or UNKNOWN. UNKNOWN items are not allowed to silently shape architecture — they are marked as requiring discovery.

## T. Product Roadmap (Revised)

Phasing unchanged (10 phases). Phase 0 now includes the new pre-code gates (GitHub remote verified, design system foundation, data residency decision begun). Phase 3 (Reconciliation) is preceded by the Real-World Discovery Plan; findings from the pilot school feed into Reconciliation build.

## U. Business Model

Source of truth is the company brief. Pricing is NOT invented here. The schema includes an `organizations.plan` field for future use; billing integration is deferred to Phase 9. Any pricing reconsideration goes through `/docs/DECISIONS.md`, never silently.

## V. Observability

See `/docs/OPERATIONS.md`. Principle unchanged: lean for pilot, rigorous about financial-invariant alerts and audit.

## W. Backup & Disaster Recovery

See `/docs/DISASTER_RECOVERY.md`. Backups (Supabase PITR + daily + weekly off-site), restore testing cadence, and incident response unchanged. Backup location is documented as part of the Data Residency decision (§O).

## X. Business Risks (Top, Revised)

See `/docs/RISK_REGISTER.md` for full updated register. Key changes:
- Added R-021 **Building reconciliation around unvalidated assumptions** (P1) — mitigated by Real-World Discovery Plan and manual-reconciliation-first Phase 1.
- Added R-022 **Pre-code GitHub/ownership not established** (P0) — mitigated by D2 hard gate.
- Added R-023 **Design drift from hard-coded colors/spacing** (P2) — mitigated by design tokens.
- Added R-024 **Legal/NDPR sign-off before real data** (P1 before go-live) — mitigated by Data Residency & Privacy decision document and legal review.

## Y. Technical Risks

- Same set as before. Added:
  - Framework version drift: mitigate by pinning exact versions at scaffold in `package-lock.json`, dependabot PRs reviewed, CI green before update.
  - Payment-origin hard-coding: mitigate by using single canonical URL helper; env-driven canonical origins.

## Z. Implementation Gate (Pre-Code Checklist)

Per founder item 17 and I (Implementation Sequence):

**Before ANY application code, ALL of these must be true:**
1. Founder creates a private GitHub repository under company ownership (D2).
2. Founder provides a method for engineering to push (PAT or via pairing); initial documentation commit is pushed.
3. Remote repository verified: `git ls-remote` succeeds; GitHub shows the README and docs.
4. Default branch is `main`.
5. Branch protection on `main`: PR required, status checks pass before merge (status checks added once CI is set).
6. All revised documentation (this set) is committed and pushed.
7. Stack versions selected at scaffold time and recorded.
8. Founder-owned accounts created (or committed-to timeline) for: Vercel, Supabase, Paystack (test), Resend.
9. Domain `scolaira.com` status confirmed (registered/in-progress; not blocking scaffolding if in progress, but blocking production).
10. The Data Residency & Privacy decision document is drafted (final legal review can come later, but region selection is made before storing real student data).
11. Design system foundation (tokens + core primitives) is implemented BEFORE building screen after screen.
12. Real-World Financial Workflow Discovery Plan interviews scheduled (at minimum one school) before Phase 3 begins; Phase 1 can proceed with manual reconciliation.

## AA. Implementation Sequence (After Gate Approval)

After approval of this revised gate, the first engineering milestone is vertical-slice scaffolding in this order:

1. **Scaffold M0 — Project skeleton:** Next.js app, TypeScript, Tailwind, Drizzle, ESLint, Vitest, Playwright, CI (GitHub Actions running lint/typecheck/unit). **PUSH + VERIFY REMOTE.**
2. **Scaffold M1 — Design system foundation:** Typography scale, spacing scale, color tokens, semantic colors, borders/radii/shadows tokens, and core primitives (button, input, badge, status chip, dialog, drawer, table, empty/loading/error states, financial number formatter). Visual review. **PUSH + VERIFY REMOTE.**
3. **Scaffold M2 — Database + migrations:** Initial schema migration (organizations, users, memberships, sessions, terms, classes) applied to local Postgres. Drizzle client wired. **PUSH + VERIFY REMOTE.**
4. **Scaffold M3 — Auth:** Supabase Auth integrated (email/password), session handling, login page, logout, password reset, protected routes, role middleware. **PUSH + VERIFY REMOTE.**
5. **Scaffold M4 — Tenant context:** Organization selection/membership enforcement, app scoping, RLS enabled in Postgres policies. Tests: cross-tenant access is blocked. **PUSH + VERIFY REMOTE.**
6. **Slice 1 — Org onboarding:** Create organization, session, term, class setup.
7. **Slice 2 — Students + guardians** (manual CRUD; CSV import deferred to Phase 2).
8. **Slice 3 — Fee catalog + fee assignments.**
9. **Slice 4 — Billing: preview → run (DRAFT) → issue.**
10. **Slice 5 — Record payment (cash/transfer/POS) + auto-allocation + receipt print view.** Manual reconciliation (simple TO CONFIRM / TO ALLOCATE list).
11. **Slice 6 — Basic Command Center v1** (BILLED / COLLECTED / OUTSTANDING for current term — derived from ledger).
12. **Slice 7 — Audit log viewer** for OWNER.
13. **Test & Security gates:** Run full financial matrix (as applicable to implemented features), cross-tenant tests, and authorization tests.
14. **Visual inspection** of rendered screens against design system.
15. **Staging deploy + smoke tests** once Vercel/Supabase are provisioned.

Each slice: designed → implemented → tested → security-reviewed → visually-inspected → documented → committed → pushed → remote-verified.

## BB. Decisions Requiring Founder Approval (Revised)

The original D1–D15 with founder corrections incorporated and now presented as updated decisions in `/docs/DECISIONS.md`. Decisions that remain open for your sign-off at this revised gate are listed in §DD of this review's companion (the Executive Summary section of the STOP ONCE MORE presentation).

---

*This document supersedes the v1 architecture on the points addressed by founder corrections. Unchanged principles (invariants, kobo money, defense-in-depth, etc.) remain as specified in v1 and in their respective documents.*
