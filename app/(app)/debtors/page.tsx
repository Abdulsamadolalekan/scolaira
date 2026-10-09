/**
 * Debtors / Aging workbench (M7).
 *
 * One ranked list of students with outstanding balances: who owes, how much,
 * how long it has been owed, who their guardian is, and whether follow-up
 * has already been sent. Printable reminders flow through POST
 * /api/debtors/[studentId]/remind and are recorded in the immutable
 * `reminders` table.
 */
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

import RemindButton from './remind-button';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

type Debtor = {
  studentId: string;
  studentIdCode: string;
  studentName: string;
  className: string | null;
  primaryGuardianName: string | null;
  primaryGuardianPhone: string | null;
  outstandingKobo: number;
  overdueKobo: number;
  oldestOverdueDays: number;
  oldestDueDate: string | null;
  openInvoiceCount: number;
  lastReminderAt: string | null;
  agingBucket: 'CURRENT' | 'DUE_SOON' | 'OVERDUE_30' | 'OVERDUE_60' | 'OVERDUE_90' | 'SEVERE';
  /** H-2/M-7: the last reminder classified against the server's thresholds. */
  reminderStaleness: 'NONE' | 'FRESH' | 'STALE' | 'UNATTENDED';
  daysSinceReminder: number | null;
};
type Summary = {
  students: Debtor[];
  totals: {
    outstandingKobo: number;
    overdueKobo: number;
    severeCount: number;
    debtorCount: number;
  };
  page?: {
    limit: number;
    cap: number;
    returned: number;
    total: number | null;
    hasMore: boolean;
    nextCursor: string | null;
  };
  thresholds?: {
    staleAfterDays: number;
    unattendedAfterDays: number;
    reminderCooldownHours: number;
    severeBucketDays: number;
    severeAgingDays: number;
  };
  scope?: { scope: 'ALL_TERM'; label: string; termName: string | null; cutoverOn: string | null };
};

async function load(): Promise<Summary | null> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return null;
  const res = await fetch(`${base}/api/debtors`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return null;
  return res.json();
}

async function loadCurrentTerm(): Promise<{
  id: string;
  name: string;
  status: string;
  billed: boolean;
} | null> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return null;
  const res = await fetch(`${base}/api/terms`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.terms ?? []).find((term: { isCurrent: boolean }) => term.isCurrent) ?? null;
}

