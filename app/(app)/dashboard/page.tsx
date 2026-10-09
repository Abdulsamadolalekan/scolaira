/**
 * Command Center (server component) — THE POSITION.
 *
 * Redesign (2026-09): the previous screen was six equally-weighted KPI cards.
 * A proprietor opening it could not tell whether the school was funded or in
 * trouble, because "₦1.0M billed" and "3 students" were the same size in the
 * same box. This composition answers, in order:
 *
 *   1. WHAT IS THE POSITION?      → one dominant figure (money actually in)
 *   2. HOW DOES THAT COMPARE?     → collection rate against what was billed
 *   3. WHAT IS STILL OWED?        → outstanding, overdue, unreconciled
 *   4. WHAT NEEDS ACTION TODAY?   → the attention queue, with severity
 *   5. WHAT JUST HAPPENED?        → the ledger of recent activity
 *
 * Every figure, scope label, classification and link is unchanged: this is a
 * recomposition of the same server data, not a change to what is computed.
 *
 * Deliberate invariants kept from before:
 *  - The H-2 classification (this term / carried forward / other terms) stays
 *    on screen: the partition the headline was computed from must never be
 *    invisible again.
 *  - The declared headline scope stays on screen, in the server's own words.
 *  - Red is reserved for money at risk; gold for the commitment.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader, SectionHead } from '@/components/ui/page-header';
import {
  Naira,
  Plus,
  FileText,
  Users,
  AlertTriangle,
  Clock,
  CheckCircle,
  ArrowRight,
  Inbox,
} from '@/components/ui/icons';
import type { Summary } from '@/app/api/dashboard/summary/route';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';

export const runtime = 'nodejs';

// Server-side fetch using the internal URL (same origin, same host header).
async function loadSummary(): Promise<Summary | null> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return null;
  const res = await fetch(`${base}/api/dashboard/summary`, {
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
    hour < 5
      ? 'Still working?'
      : hour < 12
        ? 'Good morning'
        : hour < 17
          ? 'Good afternoon'
          : 'Good evening';
  const name = s.greetingName ? `, ${s.greetingName}` : '';

  const collectionRate = s.kpis.collectionRateBps / 100;
  const ratePct = collectionRate.toFixed(1);
  const hasDanger = s.attention.some((a) => a.severity === 'danger');
  const unrec = s.kpis.unreconciledPayments;
  // H-2: the headline's scope is declared by the server, never assumed by the
  // screen. A proprietor can see at a glance whether the figures on this page
  // include debt carried forward from an earlier term.
  const kpiScope = s.scope.kpis;
  const carriedForward = s.buckets.find((b) => b.key === 'PRIOR_TERM');
  const otherTerms = s.buckets.find((b) => b.key === 'OTHER_TERM');
  const formatKobo = (k: number) =>
    '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const measures = [
    {
      key: 'outstanding',
      label: 'Outstanding',
      value: formatKobo(s.kpis.outstandingKobo),
      hint: 'across issued invoices',
      tone: 'default' as const,
    },
    {
      key: 'overdue',
      label: 'Overdue',
      value: formatKobo(s.kpis.overdueKobo),
      hint: s.kpis.overdueKobo > 0 ? 'past due today' : 'nothing past due',
      tone: s.kpis.overdueKobo > 0 ? ('danger' as const) : ('default' as const),
    },
    {
      key: 'unreconciled',
      label: 'Unreconciled',
      value: String(unrec),
      hint: unrec === 1 ? 'payment pending match' : 'payments pending match',
      tone: unrec > 0 ? ('attention' as const) : ('default' as const),
    },
    {
      key: 'students',
      label: 'Students',
      value: String(s.kpis.activeStudents),
      hint: s.scope.activeStudents.label,
      tone: 'default' as const,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8 md:py-10">
      <PageHeader
        eyebrow={s.termLabel}
        title={`${greeting}${name}.`}
        lede="The school's financial position, and what needs attention before it ages."
        actions={
          <>
            <QuietLink href="/invoices/new" icon={<Plus size={14} />}>
              Issue an invoice
            </QuietLink>
            <PrimaryLink href="/payments/new" icon={<Naira size={14} />}>
              Record a payment
            </PrimaryLink>
          </>
        }
      />

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_290px]">
        {/* ——————————————————— MAIN COLUMN ——————————————————— */}
        <div className="min-w-0">
          {/* ─── THE POSITION ─── */}
          <section aria-labelledby="position-label">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <h2
                id="position-label"
                className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted"
              >
                Collected to date
              </h2>
              <span className="text-xs text-ink-muted">
                {kpiScope.label}
                {kpiScope.isDefault ? ' · default' : ''}
              </span>
            </div>

            {/* The one dominant figure on this surface. */}
            <p
              className="mt-3 font-normal tabular-nums text-forest-deepest"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-display-xl)',
                lineHeight: 1.02,
                letterSpacing: '-0.02em',
              }}
            >
              {formatKobo(s.kpis.collectedKobo)}
            </p>

            {/* Rate against what was billed. A meter, not a chart: there is one
                quantity to compare, so a bar beats an axis. */}
            <div className="mt-5">
              <div className="flex items-baseline justify-between gap-4 text-xs">
                <span className="text-ink-muted">
                  <span className="font-medium text-forest-deep">{ratePct}%</span> of{' '}
                  <span className="tabular-nums">{formatKobo(s.kpis.billedKobo)}</span> billed
                </span>
                <span className="tabular-nums text-ink-muted">
                  {formatKobo(s.kpis.outstandingKobo)} outstanding
                </span>
              </div>
              <div
                className="mt-2.5 h-[3px] w-full overflow-hidden"
                style={{ backgroundColor: 'rgba(11, 31, 22, 0.09)' }}
                role="img"
                aria-label={`${ratePct}% of billed fees have been collected`}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, collectionRate))}%`,
                    backgroundColor: 'var(--color-forest-primary)',
                  }}
                />
              </div>
            </div>

            {/* Secondary measures — a ruled ledger strip, not four more cards.
                Hairlines and alignment carry the structure; the eye can compare
                the figures because the digits line up. */}
            <dl className="mt-6 grid grid-cols-2 border-t border-ink-faint sm:grid-cols-4">
              {measures.map((m, i) => (
                <div
                  key={m.key}
                  className={
                    'flex flex-col gap-1 py-4 pr-4 ' +
                    (i > 0 ? 'sm:border-l sm:border-ink-faint sm:pl-5 ' : '') +
                    (i === 1 ? 'border-l border-ink-faint pl-5 sm:pl-5 ' : '') +
                    (i > 1 ? 'border-t border-ink-faint sm:border-t-0' : '')
                  }
                >
                  <dt className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    {m.label}
                  </dt>
                  <dd
                    className={
                      'text-figure tabular-nums leading-tight ' +
                      (m.tone === 'danger'
                        ? 'text-danger-fg'
                        : m.tone === 'attention'
                          ? 'text-forest-deep'
                          : 'text-ink-primary')
                    }
                  >
                    {m.value}
                  </dd>
                  <span className="text-[11px] leading-snug text-ink-subtle">{m.hint}</span>
                </div>
              ))}
            </dl>

            {/* H-2: the partition the headline was computed from. Carried-forward
                debt is shown on its own line so it can never be invisible again. */}
            <p className="mt-4 text-xs leading-relaxed text-ink-muted" data-scope-classification>
              <span className="font-medium text-ink-secondary">Classified as</span>{' '}
              {s.buckets.map((b, i) => (
                <span key={b.key}>
                  {i > 0 ? ' · ' : ''}
                  <span className="font-medium text-ink-secondary">{b.label}</span>
                  {': '}
                  <span className="tabular-nums">{formatKobo(b.outstandingKobo)}</span>
                </span>
              ))}
              {carriedForward && carriedForward.outstandingKobo > 0 ? (
                <>
                  {' — '}
                  <Link href="/invoices" className="font-medium text-forest-deep underline">
                    {formatKobo(carriedForward.outstandingKobo)} carried forward from an earlier
                    term
                    {otherTerms && otherTerms.outstandingKobo > 0
                      ? ` (+ ${formatKobo(otherTerms.outstandingKobo)} in other terms)`
                      : ''}
                  </Link>
                </>
              ) : null}
            </p>
          </section>

          {/* ─── NEEDS ATTENTION ─── */}
          <section className="mt-10" aria-labelledby="attention-label">
            <SectionHead
              title={<span id="attention-label">Needs attention</span>}
              hint="Items that get worse if you leave them."
              count={
                s.attention.length > 0 ? (
                  <span
                    className="font-medium"
                    style={{
                      color: hasDanger ? 'var(--color-danger-fg)' : 'var(--color-gold-rich)',
                    }}
                  >
                    {s.attention.length} item{s.attention.length === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-success-fg">All clear</span>
                )
              }
            />
            <div className="border-t border-ink-faint">
              {s.attention.length === 0 ? (
                <div className="py-8">
                  <EmptyState
                    icon={<CheckCircle size={20} />}
                    title="Nothing requires action"
                    description="All issued invoices are within their terms and no payments are pending reconciliation."
                  />
                </div>
              ) : (
                <ul>
                  {s.attention.map((a) => (
                    <li key={a.id} className="border-b border-ink-faint">
                      <AttentionRow tone={a.severity} title={a.title} meta={a.meta} href={a.href} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* ─── RECENT ACTIVITY ─── */}
          <section className="mt-10" aria-labelledby="activity-label">
            <SectionHead
              title={<span id="activity-label">Recent activity</span>}
              hint="Latest payments and invoices."
              count="Last 24 hours"
            />
            <div className="border-t border-ink-faint">
              {s.activity.length === 0 ? (
                <div className="py-8">
                  <EmptyState
                    icon={<Clock size={20} />}
                    title="No recent activity"
                    description="Once invoices are issued and payments begin to arrive, activity will appear here."
                  />
                </div>
              ) : (
                <ul>
                  {s.activity.map((ev) => {
                    const isPayment = ev.kind === 'payment_confirmed';
                    return (
                      <li
                        key={ev.id}
                        className="flex items-baseline gap-4 border-b border-ink-faint py-3"
                      >
                        <span
                          aria-hidden
                          className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: isPayment
                              ? 'var(--color-forest-primary)'
                              : 'var(--color-ink-subtle)',
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] text-ink-primary">{ev.title}</div>
                          <div className="truncate text-xs text-ink-muted">{ev.meta}</div>
                        </div>
                        <span className="shrink-0 text-[11px] tabular-nums text-ink-subtle">
                          {relativeTime(ev.at)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* ——————————————————— ASIDE ——————————————————— */}
        <aside className="min-w-0 lg:pt-1">
          <section aria-labelledby="next-label">
            <SectionHead title={<span id="next-label">Next steps</span>} />
            <div className="border-t border-ink-faint">
              <ActionRow
                icon={<Naira size={15} />}
                title="Record a payment"
                hint="Mark a bank transfer or cash payment against invoices"
                href="/payments/new"
              />
              <ActionRow
                icon={<FileText size={15} />}
                title="Issue an invoice"
                hint="Create a new term fee invoice for a student"
                href="/invoices/new"
              />
              <ActionRow
                icon={<Inbox size={15} />}
                title="Reconcile pending"
                hint={
                  unrec === 0
                    ? 'Nothing waiting to be matched'
                    : `Match ${unrec} unallocated payment${unrec === 1 ? '' : 's'}`
                }
                href="/payments?status=PENDING"
                disabled={unrec === 0}
              />
              <ActionRow
                icon={<Users size={15} />}
                title="Invite a member"
                hint="Add a finance officer or administrator"
                href="/members"
              />
            </div>
          </section>

          <section className="mt-8" aria-labelledby="scope-label">
            <SectionHead title={<span id="scope-label">Scope of these figures</span>} />
            <dl className="border-t border-ink-faint pt-3 text-xs">
              <div className="py-1.5">
                <dt className="text-ink-muted">Headline</dt>
                <dd className="mt-0.5 font-medium text-ink-secondary">{kpiScope.label}</dd>
              </div>
              {kpiScope.termName ? (
                <div className="py-1.5">
                  <dt className="text-ink-muted">Cut-over</dt>
                  <dd className="mt-0.5 tabular-nums text-ink-secondary">
                    {kpiScope.termName} began {kpiScope.cutoverOn}
                  </dd>
                </div>
              ) : null}
              <div className="py-1.5">
                <dt className="text-ink-muted">Population</dt>
                <dd className="mt-0.5 text-ink-secondary">{s.scope.activeStudents.label}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ─────────────────────────── presentational ─────────────────────────── */

function PrimaryLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-sm px-3.5 py-2 text-[13px] font-medium text-ivory transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-reference"
      style={{ backgroundColor: 'var(--color-forest-deep)' }}
    >
      {icon}
      {children}
    </Link>
  );
}

function QuietLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-sm border px-3.5 py-2 text-[13px] font-medium text-ink-secondary transition-colors hover:border-ink-subtle hover:text-forest-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-reference"
      style={{ borderColor: 'var(--color-border)' }}
    >
      {icon}
      {children}
    </Link>
  );
}

const SEVERITY: Record<string, { dot: string; label: string; icon: React.ReactNode }> = {
  danger: { dot: 'var(--color-danger-fg)', label: 'Overdue', icon: <AlertTriangle size={14} /> },
  warning: { dot: 'var(--color-gold-rich)', label: 'Pending', icon: <Clock size={14} /> },
  info: { dot: 'var(--color-forest-primary)', label: 'Draft', icon: <FileText size={14} /> },
  neutral: { dot: 'var(--color-ink-subtle)', label: 'Note', icon: <CheckCircle size={14} /> },
};

function AttentionRow({
  title,
  meta,
  tone,
  href,
}: {
  title: string;
  meta: string;
  tone: 'danger' | 'warning' | 'info' | 'neutral';
  href?: string;
}) {
  const t = SEVERITY[tone] ?? SEVERITY.neutral!;
  const inner = (
    <div className="group flex items-start gap-3 py-3.5 transition-colors">
      {/* Severity is carried by a rule on the left edge AND a word — never by
          colour alone. */}
      <span
        aria-hidden
        className="mt-1 h-4 w-[2px] shrink-0 rounded-full"
        style={{ backgroundColor: t.dot }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13.5px] font-medium text-ink-primary">{title}</span>
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: t.dot }}
          >
            {t.label}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-ink-muted">{meta}</div>
      </div>
      {href ? (
        <ArrowRight
          size={14}
          className="mt-1 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      ) : null}
    </div>
  );
  if (!href) return <div>{inner}</div>;
  return (
    <Link
      href={href}
      className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-rich"
    >
      {inner}
    </Link>
  );
}

function ActionRow({
  icon,
  title,
  hint,
  href,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  href: string;
  disabled?: boolean;
}) {
  const inner = (
    <div
      className={
        'group flex items-start gap-3 border-b border-ink-faint py-3 transition-colors ' +
        (disabled ? 'opacity-45' : '')
      }
    >
      <span
        aria-hidden
        className="mt-0.5 shrink-0"
        style={{ color: disabled ? 'var(--color-ink-subtle)' : 'var(--color-forest-primary)' }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink-primary">{title}</span>
        <span className="block text-xs leading-snug text-ink-muted">{hint}</span>
      </span>
      {!disabled ? (
        <ArrowRight size={13} className="mt-1 shrink-0 text-ink-subtle" aria-hidden />
      ) : null}
    </div>
  );
  if (disabled) return inner;
  return (
    <Link
      href={href}
      className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-rich"
    >
      {inner}
    </Link>
  );
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
