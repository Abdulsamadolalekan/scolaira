# SCOLAIRA Design System — M1 Implementation Notes

> Status: **Implemented in code (M1)**. This document records what shipped, where it
> lives, and the conventions future slices must follow.

The source of truth is always the tokens in `app/tokens.css`, the Tailwind theme
extensions in `tailwind.config.ts`, and the component source under
`components/ui/`.

---

## 1. Design-token architecture

Tokens are defined as CSS custom properties on `:root` (light theme) in
`app/tokens.css`, imported from `app/globals.css`. Dark theme is not in scope for
M1; the token layer is structured so one can be added later by overriding
variables on `[data-theme="dark"]`.

Token layers:

| Layer         | Examples                                                 | Purpose                                                 |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| **Primitive** | `--color-forest-900`, `--color-gold-500`, `--ink-900`    | Raw palette values; never used directly in components   |
| **Semantic**  | `--color-bg-page`, `--color-fg-primary`, `--color-brand` | Consumed by components via Tailwind `text-bg-page` etc. |
| **Component** | `--btn-primary-bg`, `--ring-focus`                       | Component-scoped defaults                               |

Tailwind maps semantic tokens into its utility layer (see `tailwind.config.ts`),
so `bg-page`, `text-ink`, `border-subtle`, `ring-focus`, etc. all resolve to the
semantic variable.

**Hard-coded hex/RGB values are forbidden in JSX.** All components consume
tokens via Tailwind utilities that are wired to CSS variables.

## 2. Color

Approved palette (nigerian-private-school / private-bank aesthetic):

| Role           | Token                        | Hex       | Used for                                                |
| -------------- | ---------------------------- | --------- | ------------------------------------------------------- |
| Deep emerald   | `forest-700`→`--color-brand` | `#0B3D2E` | Sidebar, primary CTAs, focus ring base                  |
| Rich gold      | `gold-500`→`accent`          | `#C9A227` | Accents, selected states, warnings when not destructive |
| Ivory page     | `paper`                      | `#FDFBF6` | Page background                                         |
| White card     | `surface`                    | `#FFFFFF` | Cards, table headers, form controls                     |
| Near-black ink | `ink-900`                    | `#17201C` | Primary body text                                       |

Functional colors:

- `--color-danger-fg/bg/border` — overdue/unreconciled (a restrained red, not neon)
- `--color-success-fg/bg/border` — collected/paid (muted green)
- `--color-warning-fg/bg/border` — needs-attention (gold)
- `--color-info-fg/bg/border` — informational (forest tint)

Status chips (Badge) and KPI deltas use these _plus_ a leading status dot so the
information does not depend on color alone.

## 3. Typography

- **Font family:** Inter 400/500/600/700 (loaded via `next/font/google` in root
  layout).
- **Scale** (modular ~1.2, aligned to 4px baseline):
  - `text-xs` 12/16, `text-sm` 13/20, `text-base` 14/20, `text-lg` 16/24,
    `text-xl` 18/28, `text-2xl` 22/32, `text-3xl` 28/36, `text-4xl` 34/40.
- **Weight conventions:** 400 body, 500 labels, 600 headings and KPI values,
  700 page titles and large totals.
- **Tabular numerals** are on by default for financial numbers via the
  `tabular-nums` class (automatically applied by `<Money />`, `<KpiCard />`, and
  table numeric cells). Variable-width is used for prose and names.
- **Ink hierarchy:** `text-ink` → `text-ink-muted` → `text-ink-subtle`; never
  reduce opacity on ink (it breaks contrast on tinted surfaces).

## 4. Spacing (4px system)

All spacing, sizing, radii, and typographic gaps are multiples of 4px. Tailwind's
default 4px scale is used (`p-1=4px`, `p-2=8px`, `p-4=16px`, etc.).

Custom layout tokens live in both `spacing` and `width`/`height` in Tailwind
config (important: Tailwind does NOT auto-share the scales):

