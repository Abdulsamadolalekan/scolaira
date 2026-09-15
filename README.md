# SCOLAIRA

**The Financial Operating System for Nigerian Private Schools.**
Brand promise: *Every term, fully funded.*

> Spelling is sacred: **S-C-O-L-A-I-R-A** (Schola + Naira).

---

## Current Status

**Phase 0 — Foundation & Approval Gate.**

Greenfield repository. All architecture, product, financial, security, and testing documentation is in place. Application scaffolding has not begun, per company-build directive §67/§71 — awaiting founder approval on the decisions below.

## Documentation

| Document | Purpose |
|---|---|
| [docs/SCOLAIRA_SPEC.md](docs/SCOLAIRA_SPEC.md) | Product spec, identity, modules, roles, parent experience, phasing |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Target architecture, stack, domain model, security, deployment, decisions required |
| [docs/FINANCIAL_INVARIANTS.md](docs/FINANCIAL_INVARIANTS.md) | 15 financial invariants, state machines, kobo/naira boundary, allocation rules |
| [docs/DATABASE.md](docs/DATABASE.md) | Postgres schema design, tables, indexes, RLS, migrations |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, auth, RBAC, tenant isolation, webhooks, NDPR posture |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | API endpoint catalogue, error codes, idempotency, conventions |
| [docs/PRODUCT_ROADMAP.md](docs/PRODUCT_ROADMAP.md) | 10-phase roadmap from Financial Truth to Financial Infrastructure |
| [docs/TESTING.md](docs/TESTING.md) | Test pyramid, 32-case financial matrix, 15-case security matrix |
| [docs/UX_PRINCIPLES.md](docs/UX_PRINCIPLES.md) | Visual language, palette, hierarchy, accessibility, mobile strategy |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Environments, observability, alerting, support, cost discipline |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment pipeline, env vars, DNS, rollback, CI/CD |
| [docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md) | RPO/RTO, backup strategy, restore procedures, cadence |
| [docs/DATA_PRIVACY.md](docs/DATA_PRIVACY.md) | NDPR alignment, minimization, retention, sub-processors, breach response |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision record (ADR-style) |
| [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md) | 20 identified risks with priority and mitigations |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Log of assumptions requiring validation |

## Stack (RECOMMENDED, pending D1 approval)

- **Frontend/Backend:** Next.js 14 (App Router, TypeScript)
- **UI:** Tailwind CSS + shadcn/ui + private-bank design tokens
- **Database:** PostgreSQL 15 (Supabase managed)
- **ORM:** Drizzle ORM
- **Auth:** Supabase Auth (email/password, 2FA roadmap)
- **Online Payments:** Paystack (webhook-driven)
- **Hosting:** Vercel (app) + Supabase (DB/Auth/Storage)
- **Email:** Resend (transactional)
- **Monitoring:** Sentry + Vercel logs + health endpoint
- **Testing:** Vitest (unit/integration) + Playwright (E2E/visual/a11y)

## Ten Inviolable Principles

1. **Money correctness outranks visual cleverness.** Integer kobo internally; naira strings externally. No floats.
2. **Payment-method agnosticism is non-negotiable.** Cash, transfer, POS, online are all first-class. The value is the unified record, not the payment link.
3. **Confirmed payments never disappear.** Reversals, corrections, voids — never destructive deletes.
4. **Defense-in-depth tenant isolation.** App scoping + Postgres RLS + tests.
5. **Every financial mutation is audited.** Who, what, when, before/after, reason.
6. **Reports derive from authoritative data.** No cached dashboard state that can drift.
7. **Parents don't need accounts.** Signed, expiring, mobile-first transactional pages.
8. **The proprietor's first question is "where is my money?"** Every screen is judged against this.
9. **Deterministic, explainable intelligence — no fake AI.**
10. **Build lean for pilot, architect for thousands of schools.** No premature microservices, no AI gimmicks, no feature-count vanity.

## What Happens Next

After founder approval on decisions D1–D15 (see [docs/ARCHITECTURE.md §T](docs/ARCHITECTURE.md#t-decisions-requiring-founder-approval)), we proceed to:

1. Configure git remote (D2), push, verify.
2. Provision Supabase + Vercel projects (D3).
3. Scaffold the Next.js app with auth, DB client, design tokens, and CI.
4. Build Phase 1 (Financial Truth) in vertical slices: auth → org/onboarding → students → fee catalog → billing → payments → reconciliation (manual) → command center (v1).

Per §71: **we stop here for approval before coding.**
