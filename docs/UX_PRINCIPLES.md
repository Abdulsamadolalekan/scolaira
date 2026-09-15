# SCOLAIRA — UX & Visual Principles

> The design benchmark is: **private bank × distinguished school × modern financial software.**

---

## I. Core Feel

SCOLAIRA must feel:
- **Authoritative** — a proprietor trusts it with financial truth.
- **Calm** — no panic, no flash, no marketing noise.
- **Premium** — precise, restrained, like a good financial institution.
- **Precise** — numbers are right; hierarchy is clear; no ambiguity.
- **Trustworthy** — every affordance says "we will not make mistakes with your money."
- **Intelligent** — surfaces what matters; hides what doesn't.
- **Nigerian** — designed for Nigeria, not a Silicon Valley fantasy.
- **Mature** — no gimmicks, no toy-like cues.
- **Operational** — built for daily use by finance officers, not admired once on a landing page.

It must NOT feel:
- Childish · crypto-like · flashy · generic SaaS · AI-gimmick · game-like · glassmorphic · neon · decorative-dashboard.

Premium does not mean decoration. Premium means precision, restraint, consistency, hierarchy, confidence.

## II. Visual Language

### A. Palette (Interim, Pending Final Brand — D8)

| Token | Hex | Use |
|---|---|---|
| `emerald-900` | `#044E29` | Deepest accents, headings (sparingly) |
| `emerald-700` | `#046A38` | Primary brand, primary buttons, key KPIs |
| `emerald-500` | `#2F8F5C` | Active states, links, secondary accents |
| `emerald-50` | `#EAF4EE` | Selected rows, success backgrounds, subtle highlights |
| `gold-600` | `#C9A961` | Accent: premium markers, key highlights, "featured" states — SPARINGLY |
| `gold-100` | `#F5EEDC` | Subtle premium surfaces (rarely) |
| `ink-900` | `#0B1F16` | Primary text, near-black with green undertone |
| `ink-700` | `#25372D` | Secondary text |
| `ink-500` | `#5C6B64` | Tertiary text, labels, placeholders |
| `ink-300` | `#B7C0BB` | Dividers, borders |
| `ink-100` | `#E6EAE7` | Hairlines, faint borders |
| `paper` | `#F7F3EC` | Page background (warm off-white, not stark white) |
| `white` | `#FFFFFF` | Cards, surfaces |
| `red-600` | `#B42318` | Destructive actions, errors, overdue (not neon red) |
| `red-50` | `#FDECEC` | Error backgrounds |
| `amber-500` | `#D98E04` | Warnings, "needs attention" |
| `amber-50` | `#FEF4E1` | Warning backgrounds |
| `blue-600` | `#1E5A8B` | Info, links (sparingly) |

**Gold is an accent, not the interface.** It marks what is exceptional — not everything.

### B. What to Avoid
- Gradients that span whole pages.
- Heavy drop shadows; shadows are tight and purposeful (elevation = 1–2 levels, never 6).
- Rounded corners > 8px; most controls use 4–6px; cards 8px. Avoid 24px pill buttons.
- Random animations/confetti.
- Huge glowing typography.
- Decorative donut charts with 12 colors.
- Meaningless badges (e.g., "PRO TIP", "NEW!").
- Emojis in the product UI.

### C. Typography
- **Primary:** Inter (highly legible, neutral, modern, widely available).
- **Numeric:** Use Inter's tabular-nums feature (`font-variant-numeric: tabular-nums`) for all monetary figures so columns align perfectly.
- Hierarchy:
  - Page titles: 20–24px, semibold.
  - Section heads: 16–18px, semibold.
  - Body: 14px, regular.
  - Table text: 13–14px, regular, tabular-nums.
  - Small labels/captions: 12px, medium.
- Density: comfortable for 8-hour finance-officer use; not sprawling. Line-height ~1.5 for body, ~1.2 for headings.

### D. Spacing & Density
- 4px grid.
- Cards: 20–24px internal padding.
- Table cells: 10–12px vertical, 16px horizontal.
- Buttons: 36–40px height; touch targets ≥ 44px on mobile.
- Command Center KPIs: large (28–36px) tabular numbers, small labels underneath, minimal chrome.

## III. Information Hierarchy

On any financial screen, the eye should land in this order:

1. **AMOUNT** — how much money.
2. **STATUS** — what state is this in (paid, outstanding, overdue, unreconciled, flagged).
3. **WHO** — which student/parent/class.
4. **WHAT** — which fee/invoice/term.
5. **WHEN** — date/time.
6. **WHY** — context, notes, reason flags.
7. **NEXT ACTION** — what the user can do right now.

The proprietor should never have to click through five cards to find that ₦4.2M is overdue.

## IV. Components (Core Set)

- **KPI card:** large tabular number, small label, optional delta (↑ ↓ with colored arrow), no chart junk.
- **Status chip:** small, quiet, consistent color coding (green = good/paid, amber = pending/partially paid, red = overdue/reversed, slate = neutral/draft).
- **Data table:** right-aligned numeric columns, sortable headers, sticky headers on scroll, row selection, row actions menu at right, zebra striping off (use row hover only).
- **Empty state:** concise explanation + single recommended action; no sad-clip-art.
- **Form fields:** label above, consistent 36–40px height, clear error messages below, helper text only where needed.
- **Buttons:**
  - Primary (emerald) — "Record payment", "Issue invoices", "Confirm".
  - Secondary (white with border) — "Cancel", "Back".
  - Tertiary (text link) — low-emphasis actions.
  - Destructive (red outline or solid for confirmations) — "Reverse payment", "Void invoice".
  - Never more than one primary action per section.