| Token               | Value | Use                         |
| ------------------- | ----- | --------------------------- |
| `sidebar`           | 248px | Desktop sidebar width       |
| `sidebar-collapsed` | 72px  | Icon-only collapsed sidebar |
| `topbar`            | 64px  | Topbar/top nav height       |
| `bottomnav`         | 64px  | Mobile bottom-nav height    |

## 5. Radius

Restrained — not pill, not overly rounded:

- `radius-sm` 4px: badges, small inputs, tags
- `radius-base` 8px: cards, buttons, inputs, table cells
- `radius-lg` 12px: dialogs, drawers, large surfaces
- `radius-full`: status dots, avatar rings (rare; never for buttons)

Buttons use `radius-base` (8px), NOT `rounded-full`.

## 6. Borders & elevation

- Default border: 1px solid `--border-subtle` (`#E4E7E2`) on ivory; `--border-default`
  (`#D0D4CE`) for interactive controls.
- Shadows are _very_ restrained (private-bank flatness):
  - `shadow-sm` — card hover / raised controls
  - `shadow-md` — popovers and dropdowns
  - `shadow-lg` — dialogs
  - No colored glow, no neon, no heavy drop shadows.
- Elevation is expressed primarily through layering (surface-above-paper) and
  borders; shadows are a subtle cue only.

## 7. Focus states & accessibility

- Focus is a thick, high-contrast outline: 2px solid `--ring-focus` (forest-600
  at 80% alpha), 3px offset — no box-shadow glow.
- All interactive elements (`Button`, `Input`, tabs, table sortable headers,
  menu items) display the same ring on `:focus-visible`.
- A visually-hidden **skip-to-content** link is the first tab stop on every page
  (see `app/layout.tsx`).
- Icons inside labelled controls carry `aria-hidden="true"` and a `<title>` is
  _not_ rendered — the button's visible text or `aria-label` is the accessible
  name.
- Dialogs/drawers use Radix's built-in ARIA (role + focus trap + Escape to close).
- `prefers-reduced-motion` is honored: CSS zeroes `--motion-duration-*` and
  disables transitions/animations for users who opt out.

## 8. Motion

Short, purposeful, never decorative:

| Token                    | Duration | Use                                |
| ------------------------ | -------- | ---------------------------------- |
| `--motion-duration-fast` | 120ms    | button hover, focus, badge changes |
| `--motion-duration-base` | 200ms    | drawers, dropdowns, toast enter    |
| `--motion-duration-slow` | 300ms    | dialog, large page transitions     |

Easing: `cubic-bezier(0.2, 0, 0, 1)` (standard Material-like ease-out).

## 9. Financial-number presentation

All monetary values flow through the `<Money />` component or its underlying
formatters (`lib/money`, wrapped for presentation in `components/ui/money.tsx`):

- Internal unit: **kobo as integer**. No floats cross boundaries.
- Display uses **₦** (Naira sign, not NGN or N) followed by the absolute value;
  negatives are rendered as `−₦1,234.00` (real minus sign, not hyphen).
- Tabular numerals are always applied (`font-variant-numeric: tabular-nums`).
- Full format: `₦43,400,000.00` (two fixed decimals, grouped thousands).
- Compact format (KPIs, crowded cards): `₦43K`, `₦1.5M`, `₦43.4M`, `₦1.2B`, `₦1.2T`
  with a tooltip revealing the full amount on hover/focus.
- Variants: `default`, `muted`, `positive`, `overdue` — the latter two also
  render a leading status dot via an ancestor KPI/Badge, not solely color.

### Key financial statuses that must remain distinguishable without color

- **BILLED** (contractual receivable)
- **COLLECTED** (cash in hand)
- **OUTSTANDING** (unpaid, not yet overdue)
- **OVERDUE** (past due date)
- **UNRECONCILED** (incoming payment not yet matched to invoice)

M1 only demonstrates these as Badge variants and mock KPI deltas; M2+ business
logic will bind them.

## 10. The 19 core primitives (M1)

All primitives live in `components/ui/` and are re-exported via the
`components/ui/index.ts` barrel.

