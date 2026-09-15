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
        'flex flex-col items-center justify-center px-6 py-12 text-center',
        'rounded-lg border border-dashed border-border-strong bg-white',
        className,
      )}
      role="status"
    >
      <div
        className={cn(
          'flex h-12 w-12 items-center justify-center rounded-full',
          'mb-4 bg-forest-wash text-forest-primary',
        )}
        aria-hidden
      >
        {icon ?? <Inbox size={22} />}
      </div>
      <h3 className="mb-1 text-md font-semibold text-ink-primary">{title}</h3>
      {description && <p className="max-w-sm text-sm text-ink-muted">{description}</p>}
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
