# SCOLAIRA — Architecture

> Build today's product such that tomorrow's platform remains possible.

---

## A. Executive Summary

SCOLAIRA is a multi-tenant financial SaaS for proprietor-owned Nigerian private schools. It owns the fee financial chain — bill → collect → allocate → reconcile → report — across every payment method a school uses (cash, transfer, POS, online).

The architecture must deliver:
- **Financial correctness** above all else (integer-kobo ledger, transactional mutations, immutable audit history).
- **Tenant isolation** at database, API, business-logic, and UI layers.
- **Operational simplicity** for a pilot-stage startup (lean stack, low operational overhead, inexpensive to run).
- **Scalability path** from 1 school → 10 → 100 → 1000 without rewrite.

## B. Why It Matters

A school collecting ₦60M+ per term depends on this system for financial truth. A single invariant violation (silent over-allocation, cross-tenant leak, lost payment) destroys trust irreparably. The architecture exists to protect that trust first, deliver a premium experience second, and minimize cost/complexity third.

## C. Current State (First-Session Assessment)

| Area | Status |
|---|---|
| Repository | Initialized locally; **no remote configured yet** (DECISION REQUIRED — see §T) |
| Application code | None — greenfield |
| Framework | Not selected — RECOMMENDATION below |
| Database | Not provisioned |
| Auth | Not implemented |
| CI/CD | None |
| Hosting | Not provisioned |
| Secrets | None configured |
| Backups | None |
| Monitoring | None |
| Documentation | This document set |

## D. Target Architecture (Pilot Phase, Phase 1–3)

### D.1 Stack Recommendation

> **DECISION REQUIRED:** Approve or adjust the following stack before coding begins.

| Layer | Choice | Rationale |
|---|---|---|
| **Frontend framework** | Next.js 14+ (App Router, TypeScript) | React ecosystem, SSR/SSG for payment pages, strong Vercel/supabase integration, fast onboarding, file-based routing reduces boilerplate. Pilot-appropriate. |
| **UI** | Tailwind CSS + shadcn/ui + custom design tokens | Private-bank aesthetic: emerald/gold/white/near-black. Premium feel without custom component library overhead. |
| **Backend** | Next.js Route Handlers (API) + Server Actions (for privileged mutations) + a thin service layer | Keeps the pilot monolithic; same language (TS) across stack; easy to extract later if needed. Avoid premature microservices. |
| **Database** | PostgreSQL (Supabase managed) | Production-grade, row-level security (RLS) for defense-in-depth tenant isolation, built-in auth option, backups, point-in-time recovery, affordable. Migration-safe path from local Postgres to Supabase. |
| **ORM / Query** | Drizzle ORM | Type-safe, SQL-aligned, supports migrations well, lightweight, explicit transactions. Avoids Prisma's N+1 and opaque magic; suitable for financial code. |
| **Auth** | Supabase Auth (email/password, secure sessions, future 2FA) | Comes with Supabase; supports RLS integration; secure defaults; reduces custom auth surface area. Platform-admin login uses separate route with elevated role checks. |
| **Payments (online)** | Paystack integration (webhook-driven) | Dominant Nigerian processor; webhook idempotency is the hard part — documented below. |
| **Sms/WhatsApp** | Termly/Twilio/MSG91 — DEFER integration provider selection to Phase 7 | Do not bind early; design communication module as channel-agnostic. |
| **Hosting** | Vercel (app) + Supabase (DB/auth) | Zero-ops for pilot; both have Nigerian-developer familiarity; auto-preview environments; cost scales from free/cheap. Migrate off if cost/control demands. |
| **File storage** | Supabase Storage (or S3-compatible) | For CSV imports, receipts, exports. Server-side validation on all uploads. |
| **Email** | Resend or Postmark (transactional only) | Receipts, password reset, login alerts. No marketing email at pilot. |
| **Observability** | Vercel logs + Sentry (errors) + Supabase logs + simple /health endpoint | Keep it lean; add proper metrics platform after pilot signals. |

**Monolith, modular monolith, then services (if ever).** The codebase is organized into domain modules so that future extraction is possible without rewrite. Do NOT start with microservices.

