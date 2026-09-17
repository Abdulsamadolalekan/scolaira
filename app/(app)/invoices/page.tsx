/**
 * Invoices list — institutional register.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import { FileText, Plus, AlertTriangle, ChevronRight } from '@/components/ui/icons';
import type { InvoiceRow } from '@/app/api/invoices/route';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

async function loadInvoices(): Promise<InvoiceRow[]> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return [];
  const res = await fetch(`${proto}://${host}/api/invoices`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.invoices as InvoiceRow[]) ?? [];
}

function computeStats(rows: InvoiceRow[]) {
  let totalBilled = 0, totalPaid = 0, totalOverdue = 0;
  let overdueCount = 0, draftCount = 0;
  for (const r of rows) {
    totalBilled += r.totalKobo; totalPaid += r.paidKobo;
    if (r.isOverdue) { totalOverdue += r.remainingKobo; overdueCount++; }
    if (r.status === 'DRAFT') draftCount++;
  }
  return { totalBilled, totalPaid, totalOverdue, overdueCount, draftCount, outstanding: Math.max(0, totalBilled - totalPaid) };
}

export default async function InvoicesPage() {
  const guard = await checkPermission('invoice.read');
  if (!guard.allowed) {
    return <AccessDenied surface="Invoices" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  }
  const rows = await loadInvoices();
  const s = computeStats(rows);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Invoices</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Every fee obligation owed to the school, by student and term.
          </p>
        </div>
        <Link href="/invoices/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]">
          <Plus size={14} /> New invoice
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StripCell label="Billed" value={<Money kobo={s.totalBilled} />} />
        <StripCell label="Collected" value={<Money kobo={s.totalPaid} />} tone="positive" />
        <StripCell label="Outstanding" value={<Money kobo={s.outstanding} />} tone={s.outstanding > 0 ? 'warning' : 'muted'} />
        <StripCell label={s.overdueCount ? `${s.overdueCount} overdue` : 'No overdue'}
                   value={<Money kobo={s.totalOverdue} />} tone={s.overdueCount > 0 ? 'danger' : 'muted'} />
      </div>

      <Card className="mt-4">
        <CardHeader title={rows.length === 0 ? 'No invoices yet' : 'Invoice register'}
                   description={rows.length === 0 ? 'When you issue your first invoice, it appears here.'
                     : `${rows.length} invoice${rows.length === 1 ? '' : 's'} · ${s.draftCount} draft${s.draftCount === 1 ? '' : 's'}`} />
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<FileText size={22} />} title="No invoices yet"
                        description="Invoices are how you bill parents for fees. Each tracks amount owed, payments received, and remaining balance automatically." />
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Th>Invoice</Th><Th>Student</Th><Th>Term</Th>
                    <Th className="text-right">Billed</Th><Th className="text-right">Paid</Th><Th className="text-right">Remaining</Th><Th className="text-right">Due</Th>
                    <th className="px-4 py-2.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>{rows.map(r => <DesktopRow key={r.id} r={r} />)}</tbody>
              </table>
            </div>
            <ul className="md:hidden divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {rows.map(r => <MobileRow key={r.id} r={r} />)}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function DesktopRow({ r }: { r: InvoiceRow }) {
  return (
    <tr className="hover:bg-[color:var(--color-forest-tint)] transition-colors" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <td className="px-4 py-3 align-top">
        <Link href={`/invoices/${r.id}`} className="font-medium tabular-nums" style={{ color: 'var(--color-forest)' }}>{r.invoiceNumber}</Link>
        <div className="mt-0.5"><StatusBadge r={r} /></div>
      </td>
      <td className="px-3 py-3 align-top">
        <div style={{ color: 'var(--color-text-primary)' }}>{r.studentName}</div>
        <div className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{r.studentCode}</div>
      </td>
      <td className="px-3 py-3 align-top" style={{ color: 'var(--color-text-secondary)' }}>{r.termName ?? '—'}</td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-text-secondary)' }}><Money kobo={r.totalKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-forest-deep)' }}><Money kobo={r.paidKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top font-medium"
          style={{ color: r.isOverdue ? 'var(--color-danger, #a82a1c)' : r.remainingKobo === 0 ? 'var(--color-text-faint)' : 'var(--color-text-primary)' }}>
        {r.remainingKobo === 0 ? '—' : <Money kobo={r.remainingKobo} size="sm" />}
      </td>
      <td className="px-3 py-3 text-right align-top">
        {r.status === 'DRAFT' ? <span className="text-[11px]" style={{ color: 'var(--color-text-faint)' }}>—</span>
         : r.isOverdue ? <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--color-danger, #a82a1c)' }}><AlertTriangle size={11} /> {r.daysOverdue}d</span>
         : r.dueDate ? <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{r.dueDate}</span>
         : <span className="text-[11px]" style={{ color: 'var(--color-text-faint)' }}>—</span>}
      </td>
      <td className="px-3 py-3 pr-4 align-top text-right"><ChevronRight size={14} className="inline opacity-40" /></td>
    </tr>
  );
}

function MobileRow({ r }: { r: InvoiceRow }) {
  return (
    <li>
      <Link href={`/invoices/${r.id}`} className="block px-4 py-4 active:bg-[color:var(--color-forest-tint)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium tabular-nums text-[14px]" style={{ color: 'var(--color-forest)' }}>{r.invoiceNumber}</span>
              <StatusBadge r={r} />
            </div>
            <div className="mt-1 text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{r.studentName}</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-faint)' }}>{r.termName ?? ''}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
              <Money kobo={r.totalKobo} size="sm" hideDecimals />
            </div>
            {r.remainingKobo > 0 ? (
              <div className="text-[11px] mt-0.5 tabular-nums"
                   style={{ color: r.isOverdue ? 'var(--color-danger, #a82a1c)' : 'var(--color-text-secondary)' }}>
                {r.isOverdue ? `${r.daysOverdue}d overdue · ` : ''}
                <Money kobo={r.remainingKobo} size="sm" hideDecimals /> left
              </div>
            ) : (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-forest)' }}>Paid</div>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function StripCell({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default'|'positive'|'warning'|'danger'|'muted' }) {
  const colors = { default:'var(--color-text-primary)', positive:'var(--color-forest-deep)', warning:'var(--color-gold-dark, #8a6b11)', danger:'var(--color-danger, #a82a1c)', muted:'var(--color-text-faint)' } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colors[tone] }}>{value}</div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{ color: 'var(--color-text-faint)' }}>{children}</th>;
}

function StatusBadge({ r }: { r: InvoiceRow }) {
  if (r.status === 'PAID') return <Badge variant="success">Paid</Badge>;
  if (r.status === 'VOID') return <Badge variant="neutral">Void</Badge>;
  if (r.status === 'DRAFT') return <Badge variant="neutral">Draft</Badge>;
  if (r.isOverdue) return <Badge variant="danger">Overdue</Badge>;
  if (r.status === 'PARTIALLY_PAID') return <Badge variant="warning">Partially paid</Badge>;
  return <Badge variant="info">Awaiting payment</Badge>;
}
