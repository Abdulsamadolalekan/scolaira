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
  /**
   * Render in the tabular mono face. Defaults to true for the figure sizes
   * (lg/xl/display): money is read as a shape before it is read as a string,
   * and proportional digits make columns of figures impossible to compare.
   * Body-size money (sm/md) stays in the UI sans so it can sit inside prose.
   */
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'display';
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
  mono,
  size = 'md',
  className,
  ...rest
}: MoneyProps) {
  /*
   * The figure face.
   *
   * Money is set in the UI sans with TABULAR figures rather than in the
   * monospace face. Two reasons, both measured:
   *   1. JetBrains Mono draws a slashed/dotted zero. In a ledger a zero and an
   *      eight must never be confusable, but ₦700,000.00 rendered as
   *      ₦7ΘΘ,ΘΘΘ.ΘΘ reads as a code sample rather than as money.
   *   2. Institutional practice (the private-bank references) sets figures in
   *      the brand's own face with tabular lining numerals, and reserves the
   *      monospace for identifiers. Passing `mono` still opts in for the rare
   *      case that wants it (references, codes, hex).
   * `tabular-nums` is what makes columns of money line up.
   */
  const useMono = mono ?? false;
  const full = formatKoboFull(kobo, showSymbol, hideDecimals);
  const display = compact ? formatKoboCompact(kobo, showSymbol) : full;
  const sizeClass = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-figure font-medium',
    xl: 'text-figure-lg font-normal',
    display: 'text-figure-xl font-normal',
  }[size];

  const node = (
    <span
      className={cn(
        'tabular-nums',
        useMono ? 'font-mono' : 'font-sans',
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
