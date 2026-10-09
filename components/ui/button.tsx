'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Loader } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'destructive' | 'gold';

export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Button surface language (redesign 2026-09).
 *
 * Commitments are made in deep forest, not in bright green: a primary action
 * should look like the institution signing, not like a marketing CTA. There is
 * no drop shadow anywhere — depth in this system comes from rules and paper,
 * never from elevation. Gold appears only on the `gold` variant, which is
 * reserved for a confirming/committing act on a financial instrument.
 */
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-forest-deep text-ivory hover:brightness-110 active:brightness-95 disabled:bg-ink-subtle disabled:text-ivory',
  secondary:
    'bg-transparent text-ink-secondary border border-border-strong hover:border-ink-muted hover:text-forest-deepest active:bg-forest-wash disabled:text-ink-muted disabled:border-border',
  tertiary:
    'bg-transparent text-forest-primary hover:text-forest-deepest hover:bg-forest-wash active:bg-forest-tint disabled:text-ink-muted',
  ghost:
    'bg-transparent text-ink-secondary hover:bg-surface-subtle hover:text-ink-primary active:bg-forest-wash disabled:text-ink-muted',
  destructive:
    'bg-transparent text-danger-fg border border-danger-fg/40 hover:bg-danger-bg active:bg-danger-fg active:text-ivory disabled:text-ink-muted disabled:border-border',
  gold: 'bg-gold-rich text-forest-deepest hover:bg-gold-reference active:brightness-95 disabled:bg-ink-subtle disabled:text-ivory',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-sm',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-sm',
  lg: 'h-11 px-5 text-base gap-2 rounded-sm',
};

const baseClasses =
  'inline-flex items-center justify-center whitespace-nowrap rounded-sm font-medium transition-[background-color,border-color,color,filter] duration-fast ease-standard focus-visible:shadow-focus-ring disabled:cursor-not-allowed select-none [&>svg]:shrink-0';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      iconLeft,
      iconRight,
      fullWidth,
      disabled,
      children,
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-variant={variant}
        data-size={size}
        className={cn(
          baseClasses,
          variantClasses[variant],
          sizeClasses[size],
          fullWidth && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading ? <Loader size={size === 'sm' ? 14 : size === 'lg' ? 20 : 16} /> : iconLeft}
        {children && <span className="truncate">{children}</span>}
        {!loading && iconRight}
      </button>
    );
  },
);
Button.displayName = 'Button';
