import Link from 'next/link';
import * as React from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * PageHeader — the institutional statement that opens every surface.
 *
 * WHY THIS EXISTS
 *   Before the redesign, twenty-odd pages hand-rolled their own title block:
 *   an h1 in the wrong face at the wrong size, a muted paragraph, sometimes an
 *   eyebrow — and five different container widths between them. Because each
 *   page decided for itself, no two were quite alike, and the product read as
 *   twenty pages rather than as one system.
 *
 *   This is one component, used everywhere, so that "where am I, what am I
 *   looking at, what can I do here" is answered identically on all surfaces —
 *   which is what makes a set of screens read as one product.
 *
 * COMPOSITION
 *   breadcrumbs — the path back on a detail surface ("Invoices · INV-2026-0004").
 *                 Renders ABOVE everything else and replaces the ad-hoc
 *                 back-links pages used to draw for themselves.
 *   eyebrow     — quiet, small-caps context (term, module, register)
 *   title       — the page title, in the product face (see app/fonts.ts)
 *   status      — a state badge that belongs to the title, not the body
 *   lede        — one sentence: what this surface is for, or how to read it
 *   actions     — the actions that belong to the surface as a whole
 *   meta        — a row of facts (totals, scope, dates)
 *   tabs        — sub-navigation for a surface with sibling views
 *
 * A rule closes the header. Structure is drawn, not boxed.
 *
 * SCALE
 *   'md' is the default. 'lg' is for the two surfaces that carry the most
 *   weight; 'sm' for nested or secondary surfaces.
 */
export interface PageHeaderProps {
  /** Path back to the parent register, on detail surfaces. */
  breadcrumbs?: React.ReactNode;
  /** Small-caps context line — term, module, register name. */
  eyebrow?: React.ReactNode;
  /** The page title. */
  title: React.ReactNode;
  /** A state badge that belongs beside the title. */
  status?: React.ReactNode;
  /** One sentence of orientation. */
  lede?: React.ReactNode;
  /** Surface-level actions (buttons, links). */
  actions?: React.ReactNode;
  /** A row of facts beneath the lede (totals, scope, dates). */
  meta?: React.ReactNode;
  /** Sub-navigation for a surface with sibling views. */
  tabs?: React.ReactNode;
  /** Use the larger display size for the few surfaces that carry the most weight. */
  scale?: 'sm' | 'md' | 'lg';
  /** For identifier titles (invoice/payment numbers) that should align on digits. */
  titleClassName?: string;
  className?: string;
}

export function PageHeader({
  breadcrumbs,
  eyebrow,
  title,
  status,
  lede,
  actions,
  meta,
  tabs,
  scale = 'md',
  titleClassName,
  className,
}: PageHeaderProps) {
  const titleSize = {
    sm: 'text-display-sm',
    md: 'text-display-md',
    lg: 'text-display-lg',
  }[scale];

  return (
    <header className={cn('mb-6 sm:mb-8', className)}>
      {breadcrumbs ? <div className="mb-3">{breadcrumbs}</div> : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0">
          {/* Status sits with the eyebrow when both are present: context first,
              then state, then the name of the thing. */}
          {(status || eyebrow) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {eyebrow ? (
                <p className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">
                  {eyebrow}
                </p>
              ) : null}
              {status}
            </div>
          )}

          <h1
            className={cn(titleSize, 'font-semibold text-forest-deepest', titleClassName)}
            style={{ fontFamily: 'var(--font-sans)' }}
          >
            {title}
          </h1>

          {lede ? (
            <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-ink-muted">{lede}</p>
          ) : null}
        </div>

        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {meta ? <div className="mt-4">{meta}</div> : null}

      <div className="mt-5 border-t border-ink-faint" role="presentation" />

      {tabs ? <div className="mt-3">{tabs}</div> : null}
    </header>
  );
}

/**
 * Container widths — three, deliberately — and no more.
 *
 * Five widths were in use across the product (1500 / 1280 / 1180 / 1152 / 1024)
 * plus eight pages with none at all. That is not a system; it is drift. A reader
 * moving from the payments register to a payment detail should not feel the
 * page change shape underneath them.
 *
 *   narrow   — a single-column form: a measure you can fill in without
 *              losing your place. Deliberately narrower than a page.
 *   standard — detail surfaces, settings. A readable measure.
 *   wide     — registers and the workbench. Dense financial tables need room.
 */
export const PAGE_WIDTH = {
  narrow: 'max-w-2xl',
  standard: 'max-w-6xl',
  wide: 'max-w-[1400px]',
} as const;

export function PageContainer({
  width = 'standard',
  className,
  children,
}: {
  width?: keyof typeof PAGE_WIDTH;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        PAGE_WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Crumb — the path back on a detail surface.
 *
 * The reference sets this as a single quiet line ("Invoices · Chisom Mohammed ·
 * INV-2026-00528") rather than a stack of chevrons. One line, middle dots, the
 * current item at the end. It answers "where am I" without becoming furniture.
 */
export function Crumb({
  parent,
  parentHref,
  trail,
}: {
  parent: string;
  parentHref: string;
  trail?: React.ReactNode;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
    >
      <Link
        href={parentHref}
        className="font-medium underline-offset-4 transition-colors hover:underline"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {parent}
      </Link>
      {trail ? (
        <>
          <span aria-hidden="true" style={{ color: 'var(--color-text-muted)' }}>
            ·
          </span>
          <span style={{ color: 'var(--color-text-secondary)' }}>{trail}</span>
        </>
      ) : null}
    </nav>
  );
}

/**
 * SectionHead — a named block inside a page.
 *
 * Carries an optional count and an optional hint (how to read the block). The
 * count sits at the end of the rule rather than in a badge, so the eye travels
 * title → rule → figures without stopping.
 */
export function SectionHead({
  title,
  hint,
  count,
  actions,
  className,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  count?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 pb-2', className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-forest-deep">
          {title}
        </h2>
        {hint ? (
          <span className="hidden truncate text-xs text-ink-muted sm:inline">{hint}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-baseline gap-3">
        {count ? <span className="text-xs tabular-nums text-ink-muted">{count}</span> : null}
        {actions}
      </div>
    </div>
  );
}
