'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/nav-shell';
import { Money } from '@/components/ui/money';

/**
 * Detail-page template.
 *
 * Summary header with status + key info; action bar; tabbed content sections;
 * audit/events at bottom. Used for Invoice detail, Payment detail, Student
 * detail, Receipt detail.
 */

export interface DetailHeaderItem {
  label: string;
  value: React.ReactNode;
  /** Value is kobo — render via <Money compact /> */
  money?: boolean;
}

export interface DetailTab {
  value: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

export interface DetailPageProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** e.g. status badge */
  status?: React.ReactNode;
  /** Meta row under title (e.g. Invoice #INV-1042 · Due 14 Jun 2025) */
  meta?: React.ReactNode;
  /** Primary/secondary actions */
  actions?: React.ReactNode;
  /** Summary key-facts strip under header */
  summaryItems?: DetailHeaderItem[];
  /** Tabs */
  tabs?: DetailTab[];
  defaultTab?: string;
  /** Audit trail content (bottom of page) */
  auditTrail?: React.ReactNode;
  /** Additional children below summary, before tabs */
  children?: React.ReactNode;
  /** Print-friendly stylesheet is always loaded; caller controls print button via actions. */
  printFriendly?: boolean;
}

export function DetailPage({
  title,
  subtitle,
  status,
  meta,
  actions,
  summaryItems,
  tabs,
  defaultTab,
  auditTrail,
  children,
}: DetailPageProps) {
  return (
    <div className="mx-auto w-full max-w-content px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:py-8 lg:pb-8">
      {/* Back / print area for print */}
      <div className="print-header">
        <div className="mb-4 flex items-center gap-3 border-b border-black pb-3">
          <div className="flex h-10 w-10 items-center justify-center bg-black font-bold text-white">
            S
          </div>
          <div>
            <p className="font-semibold">Demo School</p>
            <p className="text-xs text-black/70">14 Marina Road, Lagos · RC 123456</p>
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="no-print flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold leading-tight text-ink-deepest lg:text-2xl">
              {title}
            </h1>
            {status}
          </div>
          {subtitle && <p className="text-sm font-medium text-ink-primary">{subtitle}</p>}
          {meta && <p className="mt-1 text-sm text-ink-muted">{meta}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      </div>

      {/* Summary strip */}
      {summaryItems && summaryItems.length > 0 && (
        <Card className="avoid-break mt-6">
          <dl className={cn('grid gap-5', gridClass(summaryItems.length))}>
            {summaryItems.map((item, i) => (
              <div key={i} className="flex flex-col gap-1">
                <dt className="text-xs uppercase tracking-wide text-ink-muted">{item.label}</dt>
                <dd className="text-md font-semibold tabular-nums text-ink-deepest">
                  {item.money && typeof item.value === 'number' ? (
                    <Money kobo={item.value} size="lg" />
                  ) : (
                    item.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {children}

      {/* Tabs */}
      {tabs && tabs.length > 0 && (
        <div className="mt-6">
          <Tabs defaultValue={defaultTab ?? tabs[0]?.value ?? ''}>
            <TabsList className="w-full overflow-x-auto">
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} count={t.count}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.value} value={t.value}>
                {t.content}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      )}

      {/* Audit trail */}
      {auditTrail && (
        <Card className="avoid-break mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Activity & Audit Trail
          </h2>
          {auditTrail}
        </Card>
      )}
    </div>
  );
}

function gridClass(count: number): string {
  if (count <= 2) return 'grid-cols-2';
  if (count === 3) return 'grid-cols-2 md:grid-cols-3';
  if (count === 4) return 'grid-cols-2 md:grid-cols-4';
  return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5';
}

/**
 * Audit timeline item (simple, opinionated).
 */
export function AuditEntry({
  actor,
  action,
  timestamp,
  meta,
}: {
  actor: React.ReactNode;
  action: React.ReactNode;
  timestamp: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b border-border py-2.5 last:border-b-0">
      <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-forest-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-primary">
          <span className="font-medium">{actor}</span> {action}
        </p>
        {meta && <p className="mt-0.5 text-xs text-ink-muted">{meta}</p>}
      </div>
      <time className="whitespace-nowrap text-xs tabular-nums text-ink-muted">{timestamp}</time>
    </div>
  );
}

/**
 * Detail field row (label + value) for side-panel info blocks.
 */
export function DetailField({
  label,
  value,
  money,
  mono,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  money?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="shrink-0 pt-0.5 text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd
        className={cn(
          'text-right text-sm text-ink-primary',
          mono && 'font-mono text-xs',
          money && 'font-medium tabular-nums',
        )}
      >
        {money && typeof value === 'number' ? <Money kobo={value} /> : value}
      </dd>
    </div>
  );
}

/**
 * Status badge factory — maps canonical statuses to Badge variants.
 */
export function StatusBadge({
  status,
}: {
  status:
    | 'paid'
    | 'pending'
    | 'partial'
    | 'overdue'
    | 'draft'
    | 'reversed'
    | 'voided'
    | 'reconciled'
    | 'flagged'
    | 'sent'
    | string;
}) {
  const map: Record<
    string,
    {
      variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'gold' | 'forest';
      label: string;
    }
  > = {
    paid: { variant: 'success', label: 'Paid' },
    reconciled: { variant: 'success', label: 'Reconciled' },
    sent: { variant: 'info', label: 'Sent' },
    pending: { variant: 'warning', label: 'Pending' },
    partial: { variant: 'warning', label: 'Partially paid' },
    overdue: { variant: 'danger', label: 'Overdue' },
    reversed: { variant: 'danger', label: 'Reversed' },
    voided: { variant: 'neutral', label: 'Voided' },
    draft: { variant: 'neutral', label: 'Draft' },
    flagged: { variant: 'gold', label: 'Flagged' },
  };
  const hit = map[status.toLowerCase()] ?? { variant: 'neutral', label: status };
  return <Badge variant={hit.variant}>{hit.label}</Badge>;
}
