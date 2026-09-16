/**
 * Payments register.
 *
 * A payment is money the school has received (or is waiting to receive).
 * Unlike invoices, a payment can be unallocated, partially allocated, fully
 * allocated, or reversed. The register makes that state unmistakable at a
 * glance.
 *
 * Mobile: card layout, not a squeezed table. Each card shows amount · payer ·
 * method · allocation state in priority order.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import { Naira, Plus, Clock, AlertTriangle, ChevronRight, CheckCircle, XCircle } from '@/components/ui/icons';
import type { PaymentRow } from '@/app/api/payments/route';

export const runtime = 'nodejs';

async function loadPayments(): Promise<PaymentRow[]> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return [];
  const res = await fetch(`${proto}://${host}/api/payments`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.payments as PaymentRow[]) ?? [];
}

function stats(rows: PaymentRow[]) {
  let received = 0, pending = 0, pendingCount = 0, unallocated = 0;
  for (const r of rows) {
    if (r.status === 'CONFIRMED') received += r.amountKobo;
    if (r.status === 'PENDING' || r.status === 'DUPLICATE_SUSPECT') {
      pending += r.amountKobo;
      pendingCount++;
    }
    if (r.status === 'CONFIRMED') unallocated += r.unallocatedKobo;
  }
  return { received, pending, pendingCount, unallocated };
}

export default async function PaymentsPage() {
  const rows = await loadPayments();
  const s = stats(rows);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>
            Payments
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Cash, bank transfers, card payments — and which invoices they settle.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/payments/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]">
            <Plus size={14} /> Record payment
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StripCell label="Received" value={<Money kobo={s.received} />} tone="positive" />
        <StripCell label={s.pendingCount ? `${s.pendingCount} pending` : 'No pending'}
                   value={<Money kobo={s.pending} />} tone={s.pendingCount ? 'warning' : 'muted'} />
        <StripCell label="Unallocated"
                   value={<Money kobo={s.unallocated} />} tone={s.unallocated > 0 ? 'warning' : 'muted'} />
        <StripCell label="Total records" value={<span className="tabular-nums">{rows.length}</span>} />
      </div>

      <Card className="mt-4">
        <CardHeader
          title={rows.length === 0 ? 'No payments yet' : 'Payments register'}
          description={rows.length === 0
            ? 'When you record a cash payment or confirm a bank transfer, it appears here.'
            : `${rows.length} payment${rows.length === 1 ? '' : 's'} on record.`}
        />
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Naira size={22} />}
              title="No payments yet"
              description="Record a payment when money is received — we will walk you through matching it to one or more invoices so balances stay exact."
            />
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Th>Payment</Th><Th>Payer</Th><Th>Method</Th>
                    <Th className="text-right">Amount</Th><Th className="text-right">Allocated</Th><Th className="text-right">Remaining</Th><Th>When</Th>
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

function DesktopRow({ r }: { r: PaymentRow }) {
  return (
    <tr className="hover:bg-[color:var(--color-forest-tint)] transition-colors" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <td className="px-4 py-3 align-top">
        <Link href={`/payments/${r.id}`} className="font-medium tabular-nums" style={{ color: 'var(--color-forest)' }}>{r.paymentNumber}</Link>
        <div className="mt-0.5"><PayStatus r={r} /></div>
      </td>
      <td className="px-3 py-3 align-top">
        <div style={{ color: 'var(--color-text-primary)' }}>{r.payerName || <span style={{ color: 'var(--color-text-faint)' }}>Unknown payer</span>}</div>
        {r.reference && <div className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{r.reference}</div>}
      </td>
      <td className="px-3 py-3 align-top" style={{ color: 'var(--color-text-secondary)' }}>{formatMethod(r.method)}</td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-text-primary)' }}><Money kobo={r.amountKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-forest-deep)' }}><Money kobo={r.allocatedKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top font-medium"
          style={{ color: r.status === 'CONFIRMED' && r.unallocatedKobo > 0 ? 'var(--color-gold-dark, #8a6b11)' : 'var(--color-text-faint)' }}>
        {r.unallocatedKobo > 0 && r.status !== 'REVERSED' ? <Money kobo={r.unallocatedKobo} size="sm" /> : '—'}
      </td>
      <td className="px-3 py-3 align-top">
        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          {r.paidAt ?? r.recordedAt ?? '—'}
        </span>
      </td>
      <td className="px-3 py-3 pr-4 align-top text-right"><ChevronRight size={14} className="inline opacity-40" /></td>
    </tr>
  );
}

function MobileRow({ r }: { r: PaymentRow }) {
  return (
    <li>
      <Link href={`/payments/${r.id}`} className="block px-4 py-4 active:bg-[color:var(--color-forest-tint)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium tabular-nums text-[14px]" style={{ color: 'var(--color-forest)' }}>{r.paymentNumber}</span>
              <PayStatus r={r} />
            </div>
            <div className="mt-1 text-[13px]" style={{ color: 'var(--color-text-primary)' }}>
              {r.payerName || <span style={{ color: 'var(--color-text-faint)' }}>Unknown payer</span>}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-faint)' }}>{formatMethod(r.method)}{r.reference ? ` · ${r.reference}` : ''}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
              <Money kobo={r.amountKobo} size="sm" hideDecimals />
            </div>
            {r.status === 'CONFIRMED' && r.unallocatedKobo > 0 ? (
              <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--color-gold-dark, #8a6b11)' }}>
                <Money kobo={r.unallocatedKobo} size="sm" hideDecimals /> unallocated
              </div>
            ) : r.status === 'PENDING' ? (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-gold-dark, #8a6b11)' }}>Awaiting reconciliation</div>
            ) : r.status === 'REVERSED' ? (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-danger, #a82a1c)' }}>Reversed</div>
            ) : (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-forest)' }}>Allocated</div>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function PayStatus({ r }: { r: PaymentRow }) {
  if (r.status === 'CONFIRMED' && r.unallocatedKobo === 0) return <Badge variant="success"><span className="inline-flex items-center gap-1"><CheckCircle size={10} />Allocated</span></Badge>;
  if (r.status === 'CONFIRMED') return <Badge variant="warning"><span className="inline-flex items-center gap-1"><Clock size={10} />Unallocated</span></Badge>;
  if (r.status === 'PENDING') return <Badge variant="warning">Pending</Badge>;
  if (r.status === 'DUPLICATE_SUSPECT') return <Badge variant="danger"><span className="inline-flex items-center gap-1"><AlertTriangle size={10} />Duplicate?</span></Badge>;
  if (r.status === 'REVERSED') return <Badge variant="danger"><span className="inline-flex items-center gap-1"><XCircle size={10} />Reversed</span></Badge>;
  if (r.status === 'FAILED' || r.status === 'REJECTED') return <Badge variant="danger">Failed</Badge>;
  return <Badge variant="neutral">{r.status}</Badge>;
}

function StripCell({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default'|'positive'|'warning'|'danger'|'muted' }) {
  const colors = {
    default: 'var(--color-text-primary)', positive: 'var(--color-forest-deep)',
    warning: 'var(--color-gold-dark, #8a6b11)', danger: 'var(--color-danger, #a82a1c)',
    muted: 'var(--color-text-faint)',
  } as const;
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
function formatMethod(m: string) { return m.replace(/_/g,' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