### D.2 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
│  ┌────────────────────┐   ┌─────────────────────┐               │
│  │  School Web App    │   │ Parent Payment Page  │               │
│  │  (Next.js SSR/CSR) │   │ (Mobile-first, no    │               │
│  │  Auth-gated        │   │  login required)     │               │
│  └─────────┬──────────┘   └──────────┬──────────┘               │
└────────────┼─────────────────────────┼──────────────────────────┘
             │ session cookie          │ signed token in URL
             ▼                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NEXT.JS APPLICATION (Vercel)                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Route Handlers (REST-like JSON API)                     │   │
│  │  ── auth ── students ── billing ── payments ── invoices ──│   │
│  │  ── reconciliation ── reports ── communication ── admin ──│   │
│  └─────────────────────────┬────────────────────────────────┘   │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  Domain Service Layer (TS)                               │   │
│  │  BillingService, PaymentService, AllocationService,      │   │
│  │  ReconciliationService, ReportingService, etc.           │   │
│  │  - enforces invariants                                   │   │
│  │  - wraps DB transactions                                 │   │
│  │  - emits audit events                                    │   │
│  └─────────────────────────┬────────────────────────────────┘   │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  Drizzle ORM / Postgres client (transaction-aware)       │   │
│  └─────────────────────────┬────────────────────────────────┘   │
└────────────────────────────┼────────────────────────────────────┘
                             │ TLS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│            POSTGRES (Supabase) — single database                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Per-tenant RLS policies (defense-in-depth)              │   │
│  │  Financial tables: invoices, payments, allocations,      │   │
│  │  reversals, receipts, fee_definitions, etc.              │   │
│  │  Audit events (append-only)                              │   │
│  │  Idempotency keys                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ▲                       ▲                         ▲
         │ webhooks              │ CSV import uploads      │ auth
         │                       │                         │
    ┌────┴─────┐            ┌────┴────┐              ┌─────┴─────┐
    │ Paystack │            │ Storage │              │  Supabase  │
    │          │            │ (S3)    │              │   Auth     │
    └──────────┘            └─────────┘              └───────────┘
