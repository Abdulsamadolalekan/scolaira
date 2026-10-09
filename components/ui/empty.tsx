import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Inbox } from './icons';
import { Button } from './button';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  actionLabel?: React.ReactNode;
  onAction?: () => void;
  className?: string;
  /** Used for demo/placeholder only — explicit marker that no real data is shown */
  isDemo?: boolean;
}

/**
 * Empty state. Line-art icon + title + one-line explanation + optional action.
 * Pass `isDemo` in M1 showcase to mark placeholder usage (per M1 instruction).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  actionLabel,
  onAction,
  className,
  isDemo,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-14 text-center',
        'border-t border-ink-faint',
        className,
      )}
      role="status"
    >
      {/* No dashed placeholder box and no circular icon chip: an empty register
          is stated in the same voice as a full one, quietly, on the same paper. */}
      <div className="mb-3 text-ink-subtle" aria-hidden>
        {icon ?? <Inbox size={20} />}
      </div>
      <h3 className="mb-1 text-[15px] font-medium text-ink-secondary">{title}</h3>
      {description && (
        <p className="max-w-md text-xs leading-relaxed text-ink-muted">{description}</p>
      )}
      {(actionLabel || action) && (
        <div className="mt-4">
          {action ?? (
            <Button size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </div>
      )}
      {isDemo && (
        <p className="mt-4 text-2xs uppercase tracking-wider text-ink-muted">
          Demo placeholder — no real data
        </p>
      )}
    </div>
  );
}
