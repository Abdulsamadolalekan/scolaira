# SCOLAIRA Design System Plan

> Create a real design system foundation before building many screens.
> Components are built from centralized tokens; screens never hard-code hex values, spacing, or radii.

---

## I. Philosophy

- **Tokens before screens.** All visual language is defined in a single token layer. Screens compose components; components consume tokens.
- **Premier financial feel.** Deep emerald + gold accent + warm ivory + near-black. Private bank × distinguished school.
- **Restraint over decoration.** Gold is an accent. Gradients and heavy shadows are avoided. Density is appropriate for operational work.
- **Tabular numerics for money.** Every number that is money uses tabular-nums alignment.
- **Accessibility baked in.** Color contrast ratios ≥4.5:1 for body text (≥3:1 for large), focus rings, semantic HTML, labelled inputs, touch targets ≥44px on mobile.
- **Final palette is NOT hard-coded yet.** Tokens use semantic names (`--color-forest-deep`, `--color-gold-rich`, etc.) mapped to the interim palette from founder references; when final brand system arrives, we swap the hex values without touching components.

## II. Token Layer (to be implemented in M1)

### A. Color Tokens

```ts
// Brand primitives (derived from founder-provided references; INTERIM, not final)
--color-forest-deepest:  #0B3D2E;  // refined deep emerald
--color-forest-deep:     #1B4332;  // forest reference
--color-forest-primary:  #046A38;  // interim brand primary, pending final
--color-forest-accent:   #2F8F5C;  // active/link states
--color-forest-tint:     #EAF4EE;  // selected rows / success bg

--color-gold-rich:       #C9A227;  // refined gold
--color-gold-reference:  #D4AF37;  // reference gold
--color-gold-tint:       #F5EEDC;  // premium subtle surface

--color-ivory:           #FDFBF6;  // warm page background
--color-white:           #FFFFFF;  // cards/surfaces

--color-ink-deepest:     #17201C;  // near-black text
--color-ink-primary:     #0B1F16;  // primary text (may alias to deepest)
--color-ink-secondary:   #25372D;  // secondary text
--color-ink-muted:       #5C6B64;  // tertiary / labels
--color-ink-subtle:      #B7C0BB;  // dividers
--color-ink-faint:       #E6EAE7;  // hairlines

// Semantic colors (mapped from primitives; used by components)
--color-bg-page:         var(--color-ivory);
--color-bg-surface:      var(--color-white);
--color-text-primary:    var(--color-ink-deepest);
--color-text-secondary:  var(--color-ink-secondary);
--color-text-muted:      var(--color-ink-muted);
--color-accent-primary:  var(--color-forest-primary);
--color-accent-gold:     var(--color-gold-rich);
--color-border:          var(--color-ink-faint);
--color-border-strong:   var(--color-ink-subtle);

// Status semantic (muted backgrounds + accessible foregrounds)
--color-success-fg:      #1B5E20;  // 4.5+:1 on white; derived/green
--color-success-bg:      var(--color-forest-tint);
--color-warning-fg:      #8A5A00;  // amber; 4.5+:1
--color-warning-bg:      #FEF4E1;
--color-danger-fg:       #B42318;  // red; not neon
--color-danger-bg:       #FDECEC;
--color-info-fg:         #1E5A8B;
--color-info-bg:         #E8F1F8;
```

> **Interim status:** The above primitive hex codes draw from the founder-provided references (`#1B4332`, `#D4AF37`, `#FDFBF6`, `#17201C` and `#0B3D2E`, `#C9A227`). They are NOT final. Tokens allow the final brand system to swap values without component changes.

### B. Typography Scale

```ts
--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, monospace;  // only for code/id displays

// Sizes (px values, rem units in code)
--text-xs: 12px/1.5;    // captions, labels
--text-sm: 13px/1.5;    // table text, small body
--text-base: 14px/1.55; // body
--text-md: 16px/1.5;    // section body, larger text
--text-lg: 18px/1.35;   // section headings
--text-xl: 20px/1.3;    // page titles (on mobile)
--text-2xl: 24px/1.25;  // page titles (desktop)
--text-3xl: 30px/1.2;   // KPI value small
--text-4xl: 36px/1.15;  // KPI value primary
--text-5xl: 48px/1.1;   // hero amount on parent payment page

--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;    // used sparingly
```

All money values use `font-variant-numeric: tabular-nums;` (and `font-feature-settings: 'tnum' 1;`).

### C. Spacing (4px grid)

```ts
--space-0: 0;
--space-1: 4px;   // compact
--space-2: 8px;
--space-3: 12px;  // default inside fields/cells
--space-4: 16px;  // card padding base
--space-5: 20px;
--space-6: 24px;  // card padding
--space-8: 32px;
--space-10: 40px;
--space-12: 48px; // section spacing
--space-16: 64px; // page
--space-20: 80px; // large section
```

### D. Radii

```ts
--radius-sm: 2px;   // tiny surfaces, badges
--radius-md: 4px;   // inputs, buttons (default)
--radius-lg: 6px;   // cards (subtle)
--radius-xl: 8px;   // dialogs, larger cards
// NO pill-radii (24px+). No rounded 16px buttons.
```

### E. Shadows (Restrained)

```ts
--shadow-xs: 0 1px 2px rgba(11,31,22,0.04);       // card resting
--shadow-sm: 0 1px 3px rgba(11,31,22,0.06), 0 1px 2px rgba(11,31,22,0.04); // raised
--shadow-md: 0 4px 8px rgba(11,31,22,0.06);       // dialog/popover
--shadow-lg: 0 12px 24px rgba(11,31,22,0.10);     // modal
// No colored glows; no gold shadows; no long multi-layer shadows.
```