export default async function DebtorsPage() {
  const read = await checkPermission('debtor.read');
  if (!read.allowed)
    return (
      <AccessDenied
        surface="Debtors / Aging"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const [data, currentTerm] = await Promise.all([load(), loadCurrentTerm()]);
  if (!data) return null;
  const { students, totals } = data;
  const page = data.page;
  const thresholds = data.thresholds;
  const debtorsTruncated = Boolean(
    page && (page.hasMore || (page.total !== null && page.total > page.returned)),
  );

  const buckets = countBuckets(students);
  const debtorTotal = Object.values(buckets).reduce((a, b) => a + b, 0);
  const termNeedsBilling = currentTerm?.status === 'ACTIVE' && !currentTerm.billed;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Accounts receivable"
        title="Debtors and aging"
        lede="Students with outstanding balances, ranked by how long the oldest invoice has been overdue."
        meta={
          <>
            {data.scope
              ? `Covers every term (${data.scope.label.toLowerCase()}).`
              : 'Covers every term.'}
            {thresholds
              ? ` A reminder older than ${thresholds.staleAfterDays} days is stale; ${thresholds.unattendedAfterDays} days with none is unattended.`
              : ''}
            {debtorsTruncated && page
              ? ` Showing the first ${page.returned} of ${page.total ?? 'more'} debtors.`
              : ''}
          </>
        }
      />

      {termNeedsBilling && currentTerm && (
        <div
          className="mb-6 flex flex-col gap-2 border-l-2 py-1 pl-4 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: 'var(--color-gold-rich)' }}
        >
          <div>
            <div className="text-sm font-medium text-ink-primary">
              {currentTerm.name} has not been billed
            </div>
            <div className="mt-0.5 text-xs text-ink-muted">
              Review the complete enrolled population before treating debtor totals as a collection
              target.
            </div>
          </div>
          <Link
            href={`/terms/${currentTerm.id}/bill`}
            className="shrink-0 text-sm font-medium text-forest-deep hover:underline"
          >
            Review billing →
          </Link>
        </div>
      )}

      {/* Aging is a shape, not a set of boxes. The two figures the bursar acts on
          lead; the four bands then read as a distribution, ordered worst-first so
          the money most at risk is the first thing read. */}
      <section className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        <div className="border-t-2 border-forest-deepest pt-4">
          <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Outstanding, all terms
          </p>
          <p className="mt-2">
            <Money
              kobo={totals.outstandingKobo}
              size="xl"
              className="text-display-lg text-forest-deepest"
            />
          </p>
          <dl className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <div>
              <dt className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                Overdue
              </dt>
              <dd className="mt-0.5">
                <Money
                  kobo={totals.overdueKobo}
                  size="lg"
                  className={totals.overdueKobo > 0 ? 'text-danger-fg' : 'text-ink-subtle'}
                />
              </dd>
            </div>
            <div>
              <dt className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                Debtors
              </dt>
              <dd className="mt-0.5 text-figure-lg tabular-nums text-ink-primary">
                {totals.debtorCount}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink-muted">
            {totals.overdueKobo > 0
              ? 'Past its due date — the part of the position that needs action.'
              : 'Nothing is past its due date.'}
          </p>
        </div>

        <div className="border-t border-ink-faint pt-4">
          <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Aging of open balances
          </p>
          <ul className="mt-3">
            {[
              // Same buckets the register's aging column uses, in severity order.
              { label: '90+ days', hint: 'severe', value: buckets.severe + buckets.over90 },
              { label: '60–89 days', hint: 'at risk', value: buckets.over60 },
              { label: '30–59 days', hint: 'follow up', value: buckets.over30 },
              { label: 'Due soon', hint: 'not yet late', value: buckets.dueSoon },
              { label: 'Not yet due', hint: 'within terms', value: buckets.current },
            ].map((band) => (
              <li
                key={band.label}
                className="flex items-baseline justify-between gap-4 border-b border-ink-faint py-2.5"
              >
                <span className="text-[13.5px] text-ink-secondary">
                  {band.label}
                  <span className="ml-2 text-xs text-ink-subtle">{band.hint}</span>
                </span>
                <span className="flex items-baseline gap-4">
                  <span
                    className="text-figure tabular-nums"
                    style={{
                      color:
                        band.value === 0
                          ? 'var(--color-ink-subtle)'
                          : band.hint === 'severe'
                            ? 'var(--color-danger-fg)'
                            : 'var(--color-ink-primary)',
                    }}
                  >
                    {band.value}
                  </span>
                  <span className="w-8 text-right text-xs text-ink-subtle">
                    {debtorTotal > 0 ? `${Math.round((band.value / debtorTotal) * 100)}%` : '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">
            Students grouped by the age of their oldest unpaid invoice.
          </p>
        </div>
      </section>

      <Card className="mt-4">
        <CardHeader
          title="Outstanding accounts"
          description={
            students.length === 0
              ? 'No outstanding balances. All invoices are settled.'
              : `${students.length} student${students.length === 1 ? '' : 's'} with open balances.`
          }
        />
        {students.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>
            Nothing to chase.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left"
                  style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                >
                  <Th>Student</Th>
                  <Th>Class</Th>
                  <Th>Guardian</Th>
                  <Th className="text-right">Open</Th>
                  <Th className="text-right">Outstanding</Th>
                  <Th className="text-right">Overdue</Th>
                  <Th>Aging</Th>
                  <Th>Last reminder</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr
                    key={s.studentId}
                    style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                  >
                    <td className="px-3 py-3">
                      <Link href={`/debtors/${s.studentId}`} className="block">
                        <div
                          className="text-[13.5px] font-medium"
                          style={{ color: 'var(--color-forest)' }}
                        >
                          {s.studentName}
                        </div>
                        <div
                          className="text-[11px] tabular-nums"
                          style={{ color: 'var(--color-text-faint)' }}
                        >
                          {s.studentIdCode} · {s.openInvoiceCount} open invoice
                          {s.openInvoiceCount === 1 ? '' : 's'}
                        </div>
                      </Link>
                    </td>
                    <td
                      className="px-3 py-3 text-[12.5px]"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {s.className ?? '—'}
                    </td>
                    {/* Who to ring about this debt. When nobody is recorded, the
                        register says so and offers the one action that fixes it —
                        an em dash with no next step was the state the audit found. */}
                    <td className="px-3 py-3">
                      {s.primaryGuardianName ? (
                        <>
                          <div
                            className="text-[12.5px]"
                            style={{ color: 'var(--color-text-primary)' }}
                          >
                            {s.primaryGuardianName}
                          </div>
                          <div
                            className="text-[11px] tabular-nums"
                            style={{ color: 'var(--color-text-faint)' }}
                          >
                            {s.primaryGuardianPhone ?? 'no phone recorded'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div
                            className="text-[12.5px]"
                            style={{ color: 'var(--color-text-faint)' }}
                          >
                            None recorded
                          </div>
                          <Link
                            href={`/students/${s.studentId}`}
                            className="text-[11px] font-medium underline-offset-2 hover:underline"
                            style={{ color: 'var(--color-forest)' }}
                          >
                            Add guardian
                          </Link>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center text-[12.5px] tabular-nums">
                      {s.openInvoiceCount}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">
                      <Money kobo={s.outstandingKobo} size="sm" />
                    </td>
                    <td
                      className="px-3 py-3 text-right tabular-nums"
                      style={{
                        color:
                          s.overdueKobo > 0
                            ? 'var(--color-danger,#a82a1c)'
                            : 'var(--color-text-faint)',
                      }}
                    >
                      {s.overdueKobo > 0 ? <Money kobo={s.overdueKobo} size="sm" /> : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <AgingBadge bucket={s.agingBucket} days={s.oldestOverdueDays} />
                    </td>
                    <td
                      className="px-3 py-3 text-[11px]"
                      style={{ color: 'var(--color-text-faint)' }}
                    >
                      {s.lastReminderAt ? (
                        relTime(s.lastReminderAt)
                      ) : (
                        <span style={{ color: 'var(--color-gold-dark,#8a6b11)' }}>never</span>
                      )}
                      {s.reminderStaleness === 'STALE' || s.reminderStaleness === 'UNATTENDED' ? (
                        <span
                          className="ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: 'var(--color-surface-muted)',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {s.reminderStaleness === 'UNATTENDED' ? 'unattended' : 'stale'}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          href={`/debtors/${s.studentId}`}
                          className="text-[12px] font-medium"
                          style={{ color: 'var(--color-forest)' }}
                        >
                          View
                        </Link>
                        <RemindButton studentId={s.studentId} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider ${className}`}
      style={{ color: 'var(--color-text-faint)' }}
    >
      {children}
    </th>
  );
}

function AgingBadge({ bucket, days }: { bucket: Debtor['agingBucket']; days: number }) {
  const defaults = { variant: 'info' as const, label: 'Current' };
  const entries: Record<
    Debtor['agingBucket'],
    { variant: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; label: string }
  > = {
    CURRENT: { variant: 'success', label: 'Current' },
    DUE_SOON: { variant: 'info', label: 'Due soon' },
    OVERDUE_30: { variant: 'warning', label: `${days}d` },
    OVERDUE_60: { variant: 'warning', label: `${days}d` },
    OVERDUE_90: { variant: 'danger', label: `${days}d` },
    SEVERE: { variant: 'danger', label: `${days}d+ severe` },
  };
  const cfg = entries[bucket] ?? defaults;
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

function countBuckets(students: Debtor[]) {
  const counts = { current: 0, dueSoon: 0, over30: 0, over60: 0, over90: 0, severe: 0 };
  for (const s of students) {
    if (s.agingBucket === 'CURRENT') counts.current++;
    else if (s.agingBucket === 'DUE_SOON') counts.dueSoon++;
    else if (s.agingBucket === 'OVERDUE_30') counts.over30++;
    else if (s.agingBucket === 'OVERDUE_60') counts.over60++;
    else if (s.agingBucket === 'OVERDUE_90') counts.over90++;
    else counts.severe++;
  }
  return counts;
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
