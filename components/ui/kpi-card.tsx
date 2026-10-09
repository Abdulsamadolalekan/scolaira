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
 * Measure — one figure with its label and any delta.
 *
 * REDESIGN NOTE (2026-09)
 *   This was a rounded, bordered, shadowed card. Five of them in a row is the
 *   most recognisable template-dashboard gesture there is: every measure gets
 *   the same weight, and the eye is given boxes to read instead of figures to
 *   compare. It is now a ruled measure — a top hairline, a small-caps label, the
 *   figure in tabular sans — so a row of them reads as a single statement of the
 *   school's position rather than a set of cards. No radius, no border, no
 *   shadow, no fill; depth in this system comes from rules and paper.
 *
 *   The props are unchanged, so every existing caller keeps working and
 *   inherits the calmer treatment.
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
        'border-t border-ink-faint pt-3',
        clickable && 'cursor-pointer transition-colors hover:border-forest-primary',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{label}</p>
        {icon && (
          <span className="text-ink-subtle" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        {valueIsMoney && typeof value === 'number' ? (
          <Money kobo={value} size="lg" compact={compact} />
        ) : (
          <span className="kpi-value text-figure-lg tabular-nums text-forest-deepest">
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
