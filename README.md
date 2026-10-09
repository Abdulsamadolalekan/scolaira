# SCOLAIRA

**The Financial Operating System for Nigerian Private Schools.**
Brand promise: _Every term, fully funded._

> Spelling is sacred: **S-C-O-L-A-I-R-A** (Schola + Naira).

---

## Current Status

**Milestone M1 — Design System Foundation (complete).**
Semantic design tokens, 19 core UI primitives, navigation shell, page templates (Command Center / List / Detail), responsive behavior across desktop/tablet/mobile, print stylesheet, and accessibility states are in place. Visual QA screenshots captured at 3 viewports for every key screen.

- ~~M0 — Project Skeleton~~
- ~~M1 — Design System Foundation~~ (current)
- M2 — Database & Migrations
- M3 — Authentication
- M4 — Tenant Context & Authorization
- Slices 1–7 (Phase 1: Financial Truth)

**No business logic, database, auth, payments, or real financial data exist yet.** Money utilities (integer kobo / naira strings) plus a presentational `<Money />` component enforce the internal/external contract; all screens use explicit demo placeholders.

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Summary:

- **Framework:** Next.js 15 + React 18 + TypeScript
- **Styling:** Tailwind CSS v3 (with design tokens introduced in M1)
- **Database:** PostgreSQL via Drizzle ORM (schema & migrations in M2)
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Validation:** Zod (used by all API endpoints in future slices)
- **Auth:** first-party session/CSRF tokens minted by this application (M3/M4); there is no Supabase Auth
- **Payments:** Paystack webhook integration is **not implemented** (Phase 2, unstarted) — see the status note below
- **Hosting:** **none provisioned.** Nothing has been deployed anywhere; Vercel/Supabase appear in the planning documents as intent, not as the stack

> **Stack reality (H-9, 2026-09-26).** Supabase Auth, Resend, Sentry, Vercel and Paystack are named in
> the planning documents; **none of them is integrated** — there is no provider SDK in `package.json`,
> no deployment configuration, and no deployed environment. What runs today is a Next.js application
> on plain PostgreSQL (Drizzle), with everything in this repository. The operational status of each
> claimed control is tabulated in [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §0 and
> [`docs/ops/README.md`](docs/ops/README.md).

### Non-negotiable product principles

1. Financial truth first — invoices/payments/allocations/reversals are authoritative.
2. Payment-method agnostic — cash, transfer, POS, online all first-class.
3. No destructive financial history — reversals and corrections, not deletes.
4. Concurrency-safe — duplicate/race protection on every financial mutation.
5. Defence-in-depth tenant isolation.
6. Server-side RBAC; never trust the UI.
7. Auditable — WHO / WHAT / WHEN / TO WHICH / BEFORE / AFTER / WHY.
8. Built for Nigerian schools — real workflows, cheap Android, cash, bank transfers.
9. Premium private-bank aesthetic via semantic design tokens (M1).
10. Real functionality over appearance — no placeholders, no fake numbers.

## Development Setup

### Prerequisites

- Node.js 20+ (v20.x recommended, to match production)
- npm 10+
- Git
- Local PostgreSQL 15+ (needed at M2; M0 does not require a database yet)

### Install

```bash
npm install
```

### Run locally

```bash
npm run dev
# Open http://localhost:3000
```

### Scripts

| Script                     | Purpose                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`              | Start the Next.js dev server                                                      |
| `npm run build`            | Production build                                                                  |
| `npm run start`            | Serve production build                                                            |
| `npm run lint`             | ESLint                                                                            |
| `npm run typecheck`        | TypeScript type check (`tsc --noEmit`)                                            |
| `npm run format:check`     | Check Prettier formatting                                                         |
| `npm run format`           | Write Prettier formatting                                                         |
| `npm test`                 | Run Vitest unit tests                                                             |
| `npm run test:e2e`         | Run Playwright E2E tests (requires `npm run build` first or a running dev server) |
| `npm run test:e2e:install` | Install Playwright Chromium                                                       |
| `npm run db:generate`      | Generate Drizzle migrations (M2+)                                                 |
| `npm run db:migrate`       | Run migrations (M2+)                                                              |
| `npm run db:studio`        | Open Drizzle Studio (M2+)                                                         |

### Environment variables

Copy `.env.example` to `.env.local` and fill values. M0 only requires `NEXT_PUBLIC_APP_URL`; later milestones add DB, Supabase, Paystack, Resend.

**Never commit `.env.local` or real secrets.**

### Project structure (M0)

```
.
├── app/                  # Next.js App Router
│   ├── api/health/       # Health endpoint
│   ├── error.tsx         # Global error boundary
│   ├── not-found.tsx     # 404 page
│   ├── layout.tsx        # Root layout
│   ├── page.tsx          # Landing/status page (M0 minimal)
│   └── globals.css       # Tailwind + base styles
├── components/           # UI components (populated in M1)
├── docs/                 # Architecture, specs, decisions, plans
├── e2e/                  # Playwright E2E tests
├── lib/
│   ├── audit/            # Audit logger (stub in M0, real in M2+)
│   ├── db/               # DB client (stub in M0; real in M2)
│   ├── errors/           # Standard API error model
│   ├── idempotency/      # Idempotency key validation
│   ├── money/            # kobo/naira utilities (foundational, tested)
│   ├── security/         # Server-only/env helpers
│   └── utils/            # cn (className merger)
├── tests/                # Vitest setup
├── middleware.ts         # Next.js middleware (M0 passthrough; grows in M3/M4)
├── instrumentation.ts    # Next.js startup hook
├── drizzle.config.ts     # Drizzle-kit config
├── next.config.ts        # Next.js config + security headers
├── tailwind.config.ts    # Tailwind configuration (M0 structural; tokens in M1)
├── vitest.config.mts     # Vitest configuration
├── playwright.config.ts  # Playwright configuration
├── tsconfig.json
├── postcss.config.mjs
├── prettier.config.mjs
├── .eslintrc.json
└── .github/workflows/ci.yml
```

## Governance

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — Architecture Decision Record
- [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md)
- [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md)
- [`docs/IMPLEMENTATION_SEQUENCE.md`](docs/IMPLEMENTATION_SEQUENCE.md)

## Commit discipline

At every major milestone:

1. `npm run lint` passes
2. `npm run typecheck` passes
3. `npm test` passes
4. `npm run build` succeeds
5. Review for secrets
6. `git commit` → `git push` → `git ls-remote` → confirm remote matches local
7. Report commit SHA

---

_This repository is documentation and foundation only until later milestones.
No production financial data should be entered into the application until security,
multi-tenancy, and reconciliation are implemented and audited._
