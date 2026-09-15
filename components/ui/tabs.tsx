'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils/cn';

/**
 * Tabs — for switching between list views (All / Unreconciled / Flagged, etc.).
 * Uses Radix for keyboard navigation (left/right, home/end).
 */

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex items-center gap-0 border-b border-border', 'gap-1', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { count?: number | string }
>(({ className, children, count, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'relative -mb-px inline-flex items-center gap-1.5 px-3 py-2.5',
      'text-sm font-medium text-ink-muted transition-colors',
      'hover:text-ink-primary',
      'rounded-sm outline-none focus-visible:shadow-focus-ring',
      'data-[state=active]:border-b-2 data-[state=active]:border-forest-primary data-[state=active]:text-forest-deepest',
      className,
    )}
    {...props}
  >
    <span>{children}</span>
    {count !== undefined && (
      <span
        className={cn(
          'inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm px-1.5',
          'bg-neutral-bg text-xs font-medium text-ink-muted',
          'data-[state=active]:bg-forest-tint data-[state=active]:text-forest-deepest',
        )}
      >
        {count}
      </span>
    )}
  </TabsPrimitive.Trigger>
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('pt-6 outline-none', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';

/* -------------------------------------------------------------------------
 * Segmented control — compact alternative to Tabs.
 * ----------------------------------------------------------------------- */
export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number | string }>;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded bg-neutral-bg p-0.5',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-3 transition-colors',
              size === 'sm' ? 'h-7' : 'h-8',
              'outline-none focus-visible:shadow-focus-ring',
              active
                ? 'bg-white font-medium text-ink-deepest shadow-xs'
                : 'text-ink-muted hover:text-ink-primary',
            )}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className={cn('text-xs', active ? 'text-ink-secondary' : 'text-ink-muted')}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
