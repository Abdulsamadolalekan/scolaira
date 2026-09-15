# SCOLAIRA — Testing Strategy

> A feature is done only when it satisfies product, UX, financial, security, data, testing, accessibility, performance, documentation, and operations quality gates.

---

## I. Testing Levels

| Level | Tool | Purpose | CI gate |
|---|---|---|---|
| Unit | Vitest | Money math, invariant guards, allocators, validators, state machines, pure logic. | required |
| Integration / DB | Vitest + Postgres test container | Services against a real Postgres (with RLS enabled in RLS tests), transaction rollback per test. | required |
| API / Contract | Vitest + HTTP helper against Next.js route handlers | Input validation, auth, status codes, response shape, idempotency, error determinism. | required |
| Financial | Vitest + service layer + DB | Dedicated suite for every invariant in FINANCIAL_INVARIANTS.md and every scenario in §III below. | required (blocks deploy) |
| Authorization | Vitest | Role matrix enforcement: every role × every endpoint. | required |
| Security | Custom scripts + Playwright + manual checklist | Cross-tenant, IDOR, CSRF, XSS, injection, webhook forgery, rate limits. | required (P0 items block) |
| E2E | Playwright (Chromium + WebKit) | Critical happy paths + parent payment flow on staging-like environment. | required on main |
| Visual | Playwright screenshots + Storybook | Typography, hierarchy, spacing, states. | PR (screenshot diff review) |
| Accessibility | axe-core (Playwright) + manual keyboard tests | WCAG 2.1 AA on critical paths. | required on key pages |
| Mobile / Responsive | Playwright device emulation + real-device spot checks | Cheap Android, narrow screens, touch targets. | required on parent flow + key school screens |
| Performance | Lighthouse CI (limited) + DB query analysis | Prevent severe regressions; not premature optimization. | advisory at pilot |
| Load | k6 (Phase 9+) | Multi-school concurrency simulation. | not pilot |

## II. Test Organization

```
apps/web/
├── src/... (application code)
└── tests/
    ├── unit/
    │   ├── money/                # kobo/naira parsing/formatting/arithmetic
    │   ├── allocations/
    │   ├── invariants/
    │   ├── validators/
    │   └── state-machines/
    ├── integration/
    │   ├── billing.test.ts
    │   ├── payments.test.ts
    │   ├── reconciliation.test.ts
    │   └── ...
    ├── financial-matrix/         # see §III
    ├── security/
    │   ├── cross-tenant.test.ts
    │   ├── privilege-escalation.test.ts
    │   ├── webhooks.test.ts
    │   └── ...
    ├── e2e/
    │   ├── auth.spec.ts
    │   ├── billing-to-collection.spec.ts
    │   ├── reconciliation.spec.ts
    │   ├── parent-payment.spec.ts
    │   └── command-center.spec.ts
    ├── a11y/
    └── fixtures/
```

## III. Required Financial Test Matrix (Phase 1 Exit Gate)

Every scenario below must have a deterministic automated test. A failure here STOPS development until the invariant is fixed.

| # | Scenario | Invariants covered |
|---|---|---|
| FM-1 | Cash payment in full, single invoice, exact amount | F1–F5, F7, F11 |
| FM-2 | Bank transfer payment in full | F2, F3, F4, F8 |
| FM-3 | POS payment recorded with external reference | F2, F8 |
| FM-4 | Online (Paystack) payment recorded via webhook | F8, F9, F10 |
| FM-5 | Partial payment on single invoice (outstanding correctly reduced) | F3, F4, F14 |
| FM-6 | Multiple partial payments across time on same invoice | F3, F4, F5, F12 |
| FM-7 | Single payment across multiple invoices (auto-allocation deterministic) | F3, F4, allocation ordering |
| FM-8 | Previous-term debt coexists with current term; balances separated | F13, F14 |
| FM-9 | Exact payment (zero outstanding afterward; status PAID) | F1, F4 |
| FM-10 | Underpayment (status PARTIALLY_PAID, correct outstanding) | F3, F4 |
| FM-11 | Overpayment attempt (allocation capped; surplus flagged/unallocated) | F3, F4, F15 |
| FM-12 | Duplicate external reference (cash receipt number clash, POS duplicate) | F8 |
| FM-13 | Duplicate webhook (same Paystack event_id delivered twice) | F8, F9 |
| FM-14 | Reversed payment (full) — collected totals adjust; history preserved | F5, F6, F7 |
| FM-15 | Refunded payment — refund creates separate record; original preserved | F5, F6, F7 |
| FM-16 | Late webhook: charge.success arrives after a refund has been processed | F9, F10 |
| FM-17 | Failed online payment — no financial effect; no invoice impact | F2, F5 |
| FM-18 | Unmatched transfer (student unknown) — placed in reconciliation queue; not allocated | F15, reconciliation |
| FM-19 | Manual reconciliation: attach student → auto-allocate → confirm | F3, F4, F5 |
| FM-20 | Automatic allocation determinism: same input always produces same allocation across runs | determinism |
| FM-21 | Allocation correction: finance officer reallocates a payment from one invoice to another | F3, F4, F6, F12 |
| FM-22 | Unauthorized reversal attempt by STAFF role | authorization, F6 |
| FM-23 | Cross-tenant payment access: user from org A attempts to view/edit org B payment | F11, T1 |
| FM-24 | Cross-tenant student access: same for students/invoices | F11, T1 |
| FM-25 | Report consistency: billed/collected/outstanding sums match per-invoice aggregations | F14 |
| FM-26 | Concurrent payment recording: two finance officers record payments simultaneously | F3, F4, concurrency |
| FM-27 | Concurrent allocation against same payment/invoice (race condition attempt) | F3, F4, locking |
| FM-28 | Voiding an invoice with non-reversed allocations must fail (F2 guard) | F1, F5 |
| FM-29 | Invoice edit after ISSUED is restricted; credit-note/correction path required | F1, F5 |
| FM-30 | Webhook idempotency across replay (5x same event) | F9 |
| FM-31 | CSV import of payments with malformed/missing/impossible amounts is rejected cleanly | input validation, no partial import |
| FM-32 | Allocation remainder (e.g., splitting ₦10,000 across 3 invoices of ₦3,333.33) doesn't silently lose kobo | kobo precision, deterministic remainder |

