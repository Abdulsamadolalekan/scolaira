'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableSkeleton } from '@/components/ui/skeleton';
import { Card, PageContainer, PageHeader } from '@/components/ui/nav-shell';
import { Filter, Plus, Search } from '@/components/ui/icons';
import { ErrorState } from '@/components/ui/error-state';

/**
 * List-page template.
 *
 * page title + primary action + filters/search + tabs + table + pagination/empty.
 * Used for Students, Invoices, Payments, Receipts, Terms, Payment Links lists.
 */

export interface ListTab {
  value: string;
  label: string;
  count?: number;
}

export interface ListColumn<T> {
  key: string;
  header: string;
  numeric?: boolean;
  width?: string;
  sortable?: boolean;
  cell: (row: T) => React.ReactNode;
}

export interface ListPageProps<T> {
  title: string;
  description?: string;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  tabs?: ListTab[];
  activeTab?: string;
  onTabChange?: (v: string) => void;
  columns: ListColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  rowHref?: (row: T) => string;
  /** Explicit demo marker */
  isDemo?: boolean;
  footer?: React.ReactNode;
}

export function ListPage<T>({
  title,
  description,
  primaryActionLabel = 'New',
  onPrimaryAction,
  searchPlaceholder = 'Search…',
  searchValue,
  onSearchChange,
  tabs,
  activeTab,
  onTabChange,
  columns,
  rows,
  getRowKey,
  emptyTitle = 'No records yet',
  emptyDescription = 'When records exist, they will appear here.',
  emptyActionLabel,
  onEmptyAction,
  loading,
  error,
  onRetry,
  sortKey,
  sortDir,
  onSort,
  isDemo,
  footer,
}: ListPageProps<T>) {
  return (
    <PageContainer>
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button onClick={onPrimaryAction} iconLeft={<Plus size={14} />}>
            {primaryActionLabel}
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState inline title="Couldn’t load list" message={error} onRetry={onRetry} />
        </div>
      )}

      <Card padded={false}>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          {tabs && activeTab && onTabChange ? (
            <SegmentedControl
              value={activeTab}
              onChange={onTabChange}
              options={tabs.map((t) => ({ value: t.value, label: t.label, count: t.count }))}
              ariaLabel={`${title} filters`}
            />
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2 sm:ml-auto">
            <div className="relative w-full sm:w-72">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                aria-hidden
              />
              <Input
                placeholder={searchPlaceholder}
                value={searchValue ?? ''}
                onChange={(e) => onSearchChange?.(e.target.value)}
                prefix={null}
                containerClassName="pl-9"
                className="pl-0"
                aria-label="Search list"
              />
            </div>
            <Button variant="secondary" size="md" iconLeft={<Filter size={14} />}>
              <span className="hidden sm:inline">Filters</span>
            </Button>
          </div>
        </div>

        {/* Table (desktop) */}
        <div className="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <tr>
                {columns.map((c) => (
                  <TableHead
                    key={c.key}
                    numeric={c.numeric}
                    width={c.width}
                    sortDir={sortKey === c.key ? (sortDir ?? false) : false}
                    onSort={c.sortable && onSort ? () => onSort(c.key) : undefined}
                  >
                    {c.header}
                  </TableHead>
                ))}
              </tr>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeleton rows={5} cols={columns.length} />
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="p-6">
                    <EmptyState
                      title={emptyTitle}
                      description={emptyDescription}
                      actionLabel={emptyActionLabel}
                      onAction={onEmptyAction}
                      isDemo={isDemo}
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <TableRow key={getRowKey(row)} clickable>
                    {columns.map((c) => (
                      <TableCell key={c.key} numeric={c.numeric}>
                        {c.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Card list (mobile) */}
        <div className="divide-y divide-border md:hidden">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-ink-faint" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-ink-faint" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={emptyTitle}
                description={emptyDescription}
                actionLabel={emptyActionLabel}
                onAction={onEmptyAction}
                isDemo={isDemo}
              />
            </div>
          ) : (
            rows.map((row) => {
              if (columns.length === 0) return null;
              const firstCol = columns[0]!;
              const secondCol = columns[1];
              const lastCol = columns[columns.length - 1];
              return (
                <div key={getRowKey(row)} className="hover:bg-forest-wash/50 p-4">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink-primary">
                        {firstCol.cell(row)}
                      </div>
                      {secondCol && (
                        <div className="mt-0.5 truncate text-xs text-ink-muted">
                          {secondCol.cell(row)}
                        </div>
                      )}
                    </div>
                    {lastCol && lastCol !== firstCol && (
                      <div className="shrink-0 text-sm font-medium tabular-nums text-ink-primary">
                        {lastCol.cell(row)}
                      </div>
                    )}
                  </div>
                  {columns.length > 2 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                      {/* columns[0] is title, columns[1] is subtitle (already shown),
                          columns[-1] is the right-aligned value. Mid columns become meta. */}
                      {columns.slice(2).map((c) => (
                        <span key={c.key}>{c.cell(row)}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer (pagination, row count) */}
        {footer && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-ink-muted">
            {footer}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
