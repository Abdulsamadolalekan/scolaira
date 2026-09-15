'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '@/lib/utils/cn';
import { AlertTriangle, Trash } from './icons';
import { Button, type ButtonVariant } from './button';

/**
 * Confirmation pattern, especially for destructive actions (reverse, void,
 * revoke, delete). Destructive buttons must label the action explicitly
 * (never "OK"), state consequences, and optionally request a reason.
 */

export const ConfirmDialog = AlertDialogPrimitive.Root;
export const ConfirmDialogTrigger = AlertDialogPrimitive.Trigger;

export interface ConfirmDialogContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>,
  'title' | 'asChild'
> {
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  confirmVariant?: ButtonVariant;
  destructive?: boolean;
  icon?: React.ReactNode;
  /** Optional reason / justification field (e.g. for reversals) */
  requireReason?: boolean;
  reasonPlaceholder?: string;
  onConfirm?: (reason?: string) => void | Promise<void>;
  loading?: boolean;
}

export function ConfirmDialogContent({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant,
  destructive = false,
  icon,
  requireReason = false,
  reasonPlaceholder = 'Reason (optional)',
  onConfirm,
  loading,
  className,
  children,
  ...props
}: ConfirmDialogContentProps) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const busy = loading || submitting;
  const canConfirm = !requireReason || reason.trim().length > 0;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm?.(requireReason ? reason.trim() : undefined);
    } finally {
      setSubmitting(false);
      setReason('');
    }
  };

  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        className={cn('fixed inset-0 z-50 bg-[color:var(--color-overlay)]')}
      />
      <AlertDialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-xl bg-white p-6 shadow-lg focus:outline-none',
          className,
        )}
        {...props}
      >
        <div className="flex gap-4">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              destructive ? 'bg-danger-bg text-danger-fg' : 'bg-gold-tint text-gold-rich',
            )}
            aria-hidden
          >
            {icon ?? (destructive ? <AlertTriangle size={18} /> : <AlertTriangle size={18} />)}
          </div>
          <div className="flex-1">
            <AlertDialogPrimitive.Title asChild>
              <h2 className="text-lg font-semibold leading-tight text-ink-primary">{title}</h2>
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">{description}</p>
            </AlertDialogPrimitive.Description>

            {requireReason && (
              <div className="mt-4">
                <label className="text-sm font-medium text-ink-primary" htmlFor="confirm-reason">
                  Reason{!reasonPlaceholder.toLowerCase().includes('optional') && ' *'}
                </label>
                <textarea
                  id="confirm-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder={reasonPlaceholder}
                  className={cn(
                    'mt-1.5 w-full rounded border border-border-strong bg-white px-3 py-2 text-sm',
                    'resize-y text-ink-primary outline-none',
                    'focus:border-border-focus focus:shadow-focus-ring',
                  )}
                />
              </div>
            )}

            {children}

            <div className="mt-6 flex justify-end gap-2">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="secondary" disabled={busy}>
                  {cancelLabel}
                </Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button
                  variant={confirmVariant ?? (destructive ? 'destructive' : 'primary')}
                  loading={busy}
                  disabled={!canConfirm || busy}
                  onClick={handleConfirm}
                  iconLeft={destructive ? <Trash size={14} /> : undefined}
                >
                  {confirmLabel}
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </div>
        </div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}
