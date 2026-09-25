/**
 * Payment detail — institutional view.
 *
 * When a bursar clicks a payment (a bank transfer, a cash deposit, a POS
 * payment), they need to understand in 3 seconds: has the money been
 * reconciled? Which invoices did it settle? Is any amount sitting
 * unallocated? Was anything reversed?
 *
 * Mirror of the invoice detail but organised around money arriving, not
 * money owed. The money ladder here is: Amount received → Allocated →
 * Remaining to allocate. Red means something reversed; gold means waiting;
 * green means settled.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import PaymentActions from './payment-actions';
import {
  Naira, ArrowLeft, Clock, AlertTriangle, XCircle,
  Calendar, User, Hash, FileText, Phone, Mail,
} from '@/components/ui/icons';
import type { PaymentDetail } from '@/app/api/payments/[id]/route';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const guard = await checkPermission('payment.read');
  if (!guard.allowed) {
    return <AccessDenied surface="Payment detail" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  }
  return <PaymentDetailInner params={params} />;
}

async function PaymentDetailInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadPayment(id);
  if (!p) notFound();
  return <PaymentDetailShell p={p} id={id} />;
}

async function loadPayment(id: string): Promise<PaymentDetail | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/payments/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

async function PaymentDetailShell({ p, id }: { p: PaymentDetail; id: string }) {
  const allocatedPct = p.amountKobo > 0 ? Math.round((p.allocatedKobo / p.amountKobo) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-5">
        <Link href="/payments" className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={12} /> Payments
        </Link>
      </div>

      <Card>
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <PayStatus p={p} />
              </div>
              <h1 className="mt-2 text-[22px] sm:text-2xl font-semibold tracking-tight tabular-nums"
                  style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>
                {p.paymentNumber}
              </h1>
              <div className="mt-2 flex flex-col gap-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                <span className="inline-flex items-center gap-1.5">
                  <Naira size={13} style={{ color: 'var(--color-text-faint)' }} />
                  <span style={{ color: 'var(--color-text-primary)' }}>{formatMethod(p.method)}</span>
                  {p.reference && <>
                    <span style={{ color: 'var(--color-text-faint)' }}>· ref</span>
                    <span className="font-mono text-[12px]" style={{ color: 'var(--color-text-primary)' }}>{p.reference}</span>
                  </>}
                </span>
                {p.payerName && <span className="inline-flex items-center gap-1.5">
                  <User size={13} style={{ color: 'var(--color-text-faint)' }} />
                  <span style={{ color: 'var(--color-text-primary)' }}>{p.payerName}</span>
                </span>}
                {(p.paidAt || p.recordedAt) && <span className="inline-flex items-center gap-1.5">
                  <Calendar size={13} style={{ color: 'var(--color-text-faint)' }} />
                  {p.paidAt ?? p.recordedAt}
                </span>}
                {p.recordedBy && <span className="inline-flex items-center gap-1.5">
                  <Hash size={13} style={{ color: 'var(--color-text-faint)' }} />
                  Recorded by <span style={{ color: 'var(--color-text-primary)' }}>{p.recordedBy}</span>
                </span>}
              </div>
            </div>
            <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>Amount received</div>
                <div className="mt-0.5 text-2xl font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
                  <Money kobo={p.amountKobo} />
                </div>
              </div>
              {p.status === 'CONFIRMED' && (
                <Link href={`/payments/${id}/receipt`}
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium"
                      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}>
                  Print receipt
                </Link>
              )}
            </div>
          </div>

          {/* Money ladder */}
          <div className="mt-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-bg-page)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${allocatedPct}%`,
                  backgroundColor: p.status === 'REVERSED' || p.status === 'FAILED'
                    ? 'var(--color-danger, #a82a1c)'
                    : p.unallocatedKobo > 0 ? 'var(--color-gold)' : 'var(--color-forest)',
                }}
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <LadderCell label="Received" value={<Money kobo={p.amountKobo} />} />
              <LadderCell label="Allocated" value={<Money kobo={p.allocatedKobo} />} tone="positive" />
              <LadderCell
                label={p.unallocatedKobo > 0 ? 'Unallocated' : 'Fully allocated'}
                value={p.unallocatedKobo > 0 ? <Money kobo={p.unallocatedKobo} /> : <span style={{ color: 'var(--color-forest)' }}>—</span>}
                tone={p.unallocatedKobo > 0 ? 'warning' : 'muted'}
              />
            </div>
          </div>

          <PaymentActions paymentId={p.id} status={p.status} unallocatedKobo={p.unallocatedKobo} />

          {p.reversal && (
            <div className="mt-5 rounded-md border px-4 py-3 text-sm"
                 style={{ borderColor: 'var(--color-danger, #a82a1c)', backgroundColor: 'color-mix(in srgb, var(--color-danger, #a82a1c) 4%, white)' }}>
              <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-danger, #a82a1c)' }}>
                Reversed — {p.reversal.reversalNumber}
              </div>
              <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                {p.reversal.reason} · <span className="font-medium tabular-nums"><Money kobo={p.reversal.amountKobo} /></span>
                {p.reversal.reversedBy ? ` · reversed by ${p.reversal.reversedBy}` : ''}
                {p.reversal.reversedAt ? ` · ${p.reversal.reversedAt}` : ''}
              </div>
            </div>
          )}

          {p.status === 'PENDING' && (
            <div className="mt-5 rounded-md border px-4 py-3 text-sm"
                 style={{ borderColor: 'var(--color-gold)', backgroundColor: 'color-mix(in srgb, var(--color-gold) 8%, white)' }}>
              <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-gold-dark, #8a6b11)' }}>
                Awaiting reconciliation
              </div>
              <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                This payment is logged but not yet confirmed against a bank statement. It will not appear on invoices until it is confirmed and allocated. <strong>Your money is safe.</strong>
              </div>
            </div>
          )}

          {p.notes && (
            <div className="mt-5 rounded-md border px-4 py-3 text-sm"
                 style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}>
              <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>Note</div>
              <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>{p.notes}</div>
            </div>
          )}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="Allocated to invoices"
            description={
              p.allocations.filter(a => a.status === 'ACTIVE').length === 0
                ? 'Not yet allocated to any invoice.'
                : `${p.allocations.filter(a => a.status === 'ACTIVE').length} invoice${p.allocations.filter(a => a.status === 'ACTIVE').length === 1 ? '' : 's'} settled by this payment.`
            }
          />
          {p.allocations.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<FileText size={18} />}
                title={p.status === 'PENDING' ? 'Awaiting confirmation' : 'Not yet allocated'}
                description={p.status === 'PENDING'
                  ? 'Once the payment is confirmed, you can match it against one or more outstanding invoices.'
                  : p.unallocatedKobo > 0
                    ? `${fmtKobo(p.unallocatedKobo)} is waiting to be matched to an invoice.`
                    : 'This payment has been fully applied.'}
              />
            </div>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {p.allocations.map(a => (
                <li key={a.id} className="px-5 py-3.5 flex items-start gap-3">
                  <div
                    className="h-7 w-7 mt-0.5 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      backgroundColor: a.status === 'REVERSED'
                        ? 'color-mix(in srgb, var(--color-danger, #a82a1c) 10%, white)'
                        : 'var(--color-forest-tint)',
                      color: a.status === 'REVERSED' ? 'var(--color-danger, #a82a1c)' : 'var(--color-forest-deep)',
                      border: `1px solid ${a.status === 'REVERSED' ? 'color-mix(in srgb, var(--color-danger, #a82a1c) 25%, transparent)' : 'var(--color-border-subtle)'}`,
                    }}
                  >
                    {a.status === 'REVERSED' ? <XCircle size={14} /> : <FileText size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link href={`/invoices/${a.invoiceId}`} className="text-[13.5px] font-medium tabular-nums"
                            style={{ color: 'var(--color-forest)' }}>
                        {a.invoiceNumber}
                      </Link>
                      <div className="text-[13.5px] font-semibold tabular-nums" style={{ color: 'var(--color-text-primary)' }}>
                        <Money kobo={a.amountKobo} />
                      </div>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      {a.studentName}
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-faint)' }}>
                      {a.status === 'REVERSED'
                        ? <>Reversed{a.reversedBy ? ` by ${a.reversedBy}` : ''}{a.reversedAt ? ` · ${relTime(a.reversedAt)}` : ''}</>
                        : <>Allocated{a.allocatedBy ? ` by ${a.allocatedBy}` : ''}{a.allocatedAt ? ` · ${relTime(a.allocatedAt)}` : ''}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <dl className="p-5 pt-0 grid grid-cols-1 gap-3 text-sm">
            <MetaRow label="Payment number">{p.paymentNumber}</MetaRow>
            <MetaRow label="Method">{formatMethod(p.method)}</MetaRow>
            {p.payerName && <MetaRow label="Payer">{p.payerName}</MetaRow>}
            {p.payerPhone && <MetaRow label="Phone"><span className="inline-flex items-center gap-1"><Phone size={11} />{p.payerPhone}</span></MetaRow>}
            {p.payerEmail && <MetaRow label="Email"><span className="inline-flex items-center gap-1"><Mail size={11} />{p.payerEmail}</span></MetaRow>}
            <MetaRow label="Reference">{p.reference ? <span className="font-mono tabular-nums">{p.reference}</span> : <span style={{ color: 'var(--color-text-faint)' }}>—</span>}</MetaRow>
            <MetaRow label="Paid at">{p.paidAt ?? <span style={{ color: 'var(--color-text-faint)' }}>Not yet</span>}</MetaRow>
            <MetaRow label="Recorded by">{p.recordedBy ?? '—'}</MetaRow>
            <MetaRow label="Recorded at">{p.recordedAt ?? '—'}</MetaRow>
          </dl>
        </Card>
      </div>

      {/* Activity */}
      <Card className="mt-4">
        <CardHeader title="History" description="What happened to this payment, in order." />
        {p.activity.length === 0 ? (
          <div className="p-5">
            <EmptyState icon={<Clock size={18} />} title="No recorded activity" description="Events will appear as the payment is confirmed and allocated." />
          </div>
        ) : (
          <ol className="px-5 py-3">
            {p.activity.map((ev, i) => (
              <li key={ev.id} className="relative pl-6 pb-4 last:pb-0">
                {i < p.activity.length - 1 && (
                  <span className="absolute left-[9px] top-3 bottom-0 w-px" style={{ backgroundColor: 'var(--color-border-subtle)' }} />
                )}
                <span
                  className="absolute left-0 top-1.5 h-[18px] w-[18px] rounded-full flex items-center justify-center"
                  style={{
                    backgroundColor: ev.action.includes('reversed') || ev.action.includes('failed')
                      ? 'color-mix(in srgb, var(--color-danger, #a82a1c) 10%, white)'
                      : ev.action.includes('allocated') ? 'var(--color-forest-tint)' : 'var(--color-bg-page)',
                    color: ev.action.includes('reversed') || ev.action.includes('failed')
                      ? 'var(--color-danger, #a82a1c)' : 'var(--color-forest-deep)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  {ev.action.includes('reversed') || ev.action.includes('failed')
                    ? <XCircle size={10} />
                    : ev.action.includes('allocated') ? <FileText size={10} /> : <Naira size={10} />}
                </span>
                <div className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{ev.title}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-faint)' }}>{relTime(ev.at)} · {ev.actor}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function LadderCell({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default'|'positive'|'warning'|'danger'|'muted' }) {
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

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-[11px] uppercase tracking-wider font-medium shrink-0" style={{ color: 'var(--color-text-faint)' }}>{label}</dt>
      <dd className="text-right text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{children}</dd>
    </div>
  );
}

function PayStatus({ p }: { p: PaymentDetail }) {
  if (p.status === 'CONFIRMED' && p.unallocatedKobo === 0) return <Badge variant="success">Fully allocated</Badge>;
  if (p.status === 'CONFIRMED') return <Badge variant="warning">Partially allocated</Badge>;
  if (p.status === 'PENDING') return <Badge variant="warning">Pending reconciliation</Badge>;
  if (p.status === 'DUPLICATE_SUSPECT') return <Badge variant="danger"><span className="inline-flex items-center gap-1"><AlertTriangle size={10} />Duplicate suspect</span></Badge>;
  if (p.status === 'REVERSED') return <Badge variant="danger"><span className="inline-flex items-center gap-1"><XCircle size={10} />Reversed</span></Badge>;
  if (p.status === 'REFUNDED') return <Badge variant="danger">Refunded</Badge>;
  if (p.status === 'FAILED' || p.status === 'REJECTED') return <Badge variant="danger">Failed</Badge>;
  return <Badge variant="neutral">{p.status}</Badge>;
}

function formatMethod(m: string) { return m.replace(/_/g,' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function fmtKobo(k: number) { return '₦' + (k/100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  const m = Math.floor(diff / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24); if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}