| #   | Primitive             | File                | Status | Notes                                                                                             |
| --- | --------------------- | ------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| 1   | Button                | `button.tsx`        | done   | default/primary, secondary, ghost, outline, danger, destructive; sizes sm/md/lg; disabled/loading |
| 2   | Input                 | `input.tsx`         | done   | label/error/hint/prefix/suffix; native `<input>`                                                  |
| 3   | Badge                 | `badge.tsx`         | done   | default/info/success/warning/danger/neutral + status dot                                          |
| 4   | Checkbox/Radio/Switch | `checkbox.tsx`      | done   | Radix-based; check + switch (radio via native when needed)                                        |
| 5   | Dialog                | `dialog.tsx`        | done   | Radix; header/title/description/footer                                                            |
| 6   | Drawer                | `drawer.tsx`        | done   | Right-side mobile drawer (used by NavShell)                                                       |
| 7   | Dropdown              | `dropdown-menu.tsx` | done   | Radix dropdown; items, separators, labels, danger variant                                         |
| 8   | Tooltip/Popover       | `tooltip.tsx`       | done   | Radix tooltip (popovers built on same primitives for M2+)                                         |
| 9   | Table                 | `table.tsx`         | done   | semantic `<table>`; sortable headers via `onSort`; striped option; numeric right-align            |
| 10  | Tabs                  | `tabs.tsx`          | done   | Radix; includes SegmentedControl variant                                                          |
| 11  | Alert                 | `alert.tsx`         | done   | info/success/warning/danger variants with icon, title, description                                |
| 12  | Toast                 | `toast.tsx`         | done   | provider at root; add/remove via `useToast`; auto-dismiss                                         |
| 13  | Empty state           | `empty.tsx`         | done   | icon/title/description/action                                                                     |
| 14  | Skeleton              | `skeleton.tsx`      | done   | shimmer pulse; reduced-motion disables shimmer                                                    |
| 15  | Error state           | `error-state.tsx`   | done   | title/message/action for page/section errors (used by app/error.tsx)                              |
| 16  | Confirm pattern       | `confirm.tsx`       | done   | dedicated destructive confirmation dialog                                                         |
| 17  | Navigation shell      | `nav-shell.tsx`     | done   | desktop sidebar + collapsible, topbar, mobile drawer + bottom nav                                 |
| 18  | KPI card              | `kpi-card.tsx`      | done   | label, value (via `<Money compact>`), delta, footnote                                             |
| 19  | Money formatter       | `money.tsx`         | done   | presentational wrapper on `lib/money` with tabular-nums, compact w/ tooltip, variants             |

Supporting utilities: `icons.tsx` (hand-tuned SVG set, all `aria-hidden` by
default), `index.ts` barrel.

## 11. Templates (M1)

Reusable page scaffolds in `components/template/`:

- **`CommandCenter`** — welcome block, 5-up KPI grid, Quick actions, Needs
  attention list (status dots), Recent activity feed, tabular-nums on totals.
  Filled with explicitly-labeled demo data; no live data or fake metrics
  presented as real.
- **`ListPage`** — page header + description, primary action, tabs/filters,
  desktop table + mobile card list (responsive), empty/loading/error slots.
- **`DetailPage`** — title + status badge + action buttons, summary strip
  (BILLED/PAID/OUTSTANDING/DUE/STATUS key-value), meta (billed-to / term &
  delivery) columns, tabbed content (Line items / Payments / Activity),
  optional audit trail. Caller provides action buttons; the template never
  auto-appends a Print button (caller passes one explicitly).

## 12. Navigation shell

`components/ui/nav-shell.tsx` provides the `NavShell` component accepted by
every app page (wrapped at the route-group level in future slices). M1 demo
routes wrap themselves inline because the app has no route groups yet.

Layout behavior:

- **Desktop (≥1024px / `lg`):** 248px left sidebar (emerald) with brand,
  workspace label, primary/operations/settings sections, collapse toggle.
  Collapsed state = 72px icon rail. Topbar contains search, notifications,
  user menu. Content area is padded left by the sidebar width (`pl-sidebar`),
  never underlaps.
