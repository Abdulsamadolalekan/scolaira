/**
 * Command Center (server component).
 *
 * Deliberate design choices (level 4):
 *  - Greets the human by name; names the active term.
 *  - Five KPI tiles arranged by operator priority: Billed / Collected /
 *    Outstanding / Overdue / Unreconciled. Each has a tiny interpretation
 *    line, not just a number.
 *  - "Needs attention" is not a to-do list; it is the things that will
 *    quietly age into problems if ignored today (overdue balances, pending
 *    bank transfers waiting to be matched, drafts not yet sent).
 *  - Recent activity is human-readable ("Payment of ₦150,000 confirmed by
 *    Chidi Okafor"), not raw audit rows.
 *  - Calm color: forest + gold + ivory. Red is reserved for things that
 *    mean money is at risk; amber for operational attention.
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { KpiCard } from '@/components/ui/kpi-card';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import {
  Naira, Plus, FileText, Users, AlertTriangle, Clock, CheckCircle, ArrowRight, Inbox,
} from '@/components/ui/icons';
import type { Summary } from '@/app/api/dashboard/summary/route';

export const runtime = 'nodejs';

// Server-side fetch using the internal URL (same origin, same host header).
async function loadSummary(): Promise<Summary | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/dashboard/summary`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function CommandCenterPage() {
  const s = await loadSummary();
  if (!s) notFound();

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? 'Still working?'
    : hour < 12 ? 'Good morning'
    : hour < 17 ? 'Good afternoon'
    : 'Good evening';
  const name = s.greetingName ? `, ${s.greetingName}` : '';

  const collectionRate = (s.kpis.collectionRateBps / 100).toFixed(1);
  const hasDanger = s.attention.some(a => a.severity === 'danger');
  const unrec = s.kpis.unreconciledPayments;
  // H-2: the headline's scope is declared by the server, never assumed by the
  // screen. A proprietor can see at a glance whether the figures on this page
  // include debt carried forward from an earlier term.
  const kpiScope = s.scope.kpis;
  const carriedForward = s.buckets.find((b) => b.key === 'PRIOR_TERM');
  const otherTerms = s.buckets.find((b) => b.key === 'OTHER_TERM');
  const formatKobo = (k: number) => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Greeting strip */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] font-medium" style={{ color: 'var(--color-text-faint)' }}>
            {s.termLabel}
          </p>
          <h1
            className="mt-1 text-[22px] sm:text-2xl font-semibold leading-tight tracking-tight"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            {greeting}{name}.
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Here is the financial position, and what needs attention before it ages.
          </p>
          <p className="mt-2 inline-flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <span
              className="rounded-full px-2 py-0.5 font-medium"
              style={{ background: 'var(--color-surface-muted)', color: 'var(--color-text-secondary)' }}
            >
              Headline scope: {kpiScope.label}
              {kpiScope.isDefault ? ' (default)' : ''}
            </span>
            {kpiScope.termName ? <span>Cut-over: {kpiScope.termName} began {kpiScope.cutoverOn}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ServerButton variant="secondary" icon={<Plus size={14} />} href="/invoices/new">New invoice</ServerButton>
          <ServerButton variant="primary" icon={<Naira size={14} />} href="/payments/new">Record payment</ServerButton>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Billed" value={s.kpis.billedKobo} valueIsMoney compact hint={`${s.scope.activeStudents.label.toLowerCase()}`} />
        <KpiCard
          label="Collected"
          value={s.kpis.collectedKobo}
          valueIsMoney compact
          delta={`${collectionRate}%`}
          deltaDirection="up"
          deltaTone="positive"
          hint="of total billed to date"
        />
        <KpiCard
          label="Outstanding"
          value={s.kpis.outstandingKobo}
          valueIsMoney compact
          hint="across issued invoices"
        />
        <KpiCard
          label="Overdue"
          value={s.kpis.overdueKobo}
          valueIsMoney compact
          delta={s.kpis.overdueKobo > 0 ? 'action needed' : 'none'}
          deltaDirection="up"
          deltaTone={s.kpis.overdueKobo > 0 ? 'negative' : 'positive'}
          hint="past due date today"
        />
        <KpiCard
          label="Unreconciled"
          value={s.kpis.unreconciledPayments}
          compact
          hint="payments pending matching"
        />
        <KpiCard
          label="Students"
          value={s.kpis.activeStudents}
          compact
          hint={`${s.scope.activeStudents.label} — not scoped to the headline`}
        />
      </div>

      {/* H-2: the partition the headline was computed from. Carried-forward debt
          is shown on its own line, so it can never be invisible again — which
          was the measured defect this milestone closes. */}
      <div className="mt-3 flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
        <span>
          Classified as{' '}
          {s.buckets.map((b, i) => (
            <span key={b.key}>
              {i > 0 ? ' · ' : ''}
              <span className="font-medium">{b.label}</span>
              {': '}{formatKobo(b.outstandingKobo)}
            </span>
          ))}
        </span>
        {carriedForward && carriedForward.outstandingKobo > 0 ? (
          <Link href="/invoices" className="font-medium underline">
            {formatKobo(carriedForward.outstandingKobo)} carried forward from an earlier term
            {otherTerms && otherTerms.outstandingKobo > 0
              ? ` (+ ${formatKobo(otherTerms.outstandingKobo)} in other terms)`
              : ''}
          </Link>
        ) : null}
      </div>

      {/* Attention + Quick Actions */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Quick actions" description="Things you are likely to do next." />
          <div className="flex flex-col gap-1.5 p-2">
            <QuickAction
              icon={<Naira size={16} />}
              title="Record a payment"
              hint="Mark a bank transfer or cash payment against invoices"
              href="/payments/new"
            />
            <QuickAction
              icon={<FileText size={16} />}
              title="Issue an invoice"
              hint="Create a new term fee invoice for a student"
              href="/invoices/new"
            />
            <QuickAction
              icon={<Inbox size={16} />}
              title="Reconcile pending"
              hint={`Match ${unrec} unallocated payment${unrec === 1 ? '' : 's'}`}
              href="/payments?status=PENDING"
              disabled={unrec === 0}
            />
            <QuickAction
              icon={<Users size={16} />}
              title="Invite a member"
              hint="Add a finance officer or administrator"
              href="/members"
            />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Needs attention"
            description="Items that get worse if you leave them."
            actions={
              s.attention.length > 0 ? (
                <Badge variant={hasDanger ? 'danger' : 'warning'}>
                  {s.attention.length} item{s.attention.length === 1 ? '' : 's'}
                </Badge>
              ) : (
                <Badge variant="success">All clear</Badge>
              )
            }
          />
          {s.attention.length === 0 ? (
            <div className="py-8 px-4">
              <EmptyState
                icon={<CheckCircle size={20} />}
                title="Nothing requires action"
                description="All issued invoices are within their terms and no payments are pending reconciliation."
              />
            </div>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {s.attention.map((a) => (
                <li key={a.id}>
                  <AttentionRow
                    tone={a.severity}
                    title={a.title}
                    meta={a.meta}
                    href={a.href}
                    kind={a.kind}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <Card className="mt-4">
        <CardHeader
          title="Recent activity"
          description="Latest payments and invoices."
          actions={
            <span className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>Last 24 hours</span>
          }
        />
        {s.activity.length === 0 ? (
          <div className="py-8 px-4">
            <EmptyState
              icon={<Clock size={20} />}
              title="No recent activity"
              description="Once invoices are issued and payments begin to arrive, activity will appear here."
            />
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {s.activity.map((ev) => (
              <li key={ev.id} className="py-3 px-5 flex items-center gap-3">
                <div
                  className="h-7 w-7 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor:
                      ev.kind === 'payment_confirmed' ? 'var(--color-forest-tint)' : 'var(--color-bg-page)',
                    color:
                      ev.kind === 'payment_confirmed' ? 'var(--color-forest-deep)' : 'var(--color-text-muted)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  {ev.kind === 'payment_confirmed' ? <CheckCircle size={14} /> : <FileText size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[13.5px] font-medium truncate"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {ev.title}
                  </div>
                  <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {ev.meta}
                  </div>
                </div>
                <div className="text-[11px] shrink-0 tabular-nums" style={{ color: 'var(--color-text-faint)' }}>
                  {relativeTime(ev.at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function QuickAction({
  icon, title, hint, href, disabled,
}: { icon: React.ReactNode; title: string; hint: string; href: string; disabled?: boolean }) {
  const content = (
    <div
      className={
        'w-full text-left flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ' +
        (disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[color:var(--color-forest-tint)]')
      }
    >
      <div
        className="h-7 w-7 mt-0.5 rounded-md flex items-center justify-center shrink-0"
        style={{
          backgroundColor: disabled ? 'var(--color-bg-page)' : 'var(--color-forest-tint)',
          color: disabled ? 'var(--color-text-faint)' : 'var(--color-forest-deep)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {title}
        </div>
        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{hint}</div>
      </div>
      {!disabled && <ArrowRight size={14} className="opacity-40 mt-1" />}
    </div>
  );
  if (disabled) return content;
  return <Link href={href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)] rounded-md">{content}</Link>;
}

const TONE_STYLES: Record<string, { icon: React.ReactNode; dot: string; label: string }> = {
  danger:  { icon: <AlertTriangle size={14} />, dot: 'var(--color-danger, #a82a1c)', label: 'Overdue' },
  warning: { icon: <Clock size={14} />,        dot: 'var(--color-gold)',                       label: 'Pending' },
  info:    { icon: <FileText size={14} />,     dot: 'var(--color-forest)',                     label: 'Draft' },
  neutral: { icon: <CheckCircle size={14} />,  dot: 'var(--color-text-faint)',                 label: 'Note' },
};

function AttentionRow({
  title, meta, tone, href,
}: { title: string; meta: string; tone: 'danger'|'warning'|'info'|'neutral'; href?: string; kind: string }) {
  const tone_ = TONE_STYLES[tone]! || TONE_STYLES.neutral;
  const inner = (
    <div className="px-5 py-3 flex items-start gap-3 hover:bg-[color:var(--color-forest-tint)] transition-colors">
      <div
        className="h-7 w-7 mt-0.5 rounded-full flex items-center justify-center shrink-0"
        style={{
          backgroundColor: `color-mix(in srgb, ${tone_.dot} 12%, transparent)`,
          color: tone_.dot,
          border: `1px solid color-mix(in srgb, ${tone_.dot} 25%, transparent)`,
        }}
      >
        {tone_.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {title}
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{meta}</div>
      </div>
      {href && <ArrowRight size={13} className="opacity-40 mt-1.5" />}
    </div>
  );
  if (!href) return <div>{inner}</div>;
  return <Link href={href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)] rounded-md">{inner}</Link>;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return 'just now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

/**
 * Lightweight server-rendered link styled as a button.
 */
function ServerButton({
  variant = 'primary', icon, href, children,
}: {
  variant?: 'primary' | 'secondary'; icon?: React.ReactNode; href: string; children: React.ReactNode;
}) {
  const primary =
    'bg-[color:var(--color-forest)] text-white hover:bg-[color:var(--color-forest-deep)]';
  const secondary =
    'bg-white text-[color:var(--color-text-primary)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-page)]';
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]';
  return (
    <Link href={href} className={`${base} ${variant === 'primary' ? primary : secondary}`}>
      {icon}{children}
    </Link>
  );
}
