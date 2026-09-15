'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { TrendDown, TrendUp } from './icons';
import { Money } from './money';

export type KpiDeltaDirection = 'up' | 'down' | 'flat';
export type KpiDeltaTone = 'positive' | 'negative' | 'neutral' | 'warning';

export interface KpiCardProps {
  label: React.ReactNode;
  /** Value as string (for counts, percentages) or kobo for money. */
  value?: string | number;
  /** Set to treat `value` as kobo and render via Money component. */
  valueIsMoney?: boolean;
  /** Compact KPI number (₦43.4M) — tooltip reveals full amount. */
  compact?: boolean;
  delta?: string;
  deltaDirection?: KpiDeltaDirection;
  deltaTone?: KpiDeltaTone;
  /** Optional small context line (e.g. "vs last term"). */
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  /** Explicit demo placeholder marker */
  isDemo?: boolean;
}

/**
 * KPI card — large tabular number, small label, optional delta ↑/↓, no chart junk.
 */
export function KpiCard({
  label,
  value,
  valueIsMoney = false,
  compact = false,
  delta,
  deltaDirection,
  deltaTone = 'neutral',
  hint,
  icon,
  onClick,
  className,
  isDemo,
}: KpiCardProps) {
  const clickable = !!onClick;
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-border bg-white p-5 shadow-xs',
        clickable &&
          'cursor-pointer transition-shadow hover:shadow-sm focus-visible:shadow-focus-ring',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
        {icon && (
          <span className="text-ink-muted" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        {valueIsMoney && typeof value === 'number' ? (
          <Money kobo={value} size="xl" compact={compact} />
        ) : (
          <span className="kpi-value text-2xl font-semibold tabular-nums text-ink-deepest">
            {value ?? '—'}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {delta && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              deltaTone === 'positive' && 'text-success-fg',
              deltaTone === 'negative' && 'text-danger-fg',
              deltaTone === 'neutral' && 'text-ink-muted',
            )}
          >
            {deltaDirection === 'up' ? (
              <TrendUp size={12} aria-hidden />
            ) : deltaDirection === 'down' ? (
              <TrendDown size={12} aria-hidden />
            ) : null}
            {delta}
          </span>
        )}
        {hint && <span className="text-ink-muted">{hint}</span>}
      </div>
      {isDemo && (
        <p className="mt-2 text-2xs uppercase tracking-wider text-ink-subtle">Demo placeholder</p>
      )}
    </div>
  );
}
