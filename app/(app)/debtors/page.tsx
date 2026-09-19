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
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { KpiCard } from '@/components/ui/kpi-card';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

import RemindButton from './remind-button';

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
};
type Summary = {
  students: Debtor[];
  totals: { outstandingKobo: number; overdueKobo: number; severeCount: number; debtorCount: number };
};

async function load(): Promise<Summary | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/debtors`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return null;
  return res.json();
}

export default async function DebtorsPage() {
  const read = await checkPermission('debtor.read');
  if (!read.allowed) return <AccessDenied surface="Debtors / Aging" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const data = await load();
  if (!data) return null;
  const { students, totals } = data;

  const buckets = countBuckets(students);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-[0.14em] font-medium" style={{ color: 'var(--color-text-faint)' }}>Accounts Receivable</p>
        <h1 className="mt-1 text-[22px] sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Debtors &amp; Aging</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Students with outstanding balances, ranked by how long the oldest invoice has been overdue. Send a printable reminder in one click.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        <KpiCard label="Outstanding" value={totals.outstandingKobo} valueIsMoney compact hint="across open invoices" />
        <KpiCard label="Overdue" value={totals.overdueKobo} valueIsMoney compact delta={totals.overdueKobo > 0 ? 'action needed' : 'none'} deltaTone={totals.overdueKobo > 0 ? 'negative' : 'positive'} hint="past due date" />
        <KpiCard label="Debtors" value={totals.debtorCount} compact hint="students owing" />
        <KpiCard label="90+ days" value={buckets.severe + buckets.over90} compact delta={buckets.severe + buckets.over90 > 0 ? 'priority' : 'none'} deltaTone="negative" hint="severe aging" />
        <KpiCard label="30–89 days" value={buckets.over30 + buckets.over60} compact hint="follow-up" />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Outstanding accounts"
          description={students.length === 0 ? 'No outstanding balances. All invoices are settled.' : `${students.length} student${students.length===1?'':'s'} with open balances.`}
        />
        {students.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>
            Nothing to chase.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
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
                  <tr key={s.studentId} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <td className="px-3 py-3">
                      <Link href={`/debtors/${s.studentId}`} className="block">
                        <div className="font-medium text-[13.5px]" style={{ color: 'var(--color-forest)' }}>{s.studentName}</div>
                        <div className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{s.studentIdCode} · {s.openInvoiceCount} open invoice{s.openInvoiceCount===1?'':'s'}</div>
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>{s.className ?? '—'}</td>
                    <td className="px-3 py-3">
                      <div className="text-[12.5px]" style={{ color: 'var(--color-text-primary)' }}>{s.primaryGuardianName ?? '—'}</div>
                      <div className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{s.primaryGuardianPhone ?? ''}</div>
                    </td>
                    <td className="px-3 py-3 text-center tabular-nums text-[12.5px]">{s.openInvoiceCount}</td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold"><Money kobo={s.outstandingKobo} size="sm" /></td>
                    <td className="px-3 py-3 text-right tabular-nums" style={{ color: s.overdueKobo>0 ? 'var(--color-danger,#a82a1c)' : 'var(--color-text-faint)' }}>{s.overdueKobo>0?<Money kobo={s.overdueKobo} size="sm" />:'—'}</td>
                    <td className="px-3 py-3"><AgingBadge bucket={s.agingBucket} days={s.oldestOverdueDays} /></td>
                    <td className="px-3 py-3 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                      {s.lastReminderAt ? relTime(s.lastReminderAt) : <span style={{ color: 'var(--color-gold-dark,#8a6b11)' }}>never</span>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Link href={`/debtors/${s.studentId}`} className="text-[12px] font-medium" style={{ color: 'var(--color-forest)' }}>View</Link>
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

function Th({ children, className='' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{color:'var(--color-text-faint)'}}>{children}</th>;
}

function AgingBadge({ bucket, days }: { bucket: Debtor['agingBucket']; days: number }) {
  const defaults = { variant: 'info' as const, label: 'Current' };
  const entries: Record<Debtor['agingBucket'], {variant: 'info'|'warning'|'danger'|'success'|'neutral', label: string}> = {
    CURRENT:    { variant: 'success', label: 'Current' },
    DUE_SOON:   { variant: 'info',    label: 'Due soon' },
    OVERDUE_30: { variant: 'warning', label: `${days}d` },
    OVERDUE_60: { variant: 'warning', label: `${days}d` },
    OVERDUE_90: { variant: 'danger',  label: `${days}d` },
    SEVERE:     { variant: 'danger',  label: `${days}d+ severe` },
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
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}