- **Tablet (640–1023px):** Sidebar hidden behind a hamburger-triggered drawer;
  topbar visible; KPIs collapse from 5-up to 2+3 grid; tables remain
  horizontally scrollable.
- **Mobile (<640px):** Topbar with hamburger + avatar; bottom nav (4 primary
  destinations); lists render as cards (not tables), tabs become horizontally
  scrollable segments.

All navigation items use semantic text + icons (no icon-only mystery buttons
except when the sidebar is collapsed, where tooltip labels appear on hover).

## 13. Responsive breakpoints

| Breakpoint | Tailwind     | Used for                                         |
| ---------- | ------------ | ------------------------------------------------ |
| Small      | `sm` ≥640px  | larger phones, small tablets (card/table switch) |
| Medium     | `md` ≥768px  | tablet layout                                    |
| Large      | `lg` ≥1024px | permanent sidebar; full KPI grid                 |
| XL         | `xl` ≥1280px | content max-width cap                            |

## 14. Print

Print stylesheet in `globals.css`:

- Hides `.no-print` (navigation, CTAs, dialogs, toasts, footers).
- Reveals `.print-header` (school letterhead strip with name/term/contact).
- Forces white backgrounds and ink-900 text for reliable B/W printing.
- `page-break-inside: avoid` on rows and blocks marked `.avoid-break`; explicit
  `.page-break` utility.

The print view is intended for invoices and receipts; the detail-page template
supplies semantic tables that print cleanly.

## 15. Demo showcase routes

All in `app/preview/`:

| Route                                        | What it demonstrates                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `/` → redirects to `/preview/command-center` | Default landing (redirect for M1 demo)                              |
| `/preview/command-center`                    | NavShell + CommandCenter template                                   |
| `/preview/list/[slug]`                       | ListPage — invoices/students/payments demo data                     |
| `/preview/invoice/[id]`                      | DetailPage — invoice INV-1042 with summary/meta/line-items/activity |
| `/preview/primitives`                        | Tabbed showcase of every primitive + tokens/typography              |

Demo data is hard-coded and labelled "DEMO" — never to be mistaken for live
state.

## 16. Conventions future slices must follow

1. **Never use a hex color in JSX.** Reach for a semantic token via Tailwind
   (`bg-surface`, `text-danger-fg`, `border-subtle`, etc.); if no token fits,
   extend `tokens.css` + `tailwind.config.ts` semantically, not ad-hoc.
2. **All money goes through `<Money />`** (or `lib/money` formatters server-side)
   — never hand-format currency, never pass floats.
3. **Tables vs cards:** use `<Table>` at `lg`+; the ListPage template handles the
   mobile card conversion automatically.
4. **Status indicators** (paid/overdue/sent/etc.) always combine a colored badge
   with a status dot and a text label so they are legible without color.
5. **Focus:** do not override outline on interactive elements; if you set
   `outline-none`, you must provide an equivalent `ring-focus` style.
6. **Icons inside buttons** are `aria-hidden`; the button must have visible text
   or an `aria-label`.
7. **Reduced motion:** respect `--motion-duration-*` tokens; don't add new long
   animations.
8. **Destructive actions** go through `<ConfirmDialog>` (the confirm pattern),
   never a single click.
9. **Page feedback** uses `<Alert>` for inline, `<Toast>` for transient,
   `<ErrorState>` for section/page failure, `<EmptyState>` for zero-data,
   `<Skeleton>` for pending.
10. **Print:** mark non-printable chrome `.no-print`; supply a `.print-header`
    for documents that must print on letterhead.

## 17. What M1 intentionally does NOT include

- PostgreSQL / Drizzle schema / migrations / `getDb()` calls
- Authentication / Supabase integration
- Multi-tenancy or authorization logic
- Real financial workflows (invoices/payments/allocations/reversals)
- Payment provider integration (Paystack webhooks, payment links APIs)
- Email/SMS sending
- Audit persistence
- Dark mode
- Internationalization beyond Naira/English

These arrive in M2 and later.
