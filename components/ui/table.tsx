'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, ChevronUp } from './icons';

/**
 * Data table.
 *
 * - Header row with optional sort indicators.
 * - Right-aligned numeric columns via `numeric` prop.
 * - Dense rows for 8-hour operational use.
 * - Sticky header (opt-in via `sticky`).
 * - Row hover.
 * - Mobile: wrap in a horizontally-scrollable container; card-list transforms
 *   are applied at the page-template level (see `components/template/list.tsx`).
 */

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn('w-full border-collapse text-left text-sm', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }
>(({ className, sticky, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'text-xs uppercase tracking-wide text-ink-muted',
      sticky &&
        'sticky top-0 z-10 bg-white after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-border',
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&>tr:last-child]:border-b-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { selected?: boolean; clickable?: boolean }
>(({ className, selected, clickable, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border',
      'transition-colors',
      'hover:bg-forest-wash/60',
      clickable && 'cursor-pointer',
      selected && 'bg-forest-tint/70 hover:bg-forest-tint',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  sortDir?: 'asc' | 'desc' | false;
  onSort?: () => void;
  width?: string;
}

export const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, numeric, sortDir, onSort, width, children, ...props }, ref) => {
    const content = onSort ? (
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide',
          '-ml-1 rounded px-1 py-0.5 text-ink-muted transition-colors hover:text-ink-primary',
          'focus-visible:shadow-focus-ring',
        )}
      >
        <span>{children}</span>
        <span className="flex flex-col leading-none text-ink-subtle" aria-hidden>
          {sortDir === 'asc' ? (
            <ChevronUp size={12} className="text-ink-primary" />
          ) : sortDir === 'desc' ? (
            <ChevronDown size={12} className="text-ink-primary" />
          ) : (
            <ChevronDown size={12} />
          )}
        </span>
      </button>
    ) : (
      <span className="text-xs font-medium uppercase tracking-wide">{children}</span>
    );
    return (
      <th
        ref={ref}
        scope="col"
        style={width ? { width } : undefined}
        className={cn(
          'h-10 px-3 py-2 font-medium text-ink-muted',
          numeric && 'text-right tabular-nums',
          className,
        )}
        aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : undefined}
        {...props}
      >
        {content}
      </th>
    );
  },
);
TableHead.displayName = 'TableHead';

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  muted?: boolean;
  mono?: boolean;
}

export const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, numeric, muted, mono, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-3 py-3 align-middle',
        numeric && 'font-feature-tnum text-right tabular-nums',
        muted && 'text-ink-muted',
        mono && 'font-mono text-xs',
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = 'TableCell';
