import * as React from 'react';
import { cn } from '@/lib/utils/cn';

export type BadgeVariant =
  'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'gold' | 'forest';

const variantClasses: Record<BadgeVariant, string> = {
  success: 'bg-success-bg text-success-fg',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
  gold: 'bg-gold-tint text-ink-deepest',
  forest: 'bg-forest-tint text-forest-deepest',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Optional leading icon/element (e.g. dot, check). */
  icon?: React.ReactNode;
}

/**
 * Status chip / badge.
 *
 * Badges are always coupled with a text label (never color-only) per the design
 * system plan. Optionally include an icon for redundant visual status coding.
 */
export function Badge({ className, variant = 'neutral', icon, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5',
        'whitespace-nowrap text-xs font-medium leading-5',
        'border border-transparent',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {icon ?? <span className={cn('h-1.5 w-1.5 rounded-full', dotColor(variant))} aria-hidden />}
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