### F. Borders

```ts
--border-thin: 1px solid var(--color-border);
--border-strong: 1px solid var(--color-border-strong);
--border-focus: 2px solid var(--color-accent-primary);
--border-danger: 1px solid var(--color-danger-fg);
```

### G. Motion (Minimal)

```ts
--duration-fast: 100ms;
--duration-base: 180ms;
--easing-standard: cubic-bezier(0.2, 0, 0, 1);
// Motion used for subtle feedback (hover, focus, toast in/out); no decorative animation.
// Respect prefers-reduced-motion: disable all non-essential transitions.
```

## III. Core Primitives (Components to Build in M1)

Before any feature screen:

1. **Button**
   - Variants: primary (forest), secondary (white + border), tertiary (text-link), destructive (red-outline or red-fill *only* on confirmation), ghost.
   - Sizes: sm (32px), md (40px — default), lg (48px — for parent Pay button).
   - States: default, hover, active, focus (visible ring), disabled, loading (spinner), destructive confirmation.
   - Icons allowed left/right; icon-only buttons always have aria-label.
   - Max one primary per section.

2. **Input / Textarea / Select**
   - 40px height; labels above; error text below; 4px focus ring; money inputs use right-aligned tabular-nums with ₦ prefix.
   - Support for help text, error states, disabled states, prefix/suffix.
   - Date picker accessible and mobile-friendly (native input where possible).

3. **Badge / Status Chip**
   - Semantic colors (success/green for PAID, warning/amber for PENDING/PARTIAL, danger/red for OVERDUE/REVERSED, muted/slate for DRAFT, gold accent for FLAGSHIP/HIGH-PRIORITY).
   - Small text; always combined with an icon or text label (never color-only).

4. **Checkbox / Radio / Switch**
   - Accessible; keyboard operable; clear labels.

5. **Dialog (Modal)**
   - Overlay, constrained width (sm/md/lg), header/body/footer, close button, focus trap, ESC to close, scroll lock.
   - Destructive confirmations restate the action and its consequences.

6. **Drawer**
   - Right-side sliding panel for secondary actions (filters, details, quick edits).

7. **Dropdown / Menu**
   - Action menus for row actions; keyboard navigable; properly positioned.

8. **Tooltip / Popover**
   - Used sparingly for clarifying truncation or explanations; accessible; delay appropriate.

9. **Table**
   - Header row, right-aligned numeric columns with tabular-nums, row hover, sort indicators, selectable rows, sticky header, empty state, loading skeleton, row actions menu.
   - Column density appropriate for 8-hour daily use.
   - On mobile, transforms to card list per UX principles.

10. **Tabs / Segmented Control**
    - For switching between lists (All / Unreconciled / Flagged, etc.).

11. **Alert / Inline Message**
    - info/success/warning/danger variants; clear title + body + optional action.

12. **Toast / Notification**
    - Success/error feedback; auto-dismiss; non-blocking.

13. **Empty State**
    - Icon (line-art, not cartoon), title, one-line explanation, primary action.

14. **Skeleton / Loading State**
    - Mimic shape of content (KPI cards, rows); no spinner-everywhere.

15. **Error State**
    - Clear explanation + actionable next step + retry where applicable.

16. **Confirm Pattern**
    - For destructive actions (reverse, void, revoke): dialog stating what is about to happen, consequences, reason field when required, clearly-labeled destructive button (never "OK" for destructive).

17. **Navigation Shell**
    - Sidebar (desktop): icon + label, current-section indicator (3px left forest border + tint bg), collapsible.
    - Mobile: bottom nav or drawer.
    - Top bar: org switcher (future), term switcher, user menu, notifications (simple dot for action count — no notification center in pilot).

18. **KPI Card**
    - Large tabular number, small label, optional delta (↑/↓ colored), no chart junk.

19. **Financial Number Formatter**
    - Central utility `formatKobo(k: number): { nairaString: string, html: JSX }` — uses the `--color-*` tokens for sign/state; always right-aligned in table contexts; displays `₦` prefix and thousands separators; supports decimal `.00` always; supports compact notation (₦43.4M) for summaries where precision is not required (with tooltip showing full amount).

## IV. Page Template Patterns

Before building screens, establish three page templates:

1. **List page template** (Students, Invoices, Payments): page title + primary action + filters/search + table + pagination/empty state.
2. **Detail page template** (Invoice detail, Payment detail, Student detail): summary header with status + key info; tabbed content sections; action bar; audit/events at bottom.
3. **Command Center template** (journey 1 priority): KPI hero + actions column + trends column (charts only if they answer a decision question).

## V. Print Styles

Receipts, invoices, and statements must print cleanly. A dedicated print stylesheet:
- Hides navigation, chrome, buttons.
- Uses white background, black/green text.
- Ensures page breaks at sensible boundaries (no page break in middle of a receipt).
- Adds school logo/address header.

## VI. Process

1. Build tokens in Tailwind config + CSS variables (M1).
2. Build each core primitive in order, with Storybook stories for visual testing.
3. Run accessibility audit on each primitive (axe + keyboard check).
4. Visual review by founder on primitives BEFORE building screens.
5. Build screens using only these primitives (no new hex codes in screen code).
6. E2E screenshots compared against baseline for regressions.

## VII. Brand Review Gate

Before launch (not pre-scaffolding), a formal brand review:
- Final palette approved/finalized.
- Typography confirmed.
- Logo/wordmark in place.
- Receipt/invoice print template approved.
- Sample screens (Command Center, Payment recording, Parent payment page, Receipt) approved.

Until then, the interim tokens are used consistently.
