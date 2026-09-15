# Implementation Sequence & Pre-Code Checklist

> After approval of this revised gate, implementation proceeds in milestones.
> Each milestone: designed → implemented → tested → security-reviewed → visually-inspected → documented → committed → pushed → remote-verified.

---

## Pre-Code Checklist (Must All Be TRUE Before Any Application Code)

Per Founder Corrections 2 and 17 and the D2 hard gate.

- [ ] **PC-01** — Founder creates a private GitHub repository under company ownership. (Recommended name: `scolaira/scolaira`.)
- [ ] **PC-02** — Founder grants push access to engineering (either via a PAT with `repo` scope added to git remote, or by pairing with engineering to authenticate).
- [ ] **PC-03** — Local repository is initialized and on branch `main` (already done).
- [ ] **PC-04** — Remote `origin` is configured (e.g., `https://github.com/scolaira/scolaira.git` or `git@github.com:scolaira/scolaira.git`).
- [ ] **PC-05** — Initial documentation (current commit) is pushed to remote.
- [ ] **PC-06** — Remote is verified (`git ls-remote` succeeds; GitHub UI shows the README and docs).
- [ ] **PC-07** — Branch protection is enabled on `main`: pull request required before merge; status checks required (to be added as CI is built); direct pushes to `main` disallowed.
- [ ] **PC-08** — All revised documentation (this set) is committed and pushed.
- [ ] **PC-09** — Founder confirms ownership/intent to create (or timeline for creating) Vercel, Supabase, Paystack (test), Resend accounts. These do not need to be ready before scaffolding begins but should be ready before staging deploys.
- [ ] **PC-10** — Stack versions selected at scaffolding time and recorded (Next.js, React, Next.js-compatible React, Drizzle, Tailwind, Vitest, Playwright — current stable, production-supported).
- [ ] **PC-11** — Domain `scolaira.com` status confirmed (registered? in progress?); does not block scaffolding, but blocks production URLs and payment-link DNS.
- [ ] **PC-12** — Founder approval is explicitly given on this revised gate (all items in §DD of the Executive Review).
- [ ] **PC-13** — GitHub default branch is `main` (already renamed locally; confirmed on remote).

---

## Implementation Milestones (Post-approval)

Each milestone is a vertical slice, with a test gate and a commit-push-verify step at the end.

### M0 — Project Skeleton

- Create Next.js app (TypeScript, App Router) with selected stable versions.
- Add Tailwind, shadcn/ui primitives seed, ESLint, Prettier.
- Add Drizzle, configure Postgres connection (local Docker Postgres for dev).
- Add Vitest, Playwright, testing setup.
- Set up GitHub Actions CI (lint + typecheck + unit tests initially; more as features build).
- Add `/api/health` endpoint.
- **Gate:** `npm run build` succeeds locally; CI green on remote; PUSH + VERIFY REMOTE.

### M1 — Design System Foundation

- Implement token layer (color, typography, spacing, radii, shadows, motion) per `/docs/design-system/DESIGN_SYSTEM_PLAN.md`.
- Build core primitives: Button, Input, Select, Checkbox/Radio/Switch, Badge/Status Chip, Alert, Toast, Skeleton, Empty State, Error State, Dialog, Drawer, Dropdown, Tabs, Table shell, KPI card, Confirm Pattern, Financial Number Formatter.
- Build navigation shell (sidebar + top bar) — structural only.
- Set up print stylesheet baseline.
- Add Storybook (or equivalent visual preview) for primitives; add visual snapshots.
- Run accessibility checks (axe + keyboard) on each primitive.
- **Gate:** Visual review by founder on primitives; CI green; PUSH + VERIFY REMOTE.

### M2 — Database & Migrations

- Stand up local Postgres for dev; document in README.
- Implement Drizzle schema for: organizations, users, memberships, sessions, terms, classes (initial set).
- Add RLS enablement and initial policies.
- Migration tooling wired; seed script for demo org.
- Add integration test harness (ephemeral Postgres per test run/suite).
- **Gate:** Migrations run cleanly forward and backward (where reversible); seed works; PUSH + VERIFY REMOTE.

### M3 — Auth

- Integrate Supabase Auth (email/password).
- Login page, logout, password reset, session handling.
- Protected route middleware; role-loading on session.
- Auth rate limits; session expiry (12h sliding / 30-day remember-me per D13).
- **Gate:** E2E login + logout + reset flows pass; CSRF enforced; failed-login rate limit tested; PUSH + VERIFY REMOTE.

### M4 — Tenant Context & Authorization

- Organization selection (single-org for pilot; schema supports multi-membership).
- Membership enforcement server-side; app DB scoping helper.
- RLS policies verified for initial tables.
- Cross-tenant access tests (authorizes test S-1/S-23/S-24) — these must fail as expected.
- Permission matrix enforced per role (initial set for actions that exist).
- **Gate:** Cross-tenant and privilege-escalation tests pass; PUSH + VERIFY REMOTE.

### Slices (Phase 1 — Financial Truth)

Slices each include: implementation, service layer, tests (unit + integration + applicable financial-matrix cases), audit events, UI, error states, empty states, visual inspection.

#### Slice 1 — Onboarding Wizard (basic)

