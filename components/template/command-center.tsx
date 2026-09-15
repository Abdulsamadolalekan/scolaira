import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { KpiCard } from '@/components/ui/kpi-card';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Naira, Plus, TrendUp, Users } from '@/components/ui/icons';

/**
 * Command Center template — journey 1 priority (first screen a bursar sees).
 *
 * KPI hero row (billed / collected / outstanding / overdue / unreconciled).
 * Actions column (quick record-payment, send reminders, reconcile)
 * Trends column (week-over-week movement — no chart junk).
 *
 * M1 has NO real financial data; placeholders carry explicit demo markers.
 */

export interface CommandCenterProps {
  greeting?: string;
  termLabel?: string;
  /** KPI cards (usually 5: billed / collected / outstanding / overdue / unreconciled) */
  kpis?: React.ReactNode;
  /** Primary actions column */
  quickActions?: React.ReactNode;
  /** Alerts / things to do */
  alerts?: React.ReactNode;
  /** Recent activity */
  activity?: React.ReactNode;
  /** Explicit demo placeholder marker */
  isDemo?: boolean;
}

export function CommandCenter({
  greeting = 'Good morning, Bursar',
  termLabel = '2025/26 · Third Term',
  kpis,
  quickActions,
  alerts,
  activity,
  isDemo = true,
}: CommandCenterProps) {
  return (
    <div className="mx-auto w-full max-w-content px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:py-8 lg:pb-8">
      {/* Greeting */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-muted">{termLabel}</p>
          <h1 className="mt-1 text-xl font-semibold leading-tight text-ink-deepest lg:text-2xl">
            {greeting}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Here is this term’s financial position at a glance.
          </p>
        </div>
        {isDemo && <Badge variant="gold">Demo data · placeholders only</Badge>}
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {kpis ?? (
          <>
            <KpiCard label="Billed" value={43_400_000 * 100} valueIsMoney compact isDemo />
            <KpiCard
              label="Collected"
              value={31_200_000 * 100}
              valueIsMoney
              compact
              delta="71.9%"
              deltaDirection="up"
              deltaTone="positive"
              isDemo
            />
            <KpiCard
              label="Outstanding"
              value={12_200_000 * 100}
              valueIsMoney
              compact
              delta="28.1%"
              deltaDirection="down"
              deltaTone="warning"
              isDemo
            />
            <KpiCard
              label="Overdue"
              value={4_860_000 * 100}
              valueIsMoney
              compact
              delta="₦1.2M"
              deltaDirection="up"
              deltaTone="negative"
              isDemo
            />
            <KpiCard
              label="Unreconciled"
              value={1_340_000 * 100}
              valueIsMoney
              compact
              delta="12 payments"
              deltaTone="neutral"
              isDemo
            />
          </>
        )}
      </div>

      {/* Actions + alerts */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Quick actions" description="Frequent tasks, one click away." />
          <div className="flex flex-col gap-2">
            {quickActions ?? (
              <>
                <QuickAction
                  icon={<Naira size={16} />}
                  label="Record payment"
                  hint="Log a new payment against an invoice"
                />
                <QuickAction
                  icon={<Users size={16} />}
                  label="Send reminders"
                  hint="248 parents with upcoming or overdue balances"
                />
                <QuickAction
                  icon={<TrendUp size={16} />}
                  label="Reconcile bank"
                  hint="12 payments pending matching"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1"
                  iconLeft={<Plus size={14} />}
                >
                  New invoice
                </Button>
              </>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Needs attention"
            description="Items that require action before they age further."
            actions={<Badge variant="warning">4 items</Badge>}
          />
          {alerts ?? (
            <ul className="-mt-1 divide-y divide-border">
              <AttentionRow
                title="SS3 West House — ₦450,000 overdue 14 days"
                meta="Adeyemi, Bolarinwa · Invoice INV-1042"
                tone="danger"
              />
              <AttentionRow
                title="12 bank transfers unmatched"
                meta="Most recent: GTB ₦250,000 · Today, 09:42"
                tone="warning"
              />
              <AttentionRow
                title="2 invoices pending approval before sending"
                meta="Created yesterday"
                tone="info"
              />
              <AttentionRow
                title="End-of-term reconciliation in 5 days"
                meta="Third term closes 25 Jul 2025"
                tone="neutral"
              />
            </ul>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <Card className="mt-4">
        <CardHeader
          title="Recent activity"
          description="Latest payments, invoices, and reconciliation events."
          actions={
            <Button variant="ghost" size="sm">
              View all
            </Button>
          }
        />
        {activity ?? (
          <div className="-mt-1 divide-y divide-border">
            <ActivityRow
              title="Payment recorded"
              meta="₦150,000 · Chinedu Okafor · JSS 2B"
              time="12 min ago"
              tone="success"
            />
            <ActivityRow
              title="Invoice sent"
              meta="₦43,400 · Amina Bello · Primary 4A"
              time="42 min ago"
              tone="info"
            />
            <ActivityRow
              title="Payment matched"
              meta="₦250,000 · GTB transfer → INV-0988"
              time="1h ago"
              tone="success"
            />
            <ActivityRow
              title="Invoice overdue"
              meta="₦450,000 · Bolarinwa Adeyemi · SS3 West"
              time="Today, 00:00"
              tone="danger"
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      className="-mx-2 flex w-full items-start gap-3 rounded p-2 text-left transition-colors hover:bg-forest-wash focus-visible:shadow-focus-ring"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-forest-tint text-forest-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-primary">{label}</span>
        <span className="block text-xs text-ink-muted">{hint}</span>
      </span>
    </button>
  );
}

function AttentionRow({
  title,
  meta,
  tone,
}: {
  title: string;
  meta: string;
  tone: 'danger' | 'warning' | 'info' | 'neutral';
}) {
  const toneClass = {
    danger: 'bg-danger-fg',
    warning: 'bg-warning-fg',
    info: 'bg-info-fg',
    neutral: 'bg-ink-muted',
  }[tone];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', toneClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-primary">{title}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{meta}</p>
      </div>
      <button className="shrink-0 text-xs font-medium text-forest-primary hover:underline">
        Review
      </button>
    </li>
  );
}

function ActivityRow({
  title,
  meta,
  time,
  tone,
}: {
  title: string;
  meta: string;
  time: string;
  tone: 'success' | 'info' | 'danger';
}) {
  const toneClass = {
    success: 'bg-success-fg',
    info: 'bg-info-fg',
    danger: 'bg-danger-fg',
  }[tone];
  return (
    <div className="flex items-center gap-3 py-3">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', toneClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-primary">{title}</p>
        <p className="text-xs text-ink-muted">{meta}</p>
      </div>
      <time className="shrink-0 text-xs tabular-nums text-ink-muted">{time}</time>
    </div>
  );
}
