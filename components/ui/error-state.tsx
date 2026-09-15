import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { AlertTriangle } from './icons';
import { Button } from './button';

export interface ErrorStateProps {
  title?: React.ReactNode;
  message?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Compact inline variant (no big icon) */
  inline?: boolean;
}

/**
 * Full-page / section error state.
 * - Clear explanation
 * - Actionable next step
 * - Retry where applicable
 */
export function ErrorState({
  title = 'Something went wrong',
  message = 'We couldn’t load this content. Check your connection and try again.',
  onRetry,
  retryLabel = 'Try again',
  action,
  className,
  inline,
}: ErrorStateProps) {
  if (inline) {
    return (
      <div
        role="alert"
        className={cn(
          'border-danger-fg/30 flex items-start gap-2 rounded border bg-danger-bg p-3 text-sm text-danger-fg',
          className,
        )}
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-medium">{title}</p>
          <p className="text-danger-fg/80">{message}</p>
          {(onRetry || action) && (
            <div className="mt-2">
              {action ?? (
                <Button size="sm" variant="destructive" onClick={onRetry}>
                  {retryLabel}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center px-6 py-16 text-center',
        'border-danger-fg/20 rounded-lg border bg-white',
        className,
      )}
    >
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg text-danger-fg"
        aria-hidden
      >
        <AlertTriangle size={22} />
      </div>
      <h3 className="mb-1 text-md font-semibold text-ink-primary">{title}</h3>
      <p className="max-w-sm text-sm text-ink-muted">{message}</p>
      {(onRetry || action) && (
        <div className="mt-5">
          {action ?? (
            <Button variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
