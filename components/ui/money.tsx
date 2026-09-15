import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/**
 * Financial number formatter (presentation layer).
 *
 * Principles:
 *  - Consumes integer kobo (the canonical internal unit).
 *  - Never renders floats; formatting derived from split integer parts.
 *  - Always tabular-nums alignment.
 *  - Thousands separators, always ₦ prefix, always .00 precision.
 *  - Right-aligned in table contexts (handled by `numeric` in TableCell).
 *  - Compact notation (₦43.4M) for KPI cards where full precision is not
 *    primary; tooltip reveals the full amount on hover/focus.
 *  - States (billed/collected/outstanding/overdue/unreconciled) are visual
 *    via variant color BUT are also ALWAYS accompanied by a label/badge
 *    in the consuming component — never color-only status.
 */

export type MoneyVariant = 'default' | 'positive' | 'negative' | 'muted' | 'overdue';

const variantColor: Record<MoneyVariant, string> = {
  default: 'text-ink-primary',
  positive: 'text-success-fg',
  negative: 'text-danger-fg',
  muted: 'text-ink-muted',
  overdue: 'text-danger-fg',
};

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Amount in kobo (integer, canonical unit). */
  kobo: number;
  /** Display variant for semantic color. */
  variant?: MoneyVariant;
  /** Compact notation (₦43.4M instead of full value). Use for summaries/KPI. */
  compact?: boolean;
  /** Show the ₦ symbol (default true). */
  showSymbol?: boolean;
  /** Omit decimals (only for large KPI displays). */
  hideDecimals?: boolean;
  /** Id reference for accessible labelling (aria-labelledby). */
  labelledBy?: string;
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

/**
 * Formats kobo into full Naira string: "₦43,400,000.00".
 * Exported as pure util for non-JSX contexts.
 */
export function formatKoboFull(kobo: number, showSymbol = true, hideDecimals = false): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(kobo));
  const naira = Math.floor(abs / 100);
  const koboPart = abs % 100;
  const nairaStr = naira.toLocaleString('en-NG');
  const dec = hideDecimals ? '' : `.${koboPart.toString().padStart(2, '0')}`;
  return `${sign}${showSymbol ? '₦' : ''}${nairaStr}${dec}`;
}

/**
 * Compact Naira formatting: ₦43.4M, ₦1.2B, ₦450K.
 */
export function formatKoboCompact(kobo: number, showSymbol = true): string {
  const abs = Math.abs(kobo);
  const sign = kobo < 0 ? '-' : '';
  const sym = showSymbol ? '₦' : '';
  if (abs >= 1e14) return `${sign}${sym}${(abs / 1e14).toFixed(1)}T`; // 1e14 kobo = 1T naira
  if (abs >= 1e11) return `${sign}${sym}${(abs / 1e11).toFixed(1)}B`; // 1e11 kobo = 1B naira
  if (abs >= 1e8) return `${sign}${sym}${(abs / 1e8).toFixed(1)}M`; // 1e8 kobo = 1M naira
  if (abs >= 1e5) return `${sign}${sym}${(abs / 1e5).toFixed(0)}K`; // 1e5 kobo = 1K naira
  return formatKoboFull(kobo, showSymbol, true);
}

/**
 * <Money /> — presentational component for all money values in SCOLAIRA.
 */
export function Money({
  kobo,
  variant = 'default',
  compact = false,
  showSymbol = true,
  hideDecimals = false,
  labelledBy,
  mono = false,
  size = 'md',
  className,
  ...rest
}: MoneyProps) {
  const full = formatKoboFull(kobo, showSymbol, hideDecimals);
  const display = compact ? formatKoboCompact(kobo, showSymbol) : full;
  const sizeClass = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg font-semibold',
    xl: 'text-2xl font-semibold',
  }[size];

  const node = (
    <span
      className={cn(
        'font-feature-tnum tabular-nums',
        mono ? 'font-mono' : 'font-sans',
        variantColor[variant],
        sizeClass,
        className,
      )}
      data-money
      aria-labelledby={labelledBy}
      {...rest}
    >
      {display}
    </span>
  );

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default rounded-sm focus-visible:shadow-focus-ring">
            {node}
          </span>
        </TooltipTrigger>
        <TooltipContent>{full}</TooltipContent>
      </Tooltip>
    );
  }
  return node;
}
