/**
 * Student financial profile — authoritative view of a student's ledgers.
 *
 * Server-rendered; fetches from the same API a finance officer would trust.
 * Every number comes from invoices/allocations in the DB — nothing is
 * computed client-side beyond formatting.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { ChevronLeft, FileText, Inbox } from '@/components/ui/icons';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import StudentActions from './student-actions';

export const runtime = 'nodejs';

type Profile = {
  student: { id: string; studentId: string; firstName: string; lastName: string; middleName: string|null; gender: string|null; status: string; };
  invoices: Array<{ id: string; invoiceNumber: string; status: string; dueDate: string|null; totalKobo: number; paidKobo: number; remainingKobo: number; }>;
  payments: Array<{ id: string; paymentNumber: string; method: string; status: string; amountKobo: number; appliedKobo: number; unallocatedKobo: number; reference: string|null; paidAt: string|null; recordedAt: string|null; }>;
  summary: { totalBilledKobo: number; totalPaidKobo: number; outstandingKobo: number; invoiceCount: number; };
};

async function load(id: string): Promise<Profile | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/students/${id}`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return null;
  return res.json();
}

export default async function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await checkPermission('student.read');
  if (!read.allowed) return <AccessDenied surface="Student record" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const canUpdate = (await checkPermission('student.update')).allowed;
  const p = await load(id);
  if (!p) notFound();
  const name = [p.student.firstName, p.student.middleName, p.student.lastName].filter(Boolean).join(' ');

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/students" className="inline-flex items-center gap-1 text-[13px] mb-4" style={{color:'var(--color-text-secondary)'}}>
        <ChevronLeft size={14} /> Students
      </Link>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] font-medium" style={{color:'var(--color-text-faint)'}}>{p.student.studentId} · {p.student.status}</p>
          <h1 className="mt-1 text-[22px] sm:text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>{name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/invoices/new?studentId=${p.student.id}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)]">
            <FileText size={14} /> New invoice
          </Link>
          <Link href={`/payments/new?studentId=${p.student.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] font-medium"
                style={{borderColor:'var(--color-border)',color:'var(--color-text-primary)'}}>
            <Inbox size={14} /> Record payment
          </Link>
          {canUpdate && <StudentActions studentId={p.student.id} status={p.student.status} />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Billed" value={<Money kobo={p.summary.totalBilledKobo} />} />
        <Stat label="Paid" value={<Money kobo={p.summary.totalPaidKobo} />} tone="positive" />
        <Stat label="Outstanding" value={<Money kobo={p.summary.outstandingKobo} />} tone={p.summary.outstandingKobo>0?'warning':'muted'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Invoices" description={`${p.invoices.length} invoice${p.invoices.length===1?'':'s'} issued to this student.`} />
            {p.invoices.length === 0 ? (
              <div className="p-6 text-center text-sm" style={{color:'var(--color-text-faint)'}}>No invoices yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-left" style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                  <Th>Invoice</Th><Th className="text-right">Total</Th><Th className="text-right">Paid</Th><Th className="text-right">Balance</Th><Th>Status</Th>
                </tr></thead>
                <tbody>
                  {p.invoices.map(i => (
                    <tr key={i.id} style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                      <td className="px-4 py-3"><Link href={`/invoices/${i.id}`} className="font-medium tabular-nums" style={{color:'var(--color-forest)'}}>{i.invoiceNumber}</Link></td>
                      <td className="px-3 py-3 text-right tabular-nums" style={{color:'var(--color-text-secondary)'}}><Money kobo={i.totalKobo} size="sm" /></td>
                      <td className="px-3 py-3 text-right tabular-nums" style={{color:'var(--color-forest-deep)'}}><Money kobo={i.paidKobo} size="sm" /></td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium" style={{color:i.remainingKobo>0?'var(--color-gold-dark,#8a6b11)':'var(--color-text-faint)'}}>
                        {i.remainingKobo===0?'—':<Money kobo={i.remainingKobo} size="sm" />}
                      </td>
                      <td className="px-3 py-3"><InvBadge status={i.status} remaining={i.remainingKobo} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <div>
          <Card>
            <CardHeader title="Payment history" description="Payments allocated to this student's invoices." />
            {p.payments.length === 0 ? (
              <div className="p-6 text-center text-sm" style={{color:'var(--color-text-faint)'}}>No payments yet.</div>
            ) : (
              <ul className="divide-y" style={{borderColor:'var(--color-border-subtle)'}}>
                {p.payments.map(pay => (
                  <li key={pay.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/payments/${pay.id}`} className="font-medium tabular-nums text-[13px]" style={{color:'var(--color-forest)'}}>{pay.paymentNumber}</Link>
                        <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>
                          {pay.method} · {pay.reference ?? (pay.paidAt ? new Date(pay.paidAt).toLocaleDateString() : '—')}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] tabular-nums font-semibold" style={{color:'var(--color-text-primary)'}}><Money kobo={pay.appliedKobo} size="sm" hideDecimals /></div>
                        <div className="text-[10px] mt-0.5 uppercase tracking-wider font-medium" style={{color:pay.status==='REVERSED'?'var(--color-danger,#a82a1c)':'var(--color-text-faint)'}}>{pay.status.replace('_',' ')}</div>
                      </div>
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

function Stat({ label, value, tone='default' }: { label:string; value:React.ReactNode; tone?:'default'|'positive'|'warning'|'muted' }) {
  const colors = { default:'var(--color-text-primary)', positive:'var(--color-forest-deep)', warning:'var(--color-gold-dark,#8a6b11)', muted:'var(--color-text-faint)' } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{borderColor:'var(--color-border-subtle)',backgroundColor:'var(--color-bg-page)'}}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{color:colors[tone]}}>{value}</div>
    </div>
  );
}
function Th({ children, className='' }: { children?:React.ReactNode; className?:string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{color:'var(--color-text-faint)'}}>{children}</th>;
}
function InvBadge({ status, remaining }: { status: string; remaining: number }) {
  if (status === 'PAID' || remaining === 0) return <Badge variant="success">Paid</Badge>;
  if (status === 'VOID') return <Badge variant="neutral">Void</Badge>;
  if (status === 'PARTIALLY_PAID' || (remaining > 0 && status !== 'ISSUED')) return <Badge variant="warning">Part paid</Badge>;
  return <Badge variant="info">Awaiting payment</Badge>;
}