```

### D.3 Code Layout (Planned)

```
scolaira/
├── apps/
│   └── web/                       # Next.js application
│       ├── app/                   # App Router (pages, API routes)
│       │   ├── (auth)/            # login, logout, password reset
│       │   ├── (school)/          # authenticated school UI
│       │   │   ├── command-center/
│       │   │   ├── students/
│       │   │   ├── billing/
│       │   │   ├── invoices/
│       │   │   ├── payments/
│       │   │   ├── reconciliation/
│       │   │   ├── reports/
│       │   │   ├── communication/
│       │   │   ├── settings/
│       │   │   └── ...
│       │   ├── (admin)/           # platform admin
│       │   ├── pay/               # parent payment pages (public)
│       │   └── api/               # route handlers
│       ├── components/
│       ├── lib/
│       │   ├── domain/            # domain services (financial logic)
│       │   │   ├── billing.ts
│       │   │   ├── payments.ts
│       │   │   ├── allocations.ts
│       │   │   ├── reconciliation.ts
│       │   │   └── reporting.ts
│       │   ├── db/                # Drizzle schema + client
│       │   │   ├── schema/
│       │   │   ├── migrations/
│       │   │   └── index.ts
│       │   ├── auth/              # auth helpers, RLS helpers
│       │   ├── money/             # kobo/naira utilities
│       │   ├── invariants/        # financial invariant guards
│       │   ├── idempotency.ts
│       │   ├── audit.ts
│       │   └── validators/        # Zod schemas
│       └── ...
├── packages/
│   └── scolaira-types/            # shared types (if needed later)
├── docs/                          # this documentation set
└── ...
```

> **Note:** Start with a single `apps/web` Next.js project. Introduce `packages/` only when code duplication demands it. Avoid pre-emptory monorepo complexity.

### D.4 Key Architectural Principles

1. **Server-side authority.** Every authorization and financial decision happens server-side. The UI is never trusted.
2. **Transaction boundaries.** Every financial mutation is wrapped in a Postgres transaction. A payment is never half-recorded.
3. **Idempotency.** Every mutating endpoint accepts an idempotency key; webhooks are deduplicated.
4. **Append-only audit log.** Financial history cannot be silently destroyed; reversals and corrections are separate records.
5. **Defense-in-depth tenant isolation:** application-level check + Postgres RLS policies. No single layer is the sole protection.
6. **Money is integer kobo.** All arithmetic on kobo; formatted to naira strings only at edges.
7. **Domain services own invariants.** Route handlers validate input and call services; services enforce invariants and emit events. Route handlers never perform financial math directly.
8. **Fail closed.** If invariants cannot be verified, the mutation is rejected; never "best effort" with money.
9. **Explicit states.** Invoices, payments, allocations, links all have finite, documented state machines.
10. **Backwards-compatible migrations.** Database migrations are additive where possible; destructive changes require explicit multi-step migrations.

## E. Domain Model

See `/docs/DATABASE.md` for full schema. Core entities:

- **Organization** (the school tenant)
- **User** (login identity) + **Membership** (user-to-organization with role)
- **Student** (ACTIVE / ARCHIVED / WITHDRAWN)
- **Guardian** (contact info; guardians do not log into school console)
- **Class** (e.g. "JSS 2A")
- **Session** (academic year, e.g. "2025/2026")
- **Term** (e.g. "First Term", belongs to session)
- **FeeDefinition** (catalog entry: "Tuition", "Uniforms", etc.)
- **FeeAssignment** (instance of a fee for a given class/term, with amount)
- **Invoice** (bill to a student for a term; sum of InvoiceLines)
- **InvoiceLine** (one line on an invoice, points to FeeAssignment)
- **Payment** (money received; method, amount, date, reference, state)
- **PaymentAllocation** (portion of a Payment applied to one Invoice)
- **Receipt** (issued per successful allocation)
- **Reversal / Refund** (explicit correction events)
- **PaymentLink** (shareable link for an obligation; states: ACTIVE / EXPIRED / REVOKED / PAID)
- **CommunicationEvent** (SMS/WhatsApp/email/print — audited)
- **AuditEvent** (append-only log of all mutations)
- **IdempotencyKey** (deduplication table)

## F. Financial Invariants

See `/docs/FINANCIAL_INVARIANTS.md` for the full invariant catalog and enforcement strategy. Summary:

1. Invoice totals = sum of valid invoice lines.
2. Payment amounts are positive; reversals/refunds are explicit, separate records.
3. Σ(allocations for a payment) ≤ payment.amount.
4. Σ(allocations to an invoice) ≤ invoice.outstanding.
5. A confirmed payment never silently disappears.
6. Reversals preserve historical truth.
7. Refunded/reversed payments do not contribute to collected totals.
8. Duplicate payment references are handled safely.
9. Webhooks are idempotent; out-of-order events do not corrupt balances.
10. Every financial mutation belongs to exactly one organization.
11. Financial history remains auditable.
12. Previous-term balances are distinguishable from current-term obligations.
13. Reports derive from authoritative financial data, not duplicated dashboard state.
14. The system never manufactures a financial result because the UI expects one.

## G. Security Model

See `/docs/SECURITY.md`. Summary:

- **Authentication:** Supabase Auth (email/password), secure HTTP-only cookies, session expiry, password reset with single-use tokens. 2FA on roadmap.
- **Authorization:** Role-based (OWNER / SCHOOL ADMIN / FINANCE OFFICER / STAFF), with per-action permission matrix enforced server-side. Platform-admin surface at `/admin` is separate and audited.
- **Tenant isolation:** Every query scoped by `organization_id`; Postgres RLS as defense-in-depth; cross-tenant access tested.
- **CSRF:** SameSite cookies + CSRF tokens for state-changing requests.
- **Rate limiting:** Per-IP and per-account on auth and public endpoints.
- **Input validation:** Zod schemas on every endpoint; parameterized queries via Drizzle.
- **Webhooks:** HMAC signature verification, idempotency keys, timestamp replay windows.
- **Secrets:** Environment variables, never in code or logs.
- **Privacy:** NDPR-aligned handling of student/guardian PII; minimal collection.

## H. Role / Permission Matrix

See §I of the executive review below and `/docs/SECURITY.md` for the full matrix.

## I. Product Information Architecture

**Sidebar (school console, role-aware):**

```
COMMAND CENTER
STUDENTS
FEE CATALOG
BILLING
INVOICES
PAYMENTS
RECEIPTS
RECONCILIATION            ← flagship
COMMUNICATION
REPORTS
TERMS & SESSIONS
STAFF & PERMISSIONS
SETTINGS
AUDIT HISTORY
```

**Platform admin (`/admin`):**

```
SCHOOLS
SUBSCRIPTIONS
ONBOARDING STATUS
SUPPORT
SYSTEM HEALTH
PLATFORM METRICS
AUDIT
```

**Parent payment page (`/pay/[token]`):** Single transactional page — balance, itemization, payment methods, confirmation. No sidebar, no account.

## J. UX Strategy

See `/docs/UX_PRINCIPLES.md`. Summary:

- **Benchmark:** Private bank × distinguished school × modern financial software.
- **Palette:** Deep emerald green, rich gold (accent only), white, near-black.
- **Tone:** Authoritative, calm, premium, precise, trustworthy, Nigerian, mature.
- **Typography:** Highly legible, professional, appropriately dense, mobile-friendly.
- **Financial screens:** AMOUNT → STATUS → WHO → WHAT → WHEN → WHY → NEXT ACTION, discoverable at a glance.
- **Copy:** Facts and actions. No startup fluff.
- **Accessibility:** WCAG 2.1 AA — keyboard nav, focus states, contrast, semantic markup, labels, form errors, touch targets, screen-reader support.
- **Responsive:** Desktop/laptop/tablet/cheap Android/narrow mobile. Parent pages mobile-first.

## K. Data Strategy

- Single PostgreSQL database (Supabase) with all tenants.
- All financial tables have `organization_id NOT NULL` and RLS enabled.
- Money stored as integer kobo (`BIGINT`). Naira strings at API boundary.
- All timestamps `timestamptz`. Naira currency; Nigerian timezone (`Africa/Lagos`) for display.
- Reports are **computed** from financial tables; no cached denormalized "dashboard state" that drifts.
- CSV import is a risk boundary: server-side validation, dry-run preview, error reporting, no silent bad-data writes.
- Backups: Supabase automated + point-in-time recovery + weekly manual off-site export; restore drills documented.

## L. Testing Strategy

See `/docs/TESTING.md`. Summary:

- **Unit:** Vitest — money, invariants, allocators, state machines, validators.
- **Integration / API:** Vitest + test Postgres (or Supabase local) — endpoint contracts, authorization, transactions.
- **Financial test matrix (MANDATORY before pilot):** cash, transfer, POS, online; partial + multiple payments; multiple invoices; previous-term debt; exact/under/over payment; duplicate references; duplicate webhooks; reversed/refunded; late webhooks; failed payments; unmatched payments; manual and automatic allocation; allocation correction; unauthorized reversal; cross-tenant access; report consistency; concurrent payment recording.
- **Security test matrix:** cross-tenant access, privilege escalation, IDOR, CSRF, webhook forgery/replay, malicious imports, XSS, injection, secret exposure, rate abuse, unauthorized exports.
- **E2E:** Playwright — critical happy paths (login → bill → record payment → reconcile → view report) + parent payment flow.
- **Visual / UX:** Storybook for core components; screenshot-based review on key screens; real-device mobile checks.
- **Accessibility:** axe-core in E2E; manual keyboard/focus testing.
- **CI:** All tests run on push; no deploy on red.

## M. Deployment Strategy

See `/docs/DEPLOYMENT.md`. Summary:

- **Pilot environment:** Vercel (app) + Supabase cloud (DB). Preview deployments per PR.
- **Environments:** `local` → `preview` (PR) → `staging` → `production`.
- **Migrations:** Drizzle migrations applied via CI/CD on deploy to staging/prod; never manual in prod.
- **Environment variables:** Managed per environment; secrets never in repo.
- **Domain:** `app.scolaira.app` (school), `scolaira.app/pay/...` or `pay.scolaira.app` (parents), `admin.scolaira.app` or `/admin` (platform). **EXACT DOMAIN DECISION REQUIRED.**
- **SSL:** Automatic via Vercel + Supabase.

## N. Backup & Disaster Recovery

See `/docs/DISASTER_RECOVERY.md`. Summary:

- Automated daily Supabase backups + PITR (point-in-time recovery) enabled.
- Weekly encrypted logical backup to separate cloud storage.
- Documented restore procedure; quarterly restore test.
- Rollback strategy: database migrations are reversible where possible; app deploy uses Vercel instant rollback.
- RPO ≤ 1 hour, RTO ≤ 4 hours (pilot targets).

## O. Observability

See `/docs/OPERATIONS.md`. Summary:

- Structured JSON logs (Vercel + Sentry for errors).
- `/api/health` endpoint: app + DB connectivity + basic latency.
- Audit log table (in-app) for every financial mutation.
- Webhook monitoring: success/failure counts, dead-letter visibility.
- Backup monitoring: alert on failed backups.
- Sensitive data (PII, auth tokens, full card/account numbers) never logged.
- Financial anomaly signals (e.g., negative balance, duplicate high-value reference) flagged in app for human review.

## P. Product Roadmap

See `/docs/PRODUCT_ROADMAP.md`. Phased per §14 above; Phase 1 (Financial Truth) is the only phase in active build now.

## Q. Business Risks

See `/docs/RISK_REGISTER.md`. Top items:

1. Trust failure from any financial invariant breach. **P0.**
2. Payment-provider (Paystack) webhook reliability/mis-handling causing balance errors. **P0.**
3. Tenant data leakage. **P0.**
4. Low proprietor/finance-officer digital literacy → onboarding failure. **P1.**
5. Cash/transfer reconciliation workflow not matching real school practice. **P1.**
6. Pricing misalignment with term-based Nigerian school economics. **P1** (business).
7. Parent/school mistrust of digital financial systems. **P1.**
8. Weak network conditions at schools breaking usability. **P1.**
9. NDPR non-compliance exposure. **P2** (needs early planning).

## R. Technical Risks

1. Over-engineering: building services, AI, infra before Phase 1 correctness. Mitigation: stack is deliberately lean; monolith first.
2. Floating-point money bugs. Mitigation: integer kobo everywhere; lint rule forbidding number on money fields; targeted tests.
3. RLS bugs as sole tenant-isolation mechanism. Mitigation: defense-in-depth with application-level scoping + RLS; cross-tenant test matrix.
4. Migration drift (prototyping on SQLite, migrating to Postgres). Mitigation: Drizzle with Postgres from the start; no SQLite-specific logic.
5. Webhook duplication / out-of-order delivery. Mitigation: idempotency table + deterministic state machine + tests.
6. CSV import as attack/data-poisoning vector. Mitigation: strict schema validation, row-level errors, dry-run preview, size limits.
7. Vercel/Supabase lock-in. Mitigation: framework is standard Next.js/Postgres; migration path documented.
8. Concurrency races (two finance officers recording/allocating simultaneously). Mitigation: transactions + row-level locking where needed + unique constraints + concurrency tests.

## S. Unknowns (Require Discovery / Founder Input)

1. **Remote git host:** GitHub organization/repo name and access? (No GitHub credentials in env.)
2. **Domain name:** Is `scolaira.app` (or similar) secured? What domains/subdomains for school vs parent vs admin?
3. **Pricing/Terms:** The brief says "preserve the business model from the company brief" but the company brief provided is this directive only — no specific price/term numbers. Provide pricing details or mark TBD for pilot.
4. **Paystack account:** Is there a Paystack merchant account available for development/testing, or should we use test-mode keys from a fresh account?
5. **SMS/WhatsApp provider:** Deferred to Phase 7, but note any existing relationship.
6. **Pilot school:** Is the first pilot school identified? Access to a real finance officer for usability testing is critical.
7. **Supabase/Vercel accounts:** Should we create these under a SCOLAIRA-owned account or use founder credentials?
8. **Legal/NDPR:** Is there a privacy policy/terms drafted? Required before onboarding real student data.
9. **Existing data:** Any existing school data/spreadsheets we must import?
10. **Multi-currency:** Only Naira in scope (assumption — confirm).
11. **Support model:** Who supports pilot schools? In-app support widget vs WhatsApp vs phone?
12. **Branding assets:** Logo, exact hex codes for emerald/gold, typography preferences beyond the direction given?

## T. Decisions Requiring Founder Approval

> **STOP GATE.** The following decisions must be approved before Phase 1 coding begins beyond scaffolding.

| # | Decision | Recommendation | Impact if delayed |
|---|---|---|---|
| D1 | **Stack approval** — Next.js + TypeScript + Drizzle + Supabase (Postgres/Auth) + Vercel + Tailwind/shadcn + Paystack | Approve as pilot stack; keeps us lean and correct | Blocks scaffolding |
| D2 | **Git remote** — GitHub org name, repo name (`scolaira/scolaira`?), who owns credentials, branch strategy (`main` vs `master`, PRs vs direct) | `scolaira/scolaira` private repo on GitHub, trunk-based with short-lived PRs to `main` | Blocks pushes / backup per §47 |
| D3 | **Hosting accounts** — Vercel + Supabase under company-owned credentials | Founder to create/own; grant engineering access | Blocks production & staging |
| D4 | **Domain** — Production domain for app, parent pages, admin | `app.scolaira.app` (school), `pay.scolaira.app` (parents), platform admin at `app.scolaira.app/admin` (kept behind role, no separate subdomain to reduce surface) | Blocks deploy config, payment-link URLs, cookie scoping |
| D5 | **Paystack test vs live** — Use Paystack test keys now; confirm production merchant entity | Use Paystack test mode for development; founder provides test keys | Blocks online-payment work |
| D6 | **Pricing** — Confirm pricing model and any integration with billing/plan tables in v1 | Defer full billing integration; include Organization.plan field for future use; pilot schools handled manually | Blocks subscription/onboarding paywalls |
| D7 | **Pilot school** — Confirm identity and expected involvement; access to real finance officer for user testing | Identify one school (150–800 students) willing to co-design; prioritize their workflow | Blocks real-data validation, onboarding design |
| D8 | **Branding assets** — Logo files, exact emerald/gold hex codes, typography choice | Propose interim palette (emerald `#046A38`, gold `#C9A961`, near-black `#0B1F16`) pending brand system | Non-blocking for backend, blocking for production UI polish |
| D9 | **Parent payment page domain** — Subdomain of scolaira.app vs custom per-school vanity | Subdomain of scolaira.app for pilot (cheaper, simpler, safe) | Blocks payment-link URL schema |
| D10 | **Communications provider** — Defer to Phase 7 but confirm no pre-existing commitment | Defer; design CommunicationEvent table to be channel-agnostic | None now |
| D11 | **Email provider** — Resend vs Postmark for transactional (receipts, reset) | Resend (simple API, good DX) | Blocks password reset / receipt email in Phase 1–2 |
| D12 | **Data residency / NDPR** — Confirm Supabase region (recommend `eu-west-1` or `af-south-1` if available; otherwise EU with NDPR DPA) | Supabase region to minimize latency and address NDPR; legal review of DPA | Blocks production provisioning |
| D13 | **Session duration / security policy** — Session length, password rules, rate-limit thresholds | 12-hour session with sliding refresh; 30-day "remember me" opt-in; ≥12 char passwords; rate-limit auth (5/10min lockout) | Blocks auth implementation specifics |
| D14 | **Platform-admin scope** — Who holds platform admin (founder only initially)? Audit retention? | Founder-only initially; audit retained indefinitely; all platform mutations logged | Blocks `/admin` build |
| D15 | **Name/branch default** — Rename default branch `main`? | Rename to `main` now | Trivial; will do on approval |

---

*This document is the architectural source of truth. Changes follow the change-control process in §50 of the company-build directive and must be recorded in /docs/DECISIONS.md.*
