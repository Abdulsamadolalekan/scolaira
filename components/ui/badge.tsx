import * as React from 'react';
import { cn } from '@/lib/utils/cn';

export type BadgeVariant =
  'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'gold' | 'forest';

/**
 * Variant treatment.
 *
 * VISUAL POLISH PASS (2026-10) — a status is not a pill.
 *
 * The previous treatment filled every state with its own tint: a green pill, an
 * amber pill, a blue pill, a grey pill, each with a coloured dot inside it. A
 * register of forty rows therefore showed forty filled chips, and the eye read
 * the colour blocks before it read the money — which is the most recognisable
 * trait of a generated dashboard, and the opposite of a ledger, where the figure
 * is the subject and the state is a footnote to it.
 *
 * Status is now carried by INK rather than by fill: a small dot, and the label
 * set in the semantic colour on the page's own paper. Nothing is boxed, so
 * nothing shouts, and the column of figures keeps its authority.
 *
 * Colour is never the only signal — the label always names the state — so the
 * treatment survives greyscale, print, and colour-blind readers.
 *
 * One exception is deliberate. `danger` keeps a tint and a hairline: in a
 * financial register exactly one class of row deserves to be marked, the one
 * that is overdue or rejected, and giving that single variant a surface is what
 * makes the other four read as quiet instead of unfinished. `gold` and `forest`
 * are outlined because they are marks of record rather than states — they name
 * what something is (a receipt, a permitted action), not how it is going.
 *
 * The gold variant is set in --color-gold-dark, not the brighter --color-gold-rich
 * it used before. Gold reference on ivory measures about 2.2:1, well under the
 * 4.5:1 needed for 11px text; the darker ink keeps the same hue family and
 * becomes readable.
 */
const variantClasses: Record<BadgeVariant, string> = {
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg border-[color:var(--color-danger-fg)]/25 px-1.5 py-0.5',
  info: 'text-info-fg',
  neutral: 'text-neutral-fg',
  gold: 'text-[color:var(--color-gold-dark)] border-[color:var(--color-gold-rich)]/45 px-1.5 py-0.5',
  forest: 'text-forest-deep border-[color:var(--color-forest-primary)]/30 px-1.5 py-0.5',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Optional leading icon/element (e.g. dot, check). */
  icon?: React.ReactNode;
}

/**
 * Status chip / badge.
 *
 * Badges are always coupled with a text label (never colour-only) per the design
 * system plan. The dot is redundant visual coding on top of the label, never a
 * substitute for it.
 */
export function Badge({ className, variant = 'neutral', icon, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        'rounded-sm border border-transparent',
        'text-[11px] font-medium leading-4',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {icon ?? (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotColor(variant))} aria-hidden />
      )}
      <span>{children}</span>
    </span>
  );
}

function dotColor(variant: BadgeVariant): string {
  switch (variant) {
    case 'success':
      return 'bg-success-fg';
    case 'warning':
      return 'bg-warning-fg';
    case 'danger':
      return 'bg-danger-fg';
    case 'info':
      return 'bg-info-fg';
    case 'gold':
      return 'bg-gold-rich';
    case 'forest':
      return 'bg-forest-primary';
    default:
      return 'bg-ink-muted';
  }
}

/** Status dot with no text — only use next to a labelled element. */
export function StatusDot({ variant = 'neutral' }: { variant?: BadgeVariant }) {
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full', dotColor(variant))} aria-hidden />
  );
}
