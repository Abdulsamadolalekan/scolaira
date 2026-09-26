/**
 * Debtor detail — full account summary and reminder history for one student.
 *
 * Printable statement is served from /debtors/[id]/statement (full-page
 * HTML without the app shell, for clean printing).
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { ChevronLeft, FileText } from '@/components/ui/icons';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import RemindButton from '../remind-button';

export const runtime = 'nodejs';

type Detail = {
  student: { id: string; studentId: string; name: string };
  invoices: Array<{
    id: string; invoiceNumber: string; dueDate: string|null; totalKobo: number;
    paidKobo: number; remainingKobo: number; status: string; daysOverdue: number;
  }>;
  reminders: Array<{
    id: string; channel: string; status: string; balanceKobo: number;
    agingBucket: string; sentAt: string|null; createdAt: string;
  }>;
  summary: { outstandingKobo: number; overdueKobo: number; oldestOverdueDays: number };
};

async function load(id: string): Promise<Detail | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/debtors/${encodeURIComponent(id)}`, { cache: 'no-store', headers: { cookie } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

export default async function DebtorDetailPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const read = await checkPermission('debtor.read');
  if (!read.allowed) return <AccessDenied surface="Debtor record" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const d = await load(studentId);
  if (!d) notFound();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/debtors" className="inline-flex items-center gap-1 text-[13px] mb-4" style={{ color: 'var(--color-text-secondary)' }}>
        <ChevronLeft size={14} /> Debtors
      </Link>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] font-medium" style={{ color: 'var(--color-text-faint)' }}>{d.student.studentId}</p>
          <h1 className="mt-1 text-[22px] sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>{d.student.name}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {d.summary.oldestOverdueDays > 0
              ? `${d.summary.oldestOverdueDays} days since oldest overdue invoice.`
              : 'No overdue invoices.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/debtors/${studentId}/statement`} target="_blank"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] font-medium"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}>
            <FileText size={14} /> Print statement
          </Link>
          <RemindButton studentId={studentId} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Outstanding" value={<Money kobo={d.summary.outstandingKobo} />} tone="warning" />
        <Stat label="Overdue" value={<Money kobo={d.summary.overdueKobo} />} tone={d.summary.overdueKobo>0?'danger':'muted'} />
        <Stat label="Oldest overdue" value={`${d.summary.oldestOverdueDays} days`} tone={d.summary.oldestOverdueDays>90?'danger':'default'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Invoices" description={`${d.invoices.length} invoice${d.invoices.length===1?'':'s'}.`} />
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                <Th>Invoice</Th><Th>Due</Th><Th className="text-right">Total</Th><Th className="text-right">Paid</Th><Th className="text-right">Balance</Th><Th>Status</Th><Th></Th>
              </tr></thead>
              <tbody>
                {d.invoices.map(i => (
                  <tr key={i.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <td className="px-3 py-3"><Link href={`/invoices/${i.id}`} className="font-medium tabular-nums" style={{ color: 'var(--color-forest)' }}>{i.invoiceNumber}</Link></td>
                    <td className="px-3 py-3 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>{i.dueDate ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums"><Money kobo={i.totalKobo} size="sm" /></td>
                    <td className="px-3 py-3 text-right tabular-nums" style={{ color: 'var(--color-forest-deep)' }}><Money kobo={i.paidKobo} size="sm" /></td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium" style={{ color:i.remainingKobo>0?'var(--color-gold-dark,#8a6b11)':'var(--color-text-faint)' }}>{i.remainingKobo===0?'—':<Money kobo={i.remainingKobo} size="sm" />}</td>
                    <td className="px-3 py-3"><InvBadge status={i.status} days={i.daysOverdue} remaining={i.remainingKobo} /></td>
                    <td className="px-3 py-3 text-right">{i.remainingKobo>0 && <RemindButton studentId={studentId} invoiceId={i.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        </div>
        <div>
          <Card>
            <CardHeader title="Follow-up history" description="Payment reminders already issued." />
            {d.reminders.length === 0 ? (
              <div className="p-6 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>No reminders sent yet.</div>
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
                {d.reminders.map(r => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium">{r.channel} · {r.status.toLowerCase()}</span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-faint)' }}>
                        {r.sentAt ? new Date(r.sentAt).toLocaleDateString() : (r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—')}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                      <span><Money kobo={r.balanceKobo} size="sm" /></span>
                      <Badge variant={bucketTone(r.agingBucket)}>{r.agingBucket.replace('_',' ').toLowerCase()}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone='default' }: { label:string; value:React.ReactNode; tone?:'default'|'positive'|'warning'|'danger'|'muted' }) {
  const colors = { default:'var(--color-text-primary)', positive:'var(--color-forest-deep)', warning:'var(--color-gold-dark,#8a6b11)', danger:'var(--color-danger,#a82a1c)', muted:'var(--color-text-faint)' } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color:'var(--color-text-faint)' }}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colors[tone] }}>{value}</div>
    </div>
  );
}
function Th({ children, className='' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{color:'var(--color-text-faint)'}}>{children}</th>;
}
function InvBadge({ status, days, remaining }: { status: string; days: number; remaining: number }) {
  if (remaining === 0) return <Badge variant="success">Paid</Badge>;
  if (status === 'VOID') return <Badge variant="neutral">Void</Badge>;
  if (days > 90) return <Badge variant="danger">{days}d severe</Badge>;
  if (days > 0) return <Badge variant="warning">{days}d overdue</Badge>;
  return <Badge variant="info">Awaiting payment</Badge>;
}
function bucketTone(b: string): 'danger'|'warning'|'info'|'success'|'neutral' {
  if (b === 'SEVERE' || b === 'OVERDUE_90') return 'danger';
  if (b === 'OVERDUE_30' || b === 'OVERDUE_60') return 'warning';
  if (b === 'DUE_SOON') return 'info';
  if (b === 'CURRENT') return 'success';
  return 'neutral';
}
