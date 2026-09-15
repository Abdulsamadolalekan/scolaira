'use client';

import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cn } from '@/lib/utils/cn';
import { Check, AlertCircle, AlertTriangle, Info, X } from './icons';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/* -------------------------------------------------------------------------
 * Toast provider — wrap app once at root.
 * ----------------------------------------------------------------------- */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
      {children}
      <ToastViewport />
    </ToastPrimitive.Provider>
  );
}

function ToastViewport() {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        'fixed bottom-4 right-4 z-[100] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none',
      )}
    />
  );
}

/* -------------------------------------------------------------------------
 * Toast component
 * ----------------------------------------------------------------------- */
const variantIcon: Record<ToastVariant, React.ReactNode> = {
  success: <Check size={16} />,
  error: <AlertCircle size={16} />,
  warning: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};
const variantColor: Record<ToastVariant, string> = {
  success: 'text-success-fg',
  error: 'text-danger-fg',
  warning: 'text-warning-fg',
  info: 'text-info-fg',
};

export interface ToastProps extends Omit<
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>,
  'title'
> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  onClose?: () => void;
  action?: React.ReactNode;
}

export const Toast = React.forwardRef<React.ComponentRef<typeof ToastPrimitive.Root>, ToastProps>(
  (
    { className, title, description, variant = 'info', action, onClose, children, ...props },
    ref,
  ) => {
    return (
      <ToastPrimitive.Root
        ref={ref}
        className={cn(
          'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden',
          'rounded-lg border border-border bg-white p-4 shadow-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
          'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
          'data-[swipe=end]:animate-out data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
          'data-[state=open]:slide-in-from-right-full',
          'data-[state=closed]:slide-out-to-right-full',
          'duration-slow ease-standard',
          className,
        )}
        {...props}
      >
        <span className={cn('mt-0.5 shrink-0', variantColor[variant])} aria-hidden>
          {variantIcon[variant]}
        </span>
        <div className="min-w-0 flex-1">
          {title && (
            <ToastPrimitive.Title className="text-sm font-semibold leading-tight text-ink-primary">
              {title}
            </ToastPrimitive.Title>
          )}
          {(description || children) && (
            <ToastPrimitive.Description className="mt-0.5 text-sm leading-relaxed text-ink-secondary">
              {description ?? children}
            </ToastPrimitive.Description>
          )}
          {action && <div className="mt-2">{action}</div>}
        </div>
        <ToastPrimitive.Close
          onClick={onClose}
          aria-label="Dismiss notification"
          className={cn(
            'shrink-0 rounded-sm p-1 text-ink-muted transition-colors',
            'hover:bg-surface-subtle hover:text-ink-primary',
            'focus-visible:shadow-focus-ring',
          )}
        >
          <X size={14} />
        </ToastPrimitive.Close>
      </ToastPrimitive.Root>
    );
  },
);
Toast.displayName = 'Toast';

/* -------------------------------------------------------------------------
 * useToast — small imperative hook.
 * ----------------------------------------------------------------------- */
interface ToastItem {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  action?: React.ReactNode;
  duration?: number;
}

interface ToastCtx {
  toast: (t: Omit<ToastItem, 'id'>) => void;
}

const Ctx = React.createContext<ToastCtx | null>(null);

let _id = 0;

export function ToastContainer({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  const ctx = React.useMemo<ToastCtx>(
    () => ({
      toast: (t) => {
        const id = `t${++_id}`;
        setToasts((prev) => [...prev, { id, ...t }]);
      },
    }),
    [],
  );

  const close = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant ?? 'info'}
            title={t.title}
            description={t.description}
            action={t.action}
            duration={t.duration ?? 4000}
            onOpenChange={(open) => {
              if (!open) close(t.id);
            }}
          />
        ))}
        <ToastViewport />
      </ToastPrimitive.Provider>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    // Fallback no-op if provider not mounted — avoids crash in isolated tests.
    return { toast: () => {} };
  }
  return ctx;
}
