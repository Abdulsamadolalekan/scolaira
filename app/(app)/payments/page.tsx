/**
 * Payments register.
 *
 * A payment is money the school has received (or is waiting to receive).
 * Unlike invoices, a payment can be unallocated, partially allocated, fully
 * allocated, or reversed. The register makes that state unmistakable at a
 * glance.
 */
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import {
  Naira,
  Plus,
  Clock,
  AlertTriangle,
  ChevronRight,
  CheckCircle,
  XCircle,
} from '@/components/ui/icons';
import type { PaymentRow } from '@/app/api/payments/route';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

async function loadPayments(): Promise<PaymentRow[]> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return [];
  const res = await fetch(`${base}/api/payments`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.payments as PaymentRow[]) ?? [];
}

function stats(rows: PaymentRow[]) {
  let received = 0,
    pending = 0,
    pendingCount = 0,
    unallocated = 0;
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
  const guard = await checkPermission('payment.read');
  if (!guard.allowed) {
    return (
      <AccessDenied
        surface="Payments"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  }
  const rows = await loadPayments();
  const s = stats(rows);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Payments"
        lede="Cash, bank transfers, card payments — and which invoices they settle."
        actions={
          <>
            <Link
              href="/payments/new"
              className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--color-forest-deep)] px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]"
            >
              <Plus size={14} /> Record payment
            </Link>
          </>
        }
      />

      <dl className="mb-6 mt-3 grid grid-cols-2 border-y border-ink-faint sm:grid-cols-4">
        <StripCell label="Received" value={<Money kobo={s.received} size="lg" />} tone="positive" />
        <StripCell
          rule
          label={s.pendingCount ? `${s.pendingCount} pending` : 'No pending'}
          value={<Money kobo={s.pending} size="lg" />}
          tone={s.pendingCount ? 'warning' : 'muted'}
        />
        <StripCell
          rule
          label="Unallocated"
          value={<Money kobo={s.unallocated} size="lg" />}
          tone={s.unallocated > 0 ? 'warning' : 'muted'}
        />
        <StripCell
          rule
          label="Total records"
          value={<span className="tabular-nums">{rows.length}</span>}
        />
      </dl>

      <Card className="mt-4">
        <CardHeader
          title={rows.length === 0 ? 'No payments yet' : 'Payments register'}
          description={
            rows.length === 0
              ? 'When you record a cash payment or confirm a bank transfer, it appears here.'
              : `${rows.length} payment${rows.length === 1 ? '' : 's'} on record.`
          }
        />
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Naira size={22} />}
              title="No payments yet"
              description="Record a payment when money is received — we walk you through matching it to invoices so balances stay exact."
            />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                  >
                    <Th>Payment</Th>
                    <Th>Payer</Th>
                    <Th>Method</Th>
                    <Th className="text-right">Amount</Th>
                    <Th className="text-right">Allocated</Th>
                    <Th className="text-right">Remaining</Th>
                    <Th>When</Th>
                    <th className="w-8 px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <DesktopRow key={r.id} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
            <ul
              className="divide-y md:hidden"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {rows.map((r) => (
                <MobileRow key={r.id} r={r} />
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function DesktopRow({ r }: { r: PaymentRow }) {
  return (
    <tr
      className="transition-colors hover:bg-[color:var(--color-forest-tint)]"
      style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
    >
      <td className="px-4 py-3 align-top">
        <Link
          href={`/payments/${r.id}`}
          className="font-medium tabular-nums"
          style={{ color: 'var(--color-forest)' }}
        >
          {r.paymentNumber}
        </Link>
        <div className="mt-0.5">
          <PayStatus r={r} />
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <div style={{ color: 'var(--color-text-primary)' }}>
          {r.payerName || <span style={{ color: 'var(--color-text-faint)' }}>Unknown payer</span>}
        </div>
        {r.reference && (
          <div
            className="font-mono text-[11px] tabular-nums"
            style={{ color: 'var(--color-text-faint)' }}
          >
            {r.reference}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top" style={{ color: 'var(--color-text-secondary)' }}>
        {formatMethod(r.method)}
      </td>
      <td
        className="px-3 py-3 text-right align-top tabular-nums"
        style={{ color: 'var(--color-text-primary)' }}
      >
        <Money kobo={r.amountKobo} size="sm" />
      </td>
      <td
        className="px-3 py-3 text-right align-top tabular-nums"
        style={{ color: 'var(--color-forest-deep)' }}
      >
        <Money kobo={r.allocatedKobo} size="sm" />
      </td>
      <td
        className="px-3 py-3 text-right align-top font-medium tabular-nums"
        style={{
          color:
            r.status === 'CONFIRMED' && r.unallocatedKobo > 0
              ? 'var(--color-gold-dark, #8a6b11)'
              : 'var(--color-text-faint)',
        }}
      >
        {r.unallocatedKobo > 0 && r.status !== 'REVERSED' ? (
          <Money kobo={r.unallocatedKobo} size="sm" />
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-3 align-top">
        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          {r.paidAt ?? r.recordedAt ?? '—'}
        </span>
      </td>
      <td className="px-3 py-3 pr-4 text-right align-top">
        <ChevronRight size={14} className="inline opacity-40" />
      </td>
    </tr>
  );
}

function MobileRow({ r }: { r: PaymentRow }) {
  return (
    <li>
      <Link
        href={`/payments/${r.id}`}
        className="block px-4 py-4 active:bg-[color:var(--color-forest-tint)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="text-[14px] font-medium tabular-nums"
                style={{ color: 'var(--color-forest)' }}
              >
                {r.paymentNumber}
              </span>
              <PayStatus r={r} />
            </div>
            <div className="mt-1 text-[13px]" style={{ color: 'var(--color-text-primary)' }}>
              {r.payerName || (
                <span style={{ color: 'var(--color-text-faint)' }}>Unknown payer</span>
              )}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
              {formatMethod(r.method)}
              {r.reference ? ` · ${r.reference}` : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div
              className="text-[13px] font-semibold tabular-nums"
              style={{ color: 'var(--color-forest-deepest)' }}
            >
              <Money kobo={r.amountKobo} size="sm" hideDecimals />
            </div>
            {r.status === 'CONFIRMED' && r.unallocatedKobo > 0 ? (
              <div
                className="mt-0.5 text-[11px] tabular-nums"
                style={{ color: 'var(--color-gold-dark, #8a6b11)' }}
              >
                <Money kobo={r.unallocatedKobo} size="sm" hideDecimals /> unallocated
              </div>
            ) : r.status === 'PENDING' ? (
              <div
                className="mt-0.5 text-[11px]"
                style={{ color: 'var(--color-gold-dark, #8a6b11)' }}
              >
                Awaiting reconciliation
              </div>
            ) : r.status === 'REVERSED' ? (
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-danger, #a82a1c)' }}>
                Reversed
              </div>
            ) : (
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-forest)' }}>
                Allocated
              </div>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function PayStatus({ r }: { r: PaymentRow }) {
  if (r.status === 'CONFIRMED' && r.unallocatedKobo === 0)
    return (
      <Badge variant="success">
        <span className="inline-flex items-center gap-1">
          <CheckCircle size={10} />
          Allocated
        </span>
      </Badge>
    );
  if (r.status === 'CONFIRMED')
    return (
      <Badge variant="warning">
        <span className="inline-flex items-center gap-1">
          <Clock size={10} />
          Unallocated
        </span>
      </Badge>
    );
  if (r.status === 'PENDING') return <Badge variant="warning">Pending</Badge>;
  if (r.status === 'DUPLICATE_SUSPECT')
    return (
      <Badge variant="danger">
        <span className="inline-flex items-center gap-1">
          <AlertTriangle size={10} />
          Duplicate?
        </span>
      </Badge>
    );
  if (r.status === 'REVERSED')
    return (
      <Badge variant="danger">
        <span className="inline-flex items-center gap-1">
          <XCircle size={10} />
          Reversed
        </span>
      </Badge>
    );
  if (r.status === 'FAILED' || r.status === 'REJECTED')
    return <Badge variant="danger">Failed</Badge>;
  return <Badge variant="neutral">{r.status}</Badge>;
}

function StripCell({
  label,
  value,
  tone = 'default',
  rule,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'danger' | 'muted';
  rule?: boolean;
}) {
  const colors = {
    default: 'var(--color-ink-primary)',
    positive: 'var(--color-forest-deep)',
    warning: 'var(--color-gold-dark, #8a6b11)',
    danger: 'var(--color-danger-fg)',
    muted: 'var(--color-ink-subtle)',
  } as const;
  return (
    <div className={`px-4 py-3.5 ${rule ? 'border-l border-ink-faint' : ''}`}>
      <dt className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{label}</dt>
      <dd className="mt-1 tabular-nums" style={{ color: colors[tone] }}>
        {value}
      </dd>
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
function formatMethod(m: string) {
  return m
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