## IV. Security Test Matrix

| # | Test |
|---|---|
| S-1 | Cross-tenant read/write attempts (invoices, payments, students, reports, audit) |
| S-2 | Privilege escalation: STAFF attempting FINANCE_OFFICER actions; SCHOOL_ADMIN attempting OWNER-only actions |
| S-3 | Unauthorized financial actions: editing a payment they didn't record; voiding without reason |
| S-4 | CSRF: POST to mutating endpoint without CSRF token (must fail) |
| S-5 | IDOR: changing invoice_id/payment_id/student_id in request to an ID from another tenant |
| S-6 | Session misuse: using another user's cookie; using expired session; logging out invalidates token |
| S-7 | Webhook forgery: invalid HMAC signature; wrong secret; timestamp outside window; replayed after expiry |
| S-8 | Duplicate event processing does not double-count |
| S-9 | Malicious CSV imports: formula (`=2+5|cmd...`), SQL strings, XSS payloads, oversized rows, missing columns, duplicate identifiers |
| S-10 | XSS: reflection of student names, notes, comms bodies, CSV preview cells |
| S-11 | SQL injection on every text input/search |
| S-12 | Secret exposure: built client bundle does not contain service-role key or webhook secret |
| S-13 | Rate abuse: rapid login attempts trigger lockout; payment link brute force blocked |
| S-14 | Unauthorized exports: unauthenticated/underprivileged users cannot access CSV/PDF export endpoints |
| S-15 | Password reset tokens are single-use, expire, cannot be guessed |

## V. UX Testing Plan

Not everything can be automated. The following are performed manually with documented evidence (screenshots or notes):

- **Typography & spacing:** All key screens inspected at desktop and mobile widths for density, hierarchy, and readability.
- **Tables:** Columns align, numbers right-aligned, overflow handled, sorted indicators clear.
- **Forms:** Labels, required indicators, validation errors inline, focus states, keyboard navigation.
- **Buttons & status:** Primary/secondary/destructive distinguished; disabled states; confirmation for destructive actions.
- **Financial density:** Command Center and Payments list must show enough information without feeling cramped.
- **Error states:** Each critical error path (payment fail, import fail, permission denied, link expired) is inspected visually and copy-reviewed.
- **Empty states:** No broken-looking empty lists; clear action prompts.
- **Loading states:** Skeletons or spinners where data is being fetched; layout shift minimized.
- **Mobile:** Parent payment flow tested on at least one real low-end Android (or strong emulation).
- **Visual trust:** No neon, no flashy gradients, no decorative badges; private-bank visual discipline maintained.

## VI. Accessibility Checklist

- All interactive elements reachable via Tab in logical order.
- Visible focus ring on every focusable element.
- Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text.
- Form fields have associated `<label>`s.
- Icon-only buttons have accessible names.
- Tables use proper `<table>` semantics with headers.
- Errors announced via ARIA live region where appropriate.
- Touch targets ≥ 44×44 CSS pixels on mobile.
- No auto-playing content; motion respects `prefers-reduced-motion`.
- axe-core scan produces zero critical/serious violations on audited pages.

## VII. CI Pipeline

On every push to a PR:
1. Install deps (pnpm/npm — use pnpm for speed, decide at scaffolding).
2. Lint (ESLint + Prettier check + custom lint for forbidden money patterns).
3. TypeScript type-check.
4. Unit tests.
5. Build (`next build`).
6. Integration tests against ephemeral Postgres (service container in CI).
7. Financial matrix suite against ephemeral Postgres.
8. Authorization tests.
9. Playwright E2E against preview build.
10. Accessibility scan on key routes.
11. Visual snapshot comparison (on key pages).

On merge to `main`:
1. All of the above.
2. Run database migrations against staging.
3. Deploy to staging automatically.
4. Run a subset of smoke E2E against staging.
5. Manual approval gate for production deploy.

## VIII. Testing Data

- Development seed: realistic 150–800 student dataset (see `/docs/DATABASE.md` §VI).
- Fixtures for financial tests build their own data inside transactions to avoid inter-test coupling.
- Never use production data in development or CI.

## IX. Bug Handling

- Every production bug gets a regression test before fix is merged.
- Financial bugs are P0 and block release until fixed + covered by test.
- Security bugs follow security incident response in `/docs/SECURITY.md`.

## X. Test Code Quality

- Tests are first-class code; reviewed to same standard as product code.
- No "flaky" tests accepted; a flaky test is a bug. Quarantine only with an owner and a ticket.
- Tests are deterministic: no reliance on wall-clock time beyond injected clocks; no random data that changes assertions; network calls mocked where not under test.
