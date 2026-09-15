'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Loader } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'destructive' | 'gold';

export type ButtonSize = 'sm' | 'md' | 'lg';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-forest-primary text-white hover:bg-forest-accent active:bg-forest-deep shadow-xs disabled:bg-ink-subtle disabled:text-white disabled:shadow-none',
  secondary:
    'bg-white text-ink-primary border border-border-strong hover:bg-surface-subtle active:bg-forest-wash disabled:text-ink-muted disabled:border-border',
  tertiary:
    'bg-transparent text-forest-primary hover:bg-forest-wash active:bg-forest-tint disabled:text-ink-muted',
  ghost:
    'bg-transparent text-ink-secondary hover:bg-surface-subtle hover:text-ink-primary active:bg-forest-wash disabled:text-ink-muted',
  destructive:
    'bg-white text-danger-fg border border-danger-fg/40 hover:bg-danger-bg active:bg-danger-fg active:text-white disabled:text-ink-muted disabled:border-border',
  gold: 'bg-gold-rich text-ink-deepest hover:bg-gold-reference active:bg-gold-rich/90 shadow-xs disabled:bg-ink-subtle disabled:text-white disabled:shadow-none',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-base gap-2 rounded',
  lg: 'h-12 px-6 text-md gap-2 rounded-lg font-medium',
};

const baseClasses =
  'inline-flex items-center justify-center whitespace-nowrap rounded font-medium transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring disabled:cursor-not-allowed select-none [&>svg]:shrink-0';

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
