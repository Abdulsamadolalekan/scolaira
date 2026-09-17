/**
 * Invoice detail — institutional view.
 *
 * This is one of SCOLAIRA's flagship surfaces. When a proprietor clicks an
 * invoice, they should instantly understand:
 *
 *   • WHAT is owed
 *   • WHO it is for
 *   • HOW MUCH has been paid
 *   • WHAT remains
 *   • WHEN it was due / how late it is
 *   • WHICH payments have been applied
 *   • WHO did what, and when
 *
 * The page is server-rendered; there is no client state to de-sync from the
 * database. Numbers are kobo-precise and come from trigger-maintained columns
 * (total_kobo, paid_kobo), so a refresh always tells the truth.
 *
 * Mobile layout is recomposed, not compressed:
 *   • Header status + student on top
 *   • Money ladder as a vertical strip (not a wide table)
 *   • Allocations as cards
 *   • Activity as a quiet timeline
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import {
  FileText, ArrowLeft, CheckCircle, Clock, Naira, XCircle,
  Calendar, User, Hash, Receipt,
} from '@/components/ui/icons';
import type { InvoiceDetail } from '@/app/api/invoices/[id]/route';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const guard = await checkPermission('invoice.read');
  if (!guard.allowed) {
    return <AccessDenied surface="Invoice detail" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  }
  return <InvoiceDetailInner params={params} />;
}

async function InvoiceDetailInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = await loadInvoice(id);
  if (!inv) notFound();
  return <InvoiceDetailShell inv={inv} />;
}

async function loadInvoice(id: string): Promise<InvoiceDetail | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/invoices/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

async function InvoiceDetailShell({ inv }: { inv: InvoiceDetail }) {
  const paidPct = inv.totalKobo > 0 ? Math.min(100, Math.round((inv.paidKobo / inv.totalKobo) * 100)) : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Back + context */}
      <div className="mb-5">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1 text-[12px] font-medium"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft size={12} /> Invoices
        </Link>
      </div>

      {/* Header */}
      <Card>
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={inv.status} overdue={inv.isDue} />
                {inv.isDue && inv.remainingKobo > 0 && (
                  <span className="text-[11px] font-medium" style={{ color: 'var(--color-danger, #a82a1c)' }}>
                    {inv.daysOverdue} day{inv.daysOverdue === 1 ? '' : 's'} overdue
                  </span>
                )}
              </div>
              <h1
                className="mt-2 text-[22px] sm:text-2xl font-semibold tracking-tight tabular-nums"
                style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
              >
                {inv.invoiceNumber}
              </h1>
              <div className="mt-2 flex flex-col gap-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                <span className="inline-flex items-center gap-1.5">
                  <User size={13} style={{ color: 'var(--color-text-faint)' }} />
                  <span style={{ color: 'var(--color-text-primary)' }}>{inv.student.name}</span>
                  <span className="tabular-nums" style={{ color: 'var(--color-text-faint)' }}>
                    ({inv.student.studentId})
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar size={13} style={{ color: 'var(--color-text-faint)' }} />
                  {termSession(inv)}
                </span>
                {(inv.issueDate || inv.dueDate) && (
                  <span className="inline-flex items-center gap-1.5">
                    <Hash size={13} style={{ color: 'var(--color-text-faint)' }} />
                    {inv.issueDate ? <>Issued {inv.issueDate}</> : <em style={{ color: 'var(--color-text-faint)' }}>Not yet issued</em>}
                    {inv.dueDate && <> · Due {inv.dueDate}</>}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>
                  Total due
                </div>
                <div className="mt-0.5 text-2xl font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
                  <Money kobo={inv.totalKobo} />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" iconLeft={<Receipt size={13} />}>Send reminder</Button>
                <Button size="sm" variant="primary" iconLeft={<Naira size={13} />}>Record payment</Button>
              </div>
            </div>
          </div>

          {/* Money ladder */}
          <div className="mt-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-bg-page)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${paidPct}%`,
                  backgroundColor: inv.status === 'PAID'
                    ? 'var(--color-forest)'
                    : inv.isDue ? 'var(--color-danger, #a82a1c)' : 'var(--color-gold)',
                }}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <LadderCell label="Billed" value={<Money kobo={inv.totalKobo} />} />
              <LadderCell label="Paid" value={<Money kobo={inv.paidKobo} />} tone="positive" />
              <LadderCell
                label="Remaining"
                value={<Money kobo={inv.remainingKobo} />}
                tone={inv.remainingKobo === 0 ? 'muted' : inv.isDue ? 'danger' : 'warning'}
              />
              <LadderCell
                label={inv.isDue ? 'Overdue' : 'Current'}
                value={<Money kobo={inv.overdueKobo || inv.remainingKobo} />}
                tone={inv.isDue ? 'danger' : inv.remainingKobo === 0 ? 'muted' : 'positive'}
              />
            </div>
          </div>

          {inv.memo && (
            <div className="mt-5 rounded-md border px-4 py-3 text-sm" style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}>
              <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>Note</div>
              <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>{inv.memo}</div>
            </div>
          )}

          {inv.status === 'VOID' && inv.voidedReason && (
            <div className="mt-5 rounded-md border px-4 py-3 text-sm" style={{ borderColor: 'var(--color-danger, #a82a1c)', backgroundColor: 'color-mix(in srgb, var(--color-danger, #a82a1c) 4%, white)' }}>
              <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-danger, #a82a1c)' }}>Voided</div>
              <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                {inv.voidedReason}{inv.voidedBy ? ` — ${inv.voidedBy}` : ''}{inv.voidedAt ? `, ${inv.voidedAt}` : ''}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Body */}
      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        {/* Lines */}
        <Card className="lg:col-span-3">
          <CardHeader title="Line items" description="What this invoice is for." />
          {inv.lines.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<FileText size={18} />}
                title="No line items yet"
                description={inv.status === 'DRAFT' ? 'Add fee items before issuing this invoice.' : 'This invoice was issued without breakdown detail.'}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <th className="px-5 py-2.5 text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>Item</th>
                    <th className="px-3 py-2.5 text-right text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>Qty</th>
                    <th className="px-3 py-2.5 text-right text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>Rate</th>
                    <th className="px-5 py-2.5 text-right text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      <td className="px-5 py-3">
                        <div style={{ color: 'var(--color-text-primary)' }}>{l.description}</div>
                        {l.adjustmentKobo !== 0 && (
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-faint)' }}>
                            {l.adjustmentKobo < 0 ? 'Discount' : 'Adjustment'}: <Money kobo={Math.abs(l.adjustmentKobo)} />
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>{l.quantity}</td>
                      <td className="px-3 py-3 text-right tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                        {l.unitRateKobo != null ? <Money kobo={l.unitRateKobo} /> : '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-medium tabular-nums" style={{ color: 'var(--color-text-primary)' }}>
                        <Money kobo={l.amountKobo} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="px-5 py-3 text-right text-[12px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>Total</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
                      <Money kobo={inv.totalKobo} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Meta */}
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <dl className="p-5 pt-0 grid grid-cols-1 gap-3 text-sm">
            <MetaRow label="Invoice number">{inv.invoiceNumber}</MetaRow>
            <MetaRow label="Student">
              <span style={{ color: 'var(--color-text-primary)' }}>{inv.student.name}</span>
              <span className="tabular-nums ml-1" style={{ color: 'var(--color-text-faint)' }}>
                ({inv.student.studentId})
              </span>
            </MetaRow>
            {inv.term && <MetaRow label="Term">{inv.term.name}</MetaRow>}
            {inv.session && <MetaRow label="Session">{inv.session.name}</MetaRow>}
            <MetaRow label="Issue date">{inv.issueDate ?? <span style={{ color: 'var(--color-text-faint)' }}>Not issued</span>}</MetaRow>
            <MetaRow label="Due date">{inv.dueDate ?? <span style={{ color: 'var(--color-text-faint)' }}>—</span>}</MetaRow>
            {inv.issuedBy && <MetaRow label="Issued by">{inv.issuedBy}</MetaRow>}
            <MetaRow label="Created">{inv.createdAt ?? '—'}</MetaRow>
          </dl>
        </Card>
      </div>

      {/* Allocations + Activity */}
      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="Payments applied"
            description={`${inv.allocations.filter(a => a.status === 'ACTIVE').length} payment${inv.allocations.filter(a => a.status === 'ACTIVE').length === 1 ? '' : 's'} allocated to this invoice.`}
          />
          {inv.allocations.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<Naira size={18} />}
                title={inv.status === 'DRAFT' ? 'No payments yet' : 'Awaiting payment'}
                description={
                  inv.status === 'DRAFT'
                    ? 'Payments can be applied once the invoice is issued.'
                    : inv.remainingKobo > 0
                      ? `When a payment arrives and is matched to this invoice, it will appear here. ${formatKobo(inv.remainingKobo)} remains.`
                      : 'This invoice has been paid in full.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {inv.allocations.map((a) => (
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
                    {a.status === 'REVERSED' ? <XCircle size={14} /> : <CheckCircle size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-[13.5px] font-medium tabular-nums" style={{ color: 'var(--color-text-primary)' }}>
                        <Money kobo={a.amountKobo} />
                      </div>
                      <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>
                        {formatMethod(a.method)}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      <Link href={`/payments/${a.paymentId}`} className="font-medium" style={{ color: 'var(--color-forest)' }}>
                        {a.paymentNumber}
                      </Link>
                      {a.payerName ? <> · {a.payerName}</> : null}
                      {a.reference ? <> · ref {a.reference}</> : null}
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-faint)' }}>
                      {a.status === 'REVERSED'
                        ? <>Reversed{a.reversedBy ? ` by ${a.reversedBy}` : ''}{a.reversedAt ? ` · ${formatTime(a.reversedAt)}` : ''}</>
                        : <>Allocated{a.allocatedBy ? ` by ${a.allocatedBy}` : ''}{a.allocatedAt ? ` · ${formatTime(a.allocatedAt)}` : ''}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="History" description="What happened, in order." />
          {inv.activity.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<Clock size={18} />}
                title="No recorded activity"
                description="Events will appear as payments arrive and the invoice changes state."
              />
            </div>
          ) : (
            <ol className="px-5 py-3">
              {inv.activity.map((ev, i) => (
                <li key={ev.id} className="relative pl-6 pb-4 last:pb-0">
                  {i < inv.activity.length - 1 && (
                    <span
                      className="absolute left-[9px] top-3 bottom-0 w-px"
                      style={{ backgroundColor: 'var(--color-border-subtle)' }}
                    />
                  )}
                  <span
                    className="absolute left-0 top-1.5 h-[18px] w-[18px] rounded-full flex items-center justify-center"
                    style={{
                      backgroundColor: ev.action.includes('reversed') || ev.action.includes('void')
                        ? 'color-mix(in srgb, var(--color-danger, #a82a1c) 10%, white)'
                        : 'var(--color-forest-tint)',
                      color: ev.action.includes('reversed') || ev.action.includes('void')
                        ? 'var(--color-danger, #a82a1c)' : 'var(--color-forest-deep)',
                      border: '1px solid var(--color-border-subtle)',
                    }}
                  >
                    {ev.action.includes('reversed') || ev.action.includes('void')
                      ? <XCircle size={10} />
                      : ev.action.includes('allocated') || ev.action.includes('payment')
                        ? <Naira size={10} /> : <FileText size={10} />}
                  </span>
                  <div className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{ev.title}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-faint)' }}>
                    {formatTime(ev.at)}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

function LadderCell({ label, value, tone = 'default' }: {
  label: string; value: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'danger' | 'muted';
}) {
  const colorMap = {
    default: 'var(--color-text-primary)',
    positive: 'var(--color-forest-deep)',
    warning: 'var(--color-gold-dark, #8a6b11)',
    danger: 'var(--color-danger, #a82a1c)',
    muted: 'var(--color-text-faint)',
  } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colorMap[tone] }}>{value}</div>
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

function StatusBadge({ status, overdue }: { status: InvoiceDetail['status']; overdue: boolean }) {
  let variant: 'neutral' | 'success' | 'warning' | 'danger' = 'neutral';
  let label: string = status;
  if (status === 'PAID') { variant = 'success'; label = 'Paid in full'; }
  else if (status === 'PARTIALLY_PAID') { variant = overdue ? 'danger' : 'warning'; label = overdue ? 'Partially paid · overdue' : 'Partially paid'; }
  else if (status === 'ISSUED') { variant = overdue ? 'danger' : 'warning'; label = overdue ? 'Overdue' : 'Awaiting payment'; }
  else if (status === 'DRAFT') { variant = 'neutral'; label = 'Draft'; }
  else if (status === 'VOID') { variant = 'neutral'; label = 'Void'; }
  return <Badge variant={variant}>{label}</Badge>;
}

function termSession(inv: InvoiceDetail) {
  const parts: string[] = [];
  if (inv.term?.name) parts.push(inv.term.name);
  if (inv.session?.name) parts.push(inv.session.name);
  return parts.join(' · ') || <span style={{ color: 'var(--color-text-faint)' }}>Term not set</span>;
}

function formatMethod(m: string) {
  return m.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatKobo(k: number) {
  return '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
