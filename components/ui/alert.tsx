'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { AlertCircle, AlertTriangle, Check, Info, X } from './icons';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const variantStyles: Record<
  AlertVariant,
  {
    container: string;
    icon: React.ReactNode;
    iconColor: string;
  }
> = {
  info: {
    container: 'bg-info-bg border-info-fg/20 text-info-fg',
    icon: <Info size={18} />,
    iconColor: 'text-info-fg',
  },
  success: {
    container: 'bg-success-bg border-success-fg/20 text-success-fg',
    icon: <Check size={18} />,
    iconColor: 'text-success-fg',
  },
  warning: {
    container: 'bg-warning-bg border-warning-fg/20 text-warning-fg',
    icon: <AlertTriangle size={18} />,
    iconColor: 'text-warning-fg',
  },
  danger: {
    container: 'bg-danger-bg border-danger-fg/20 text-danger-fg',
    icon: <AlertCircle size={18} />,
    iconColor: 'text-danger-fg',
  },
  neutral: {
    container: 'bg-neutral-bg border-border text-ink-secondary',
    icon: <Info size={18} />,
    iconColor: 'text-ink-muted',
  },
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: AlertVariant;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
  action?: React.ReactNode;
}

/**
 * Inline alert / message (in-page, contextual).
 */
export function Alert({
  variant = 'info',
  title,
  icon,
  dismissible,
  onDismiss,
  action,
  className,
  children,
  ...rest
}: AlertProps) {
  const style = variantStyles[variant];
  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', style.container, className)}
      {...rest}
    >
      <span className={cn('mt-0.5 shrink-0', style.iconColor)} aria-hidden>
        {icon ?? style.icon}
      </span>
      <div className="min-w-0 flex-1">
        {title && <p className="mb-0.5 font-semibold leading-tight">{title}</p>}
        {children && <div className="text-[13px] leading-relaxed opacity-90">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {dismissible && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded-sm p-1 transition-colors hover:bg-black/5 focus-visible:shadow-focus-ring"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
