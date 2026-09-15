# SCOLAIRA

**The Financial Operating System for Nigerian Private Schools.**
Brand promise: *Every term, fully funded.*

> Spelling is sacred: **S-C-O-L-A-I-R-A** (Schola + Naira).

---

## Current Status

**Phase 0 — Revised Approval Gate (STOP).**

Greenfield repository. No application code yet — per pre-code gate (D2 hard gate, §67/§71, Founder Correction 2). All architecture, product, financial, security, UX, and discovery documentation is complete and revised per founder corrections. Awaiting approval of the revised gate and GitHub remote setup before scaffolding begins.

## Complexity underneath. Clarity on top.

> "I do not want SCOLAIRA to be the most technically complicated school-fee product. I want it to be the most TRUSTWORTHY, CLEAR, OPERATIONALLY USEFUL and FINANCIALLY CORRECT system a Nigerian private-school proprietor can use." — Founder

## Documentation

### Foundation
| Document | Purpose |
|---|---|
| [docs/SCOLAIRA_SPEC.md](docs/SCOLAIRA_SPEC.md) | Product spec, identity, modules, roles, parent experience, phasing |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **Revised v2** — Target architecture, stack, domain, security, deployment, decisions |
| [docs/FINANCIAL_INVARIANTS.md](docs/FINANCIAL_INVARIANTS.md) | 15 financial invariants, state machines, kobo/naira boundary, allocation rules |
| [docs/FINANCIAL_TRUTH_MODEL.md](docs/FINANCIAL_TRUTH_MODEL.md) | **NEW** — Authoritative ledger vs derived/presentation data distinction |
| [docs/DATABASE.md](docs/DATABASE.md) | Postgres schema design, tables, indexes, RLS, migrations |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, auth, RBAC, tenant isolation, webhooks, NDPR posture |
| [docs/AUDIT_MODEL.md](docs/AUDIT_MODEL.md) | **NEW** — Audit event types, record shape, integrity, 7 questions |
| [docs/CONCURRENCY_DESIGN.md](docs/CONCURRENCY_DESIGN.md) | **NEW** — Concrete behavior for 7 race conditions (A–G) |

### Product & Discovery
| Document | Purpose |
|---|---|
| [docs/PRODUCT_ROADMAP.md](docs/PRODUCT_ROADMAP.md) | 10-phase roadmap |
| [docs/discovery/PRODUCT_DISCOVERY_BACKLOG.md](docs/discovery/PRODUCT_DISCOVERY_BACKLOG.md) | **NEW** — VALIDATED / ASSUMED / UNKNOWN items |
| [docs/discovery/REAL_WORLD_DISCOVERY_PLAN.md](docs/discovery/REAL_WORLD_DISCOVERY_PLAN.md) | **NEW** — Finance-workflow discovery before finalizing Reconciliation |
| [docs/UX_PRINCIPLES.md](docs/UX_PRINCIPLES.md) | Visual language, hierarchy, accessibility, mobile |
| [docs/design-system/DESIGN_SYSTEM_PLAN.md](docs/design-system/DESIGN_SYSTEM_PLAN.md) | **NEW** — Tokens, primitives, page templates, process |

### State Machines
See [docs/state-machines/](docs/state-machines/) — **NEW** — Lifecycle for every core entity:
- [STUDENT](docs/state-machines/STUDENT.md)
- [INVOICE](docs/state-machines/INVOICE.md)
- [PAYMENT](docs/state-machines/PAYMENT.md)
- [PAYMENT_ALLOCATION](docs/state-machines/PAYMENT_ALLOCATION.md)
- [RECEIPT](docs/state-machines/RECEIPT.md)
- [REVERSAL_REFUND](docs/state-machines/REVERSAL_REFUND.md)
- [PAYMENT_LINK](docs/state-machines/PAYMENT_LINK.md)
- [COMMUNICATION](docs/state-machines/COMMUNICATION.md)
- [TERM](docs/state-machines/TERM.md)
- [FEE_ASSIGNMENT](docs/state-machines/FEE_ASSIGNMENT.md)