- Create organization (post-signup), session, term, class setup, manual student entry path.
- Onboarding state tracking.
- CSV import for students is **deferred to Phase 2**.
- **Gate:** Happy-path onboarding E2E test passes; PUSH + VERIFY REMOTE.

#### Slice 2 — Students & Guardians

- CRUD for students and guardians.
- Status transitions: ACTIVE/ARCHIVED/WITHDRAWN (per state machine).
- Current class assignment; enrollment history.
- **Gate:** FM-student-lifecycle tests pass; PUSH + VERIFY REMOTE.

#### Slice 3 — Fee Catalog & Fee Assignments

- CRUD for fee definitions and fee assignments.
- State transitions: DRAFT/ACTIVE/ARCHIVED.
- Edit rules enforced (cannot edit fee with invoices).
- **Gate:** Tests pass; PUSH + VERIFY REMOTE.

#### Slice 4 — Billing

- Billing preview → run → issue flow.
- DRAFT invoice creation (with invoice lines from fee assignments).
- Issue transition (lines frozen).
- Void with reason (when allowed).
- **Gate:** FM-billing tests (F1, F2, void guard) pass; PUSH + VERIFY REMOTE.

#### Slice 5 — Payment Recording (cash/transfer/POS/manual)

- Record payment UI (manual method entry).
- Default state CONFIRMED for manual entries (cash/transfer/POS).
- Deterministic auto-allocation (per F allocation algorithm).
- Manual allocation UI (allocate/reallocate before close).
- Receipt print view.
- Simple reconciliation list (TO CONFIRM for pending; TO ALLOCATE for unallocated).
- State machine enforcement for payments/allocations/invoices.
- **Gate:** FM-1, FM-2, FM-3, FM-5, FM-6, FM-7, FM-9, FM-10, FM-11, FM-20, FM-21, FM-26, FM-27, FM-28, FM-32 all pass; cross-tenant tests pass; authorization tests pass; visual inspection of payment recording and receipt pages; PUSH + VERIFY REMOTE.

#### Slice 6 — Command Center v1

- KPIs derived from ledger: BILLED, COLLECTED, OUTSTANDING for current term (live computation).
- No fake decorative charts.
- **Gate:** Report consistency test (FM-25) verifying KPIs match underlying invoice/payment sums; visual inspection on desktop + mobile; PUSH + VERIFY REMOTE.

#### Slice 7 — Audit Log Viewer

- OWNER/SCHOOL_ADMIN access as per permission matrix.
- List view, filter by entity/actor/action/date; detail view shows before/after diff.
- **Gate:** Audit events visible for all covered actions; cross-tenant audit access blocked; PUSH + VERIFY REMOTE.

### Phase 1 Exit Gate

All Phase-1-applicable financial matrix tests pass: FM-1..FM-11, FM-18..FM-22, FM-25..FM-28, FM-32 (online cases deferred to Phase 2).
All Phase-1-applicable security matrix tests pass (S-1..S-6, S-9..S-14 where applicable).
Visual inspection of: Command Center, Students, Billing, Invoice list/detail, Payment recording, Receipt, Reconciliation queue, Audit log.
Accessibility scan (axe) on key pages; keyboard test on core flows.
Staging deploy once Vercel/Supabase are provisioned; smoke E2E on staging.

---

## Parallel Activity: Real-World Discovery

- As soon as pilot school is identified (D7), begin discovery interviews (per `/docs/discovery/REAL_WORLD_DISCOVERY_PLAN.md`).
- Findings are logged in the Discovery Backlog; any changes required to architecture or Phase 3 design go through `/docs/DECISIONS.md`.
- Phase 1 build continues in parallel using domain invariants; changes from discovery land in Phase 2–3.

## Parallel Activity: Infrastructure Provisioning

- Once founder creates Vercel/Supabase accounts:
  1. Link Vercel project to GitHub repo; configure environments.
  2. Provision Supabase project in chosen interim region (final region decided via Data Residency document).
  3. Set env vars per `/docs/DEPLOYMENT.md`.
  4. Run migrations against staging.
  5. Deploy to staging and run smoke.
- Paystack test keys to be added when Slice online-payments begins (Phase 2).

## Parallel Activity: Brand Review

- After M1 (design primitives), schedule a design review with founder using the primitive library + Command Center v1 + Receipt print view.
- Token values (final palette, typography) finalized and swapped in tokens.
- Logo/wordmark added when assets are provided.

## Milestone Reporting Format

At each milestone completion, report:

- Commit hash.
- Remote verification: `git ls-remote` output (last commit sha).
- Test results (which suites passed/failed).
- Visual review notes.
- Any new decisions added to the log.
- Any new risks added to the register.
- Next milestone scope.

---

## Quality Gate Per Slice

A slice is done only when it satisfies (where applicable):

- Product (works for the intended journey).
- UX (reviewed against UX principles; responsive; correct states).
- Financial (invariants hold; tests pass).
- Security (authz, tenant isolation, input validation, CSRF).
- Data (correct migrations; no drift).
- Testing (unit + integration + applicable FM and security cases; E2E for critical paths).
- Accessibility (axe clean on new pages; keyboard works).
- Performance (no egregious issues; appropriate loading states).
- Documentation (updated; relevant README/ADR/test docs).
- Operations (gates CI, logs appropriately, no PII in logs).
