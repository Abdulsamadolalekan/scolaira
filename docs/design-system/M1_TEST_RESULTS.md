# M1 Test Results

Run locally 2026-09-15, production build against `npm run start` (NODE_ENV=production).

## Quality gates

| Check             | Command                   | Result                                                      |
| ----------------- | ------------------------- | ----------------------------------------------------------- |
| Prettier          | `npx prettier --check .`  | PASS (also written via `npm run format`)                    |
| ESLint            | `npm run lint`            | PASS — 0 warnings, 0 errors                                 |
| TypeScript strict | `npm run typecheck`       | PASS — 0 errors                                             |
| Unit tests        | `npm test`                | PASS — 30/30 across 4 test files                            |
| Production build  | `npm run build`           | PASS — 6 routes (3 static, 3 dynamic), shared JS 103 kB     |
| `/api/health`     | `curl /api/health`        | HTTP 200, `{"status":"ok","version":"0.1.0-M1",...}`        |
| Playwright smoke  | `e2e/health.spec.ts`      | PASS — 7/7 in 3.2s                                          |
| Playwright a11y   | `e2e/a11y.spec.ts`        | PASS — 7/7 in 3.6s                                          |
| Screenshots       | `e2e/screenshots.spec.ts` | PASS — 18/18 in ~17s across desktop/tablet/mobile × 6 pages |
| Secrets audit     | regex grep over repo      | PASS — no live keys/credentials found                       |

## Unit tests (30 total)

- `lib/money/index.test.ts` — 15 tests (kobo↔naira formatting, negative, grouping, edge cases)
- `lib/errors/index.test.ts` — 2 tests (API error model)
- `lib/utils/cn.test.ts` — 3 tests (className merger)
- `components/ui/money.test.tsx` — 10 tests (Money component: tabular-nums, compact, overdue/positive variants, formatter edge cases; wrapped in TooltipProvider for Radix)

## Playwright tests (32 total)

### Smoke (health.spec.ts — 7)

1. `/api/health` returns ok payload and correct shape
2. Root page redirects to Command Center
3. Command Center renders KPIs + security headers (CSP)
4. Primitives showcase renders and tab switching works
5. Invoices list renders table containing INV-1042
6. Invoice detail renders summary (₦450,000.00 / ₦0.00 / ₦450,000.00)
7. 404 page renders for unknown routes

### Accessibility (a11y.spec.ts — 7)

1. Tabbing advances focus past body to interactive elements (buttons/links/inputs)
2. Skip-to-content link exists as first tab stop
3. Every page has exactly one `<main>` landmark and one `<h1>`
4. `prefers-reduced-motion: reduce` zeros `--motion-duration-fast` to 0ms
5. Buttons/links with icons have aria-hidden on the SVGs and either visible text or aria-label
6. Dialogs expose role=dialog, open via click, close on Escape (focus trap courtesy Radix)
7. Primary (forest) CTA buttons have computable bg+text color (smoke for contrast; full axe-core audit deferred to M2+)

### Visual/screenshots (screenshots.spec.ts — 18)

3 viewports × 6 pages, captured at:

- Desktop: 1440×900
- Tablet: 820×1180 (iPad)
- Mobile: 390×844 (iPhone 12 Pro)

Pages:

1. Command Center
2. Primitives showcase (Tokens tab visible)
3. Invoices list
4. Invoice detail (INV-1042)
5. Students list
6. Payments list

Screenshots saved to `e2e/screenshots/{desktop,tablet,mobile}/0{1-6}-*.png`.

## Visual QA (manual pixel review)

All 18 screenshot files were opened and inspected via read_file. Observations:

- **Palette:** Deep emerald (#0B3D2E) sidebar, ivory (#FDFBF6) page, white cards, near-black ink (#17201C), gold accent used sparingly (status dots, KPI footnotes). No neon, no gradients, no glassmorphism.
- **Typography:** Inter rendered cleanly; page titles bold, labels medium, body regular; hierarchy clear (KPI values at text-3xl/tabular-nums, section headers text-xl, meta labels uppercase text-xs text-ink-muted).
- **Spacing:** 4/8/16/24/32px rhythm visible throughout; cards have consistent 16px padding and 16px gaps; no crowding at 1440px.
- **KPI grid:** Desktop 5-up, tablet 2+3, mobile 2-col; values tabular-num aligned; deltas have directional arrows + sign (not color alone).
- **Status chips:** Paid/Overdue/Sent all render a leading dot + text label + tinted bg.
- **Tables:** Columns aligned (text left, money right); header at 12px/uppercase/tracking-wide; zebra striping subtle.
- **Invoice detail:** Summary strip (5-up) reads horizontally on desktop; meta columns (Billed to / Term & delivery) stack cleanly; line items table uses tabular-nums; actions (Send reminder, Void, Print) right-aligned in header — no duplicate Print button after the detail-page fix.
- **Mobile:** Hamburger menu + avatar top bar, 4-item bottom nav, lists render as card stacks (no horizontal-scroll tables), search + filter fit above list, badges sit right-aligned next to amount.
- **Tablet:** Drawer + bottom-nav hybrid, KPI grid adapts, table scrolls horizontally but remains legible.
- **Primitives showcase:** Palette swatches render correctly with hex labels; typography scale from xs through 4xl; buttons shown at all variants/sizes; forms/feedback/overlays/data/money tabs each demonstrate their primitives.
- **No duplicate content** (the earlier double "Adeyemi, Bolarinwa" in mobile cards was fixed and re-captured).

## Dependency review

- No new runtime dependencies were added in M1. Primitives use existing Radix UI packages
  already present in M0 (`@radix-ui/react-*`) plus `lucide-react` style hand-tuned SVGs
  in `components/ui/icons.tsx` (no external icon library added).
- `package.json` version bumped to `0.1.0-M1`.
- npm audit reports 11 vulnerabilities (7 moderate, 3 high, 1 critical) inherited from
  existing Radix dev dependencies; deferred to post-M1 per standing decision.
- No new secrets/credentials/API keys added. `.env.local` is gitignored; health endpoint
  does not expose anything sensitive.

## Package versions (unchanged from M0 locked set)

- next 15.5.25
- react 18.3.1
- typescript 5.9.3
- tailwindcss 3.4.19
- drizzle-orm 0.45.2 (installed; unused — M2 only)
- drizzle-kit 0.31.11 (installed; unused — M2 only)
- zod 3.25.76
- postgres 3.4.5 (installed; unused — M2 only)
- vitest 2.1.9
- @playwright/test 1.63.0
- eslint 9.39.5 (minor 9.x)
- prettier 3.9.6