- **Confirmation dialogs** for destructive actions: restate what is about to happen, require reason text where policy demands it, make the destructive button clearly labeled (not just "OK").
- **Activity / audit stream:** chronological, actor + action + timestamp + before/after on expand.
- **Navigation (sidebar):** icon + label, collapsed or expanded; current section clearly marked with emerald accent (left border 3px + subtle bg); no decorative gradients.

## V. Financial Copy

Copy sounds like an experienced financial institution.

- Short sentences.
- Facts, not slogans.
- Actions, not adjectives.
- Naira amounts formatted with commas and `.00` decimals, e.g. `₦4,350,000.00`.
- Dates in Nigerian format (DD MMM YYYY), e.g. `15 Sep 2026`.

**Examples:**
- Good: "₦43.4M remains outstanding."
- Good: "9 payments require review."
- Good: "₦1.2M was collected this week."
- Good: "3 accounts are 30+ days overdue."
- Bad: "Unlock the future of education."
- Bad: "Revolutionize your school."
- Bad: "AI-powered magic."
- Bad: "Something went wrong."

Buttons use verbs: "Record payment", "Issue receipts", "Confirm", "Allocate", "Reverse", "Export".

Errors explain what happened, why, what is safe, and what to do next:

> **This payment cannot be allocated.**
> The amount (₦150,000.00) exceeds the outstanding balance on invoice INV-2025-0312 (₦120,000.00).
> Review the allocation or split the remainder to another invoice.

## VI. States to Design (Every Screen)

1. Loading (skeletons match content shape).
2. Empty (explain + action).
3. Populated (default view).
4. Partial data (e.g., some payments recorded, others pending reconciliation).
5. Error (friendly, actionable, specific).
6. Permission denied (explain who can do the action).
7. Stale data (show "as of" timestamp; warn if data may be behind).
8. No results for filter/search.
9. Success (clear confirmation with next action, not a dead-end).
10. Destructive confirmation (clear consequences).
11. Offline / interrupted (graceful message; no lost input).

## VII. Responsive Strategy

- **Desktop (≥1280px):** Sidebar, dense tables, multi-column Command Center.
- **Laptop (1024–1279px):** Same layout; KPIs wrap to fewer columns; tables still tabular.
- **Tablet (768–1023px):** Sidebar collapses to icons; tables get horizontal scroll with shadow indicator; KPI grid 2 columns.
- **Mobile (<768px):**
  - Sidebar becomes bottom navigation or drawer (test both with users).
  - Tables become card lists (each student/payment/invoice is a card with AMOUNT + STATUS at top, details below).
  - Forms full-width; buttons full-width primary.
  - Parent payment pages are mobile-first: big amount, big Pay button, minimal clutter.

The mobile experience is not a shrunken desktop. Re-design interactions for fingers and narrow screens.

## VIII. Accessibility

- WCAG 2.1 AA target.
- 4.5:1 contrast on body text. Emerald `#046A38` on white passes; gold `#C9A961` on paper does NOT for body text — only use gold for accent/decorative text, not copy.
- Keyboard navigation works for every interaction.
- Focus rings are visible (emerald-500 outline, no outline:none without replacement).
- All form fields have labels.
- Icon-only buttons have `aria-label`s.
- Tables use proper `<table>` semantics for screen readers.
- Errors are announced via ARIA live regions on forms.
- Touch targets ≥ 44×44px on mobile.
- Motion is reduced for users who prefer-reduced-motion.
- No color-only status cues (combine color with icon/text, e.g., red + "Overdue").

## IX. Parent Payment Pages (Mobile-first, Transactional)

- School logo + name prominent (trust anchor).
- Student name + class clearly identified.
- **Big amount at top** (you owe ₦X).
- Itemized fees below (collapsible).
- Payment method options as large buttons (Pay online / Bank transfer / Cash at bursary).
- Online path: Paystack inline (pay inline without navigating away much).
- Cash/transfer path: clear instructions + "I have paid" flow that flags for reconciliation.
- After payment: success screen with amount, receipt number, downloadable receipt (PDF), option to send to WhatsApp/email.
- No navigation chrome, no upsell, no "create account".

## X. Command Center (Composition Principles)

1. Top: title ("First Term 2025/2026") + term switcher + "as of" timestamp.
2. Hero row: four KPI cards — BILLED · COLLECTED · OUTSTANDING · OVERDUE (emerald for positive, red for overdue, gold on the "signal" KPI that needs attention).
3. Secondary row: UNRECONCILED PAYMENTS · COLLECTION RATE · PRIOR-TERM EXPOSURE.
4. Main area: two columns:
   - Left: Financial Action Centre (prioritized list: what needs attention, each with reason and next action).
   - Right: Trends (collection over time + overdue aging).
5. Drilldown: clicking any number leads to a filtered list of the underlying transactions.

No charts unless they answer a specific decision question. Avoid pie charts (hard to compare slices). Prefer bars and big numbers.

## XI. What Great Looks Like

A finance officer opens SCOLAIRA on a Monday morning.

Within 10 seconds they know:
- ₦43.4M was billed this term.
- ₦28.7M collected; ₦14.7M outstanding.
- ₦5.2M is overdue; ₦890K is unreconciled.
- 11 high-priority accounts need follow-up this week — the first is ₦420K, 38 days overdue, with ₦120K prior-term debt.
- They click → see the account → send reminder or record an agreed payment plan.

A proprietor opens SCOLAIRA on their phone after church.

Within 5 seconds they know:
- Where the school is on collections this week.
- Whether anything is wrong.
- What the finance team should be doing.

That is the standard.