### Delivery
| Document | Purpose |
|---|---|
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | API endpoint catalogue, error codes, idempotency, conventions |
| [docs/TESTING.md](docs/TESTING.md) | Test pyramid, 32-case financial matrix, 15-case security matrix, concurrency cases |
| [docs/IMPLEMENTATION_SEQUENCE.md](docs/IMPLEMENTATION_SEQUENCE.md) | **NEW** — Pre-code checklist + milestone sequence (M0–M4 + Phase 1 slices) |

### Operations & Trust
| Document | Purpose |
|---|---|
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Environments, observability, alerting, support, cost discipline |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment pipeline, env vars, DNS, rollback, CI/CD |
| [docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md) | RPO/RTO, backups, restore procedures, cadence |
| [docs/DATA_PRIVACY.md](docs/DATA_PRIVACY.md) | NDPR alignment, minimization, retention, sub-processors, breach response |
| [docs/DATA_RESIDENCY_AND_PRIVACY.md](docs/DATA_RESIDENCY_AND_PRIVACY.md) | **NEW (DRAFT)** — Region, subprocessors, transfer, legal review gate |

### Governance
| Document | Purpose |
|---|---|
| [docs/DECISIONS.md](docs/DECISIONS.md) | **REVISED v2** — Architecture decision record (28 logged) |
| [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md) | **REVISED** — 28 risks with priority and mitigations |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Log of assumptions requiring validation |

## Stack (Founder-Approved Architecture)

- **Frontend/Backend:** Next.js + TypeScript (exact versions selected at scaffold from current stable, production-supported releases; D-011)
- **UI:** Tailwind CSS + shadcn/ui + SCOLAIRA design tokens (D-015)
- **Database:** PostgreSQL (Supabase managed)
- **ORM:** Drizzle ORM
- **Auth:** Supabase Auth
- **Payments:** Paystack (webhook-driven)
- **Hosting:** Vercel + Supabase (founder-owned; D-013)
- **Email:** Resend
- **Monitoring:** Sentry + Vercel logs + `/health`
- **Testing:** Vitest + Playwright

## Domains (Long-term, Pilot Approach)
- Public: `scolaira.com`
- App: `app.scolaira.com`
- Parent: `app.scolaira.com/pay/:token` (pilot), future `pay.scolaira.com`
- Platform admin: isolated `/admin` (pilot), future `admin.scolaira.com`

## Ten Inviolable Principles (Founder-Aligned)

1. **Trustworthiness & financial correctness come first.** Integer kobo internally; naira strings externally. No floats.
2. **Payment-method agnosticism is non-negotiable.** Cash, transfer, POS, online are all first-class. The value is the unified record, not the payment link.
3. **Confirmed payments never disappear.** Reversals, corrections, voids — never destructive deletes.
4. **Defense-in-depth tenant isolation.** App scoping + Postgres RLS + tests.
5. **Every financial mutation is audited.** Who, what, when, to which record, before, after, why.
6. **The ledger is authoritative.** Reports/dashboards derive from it, never the other way around. No cached dashboard state that drifts.
7. **Parents don't need accounts.** Signed, expiring, mobile-first transactional pages.
8. **The proprietor's first question is "where is my money?"** Every screen is judged against this. UX priority: owner → finance officer → parent.
9. **Deterministic, explainable intelligence — no fake AI.** Every priority shows WHY.
10. **Build for the first school. Architect for thousands.** No premature microservices, no AI gimmicks, no feature-count vanity.

## Three Priority Journeys

1. **OWNER:** Command Center → financial truth → action.
2. **FINANCE OFFICER:** Payment → allocation → reconciliation → receipt.
3. **PARENT:** View obligation → understand amount → pay / know how to pay → confirmation.

## What Happens Next

1. Founder approves the revised gate (see Approval Checklist in the Executive Review).
2. GitHub remote is set up (PC-01 through PC-07).
3. Initial commit is pushed and remote verified.
4. Milestones proceed in order: M0 (skeleton) → M1 (design system) → M2 (DB) → M3 (auth) → M4 (tenant/authz) → Phase 1 slices (onboarding → students → fees → billing → payments/reconciliation → command center → audit).
5. Each milestone: designed → implemented → tested → security-reviewed → visually-inspected → documented → committed → pushed → remote-verified.

Per §71 (revised): **we STOP here for approval before scaffolding.**
