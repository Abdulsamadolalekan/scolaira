/**
 * SCOLAIRA — public website (route `/`).
 *
 * COMPOSITION
 *   A masthead with the four questions a school actually asks; an opening statement;
 *   the four structural answers; the product shown as it actually renders; the problem
 *   stated plainly; the system's capabilities as a ruled register; the cycle of a term;
 *   the grounds for trust; and the pilot programme with its enquiry form. Structure is
 *   carried by rules and typography rather than by cards and decoration.
 *
 * AUTH BEHAVIOUR
 *   Signed-in visitors are redirected to /dashboard exactly as before. Middleware already
 *   treats `/` as public, so this page is reachable with or without a session cookie and
 *   needs no middleware change.
 *
 * WHAT IS CLAIMED
 *   Every capability named here maps to a surface that exists in the product inventory,
 *   and every trust statement describes something structural about how the system is
 *   built. The product plates are real captures of this build against the demo dataset —
 *   not mockups, not composites. Nothing is aspirational: no pricing is implied, no
 *   integration is promised, and no deployment claim is made.
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { ScolairaLockup } from '@/components/brand';
import { PilotRequestForm } from '@/components/marketing/pilot-request-form';
import { Reveal } from '@/components/marketing/reveal';
import { ArrowRight, Check } from '@/components/ui/icons';

export const metadata: Metadata = {
  title: 'SCOLAIRA — Every term, fully funded',
  description:
    'The financial operating system for Nigerian private schools: term billing, payments and allocation, reconciliation, arrears and receipts — on one ledger.',
};

export const dynamic = 'force-dynamic';

const RULE = { borderColor: 'rgba(11, 31, 22, 0.10)' } as const;

/** The four structural answers, stated before the visitor has to ask. */
const PILLARS: Array<{ title: string; body: string }> = [
  {
    title: 'One ledger, not five',
    body: 'Billing, payments, allocation, arrears and receipts are not separate registers that must be reconciled by hand. They are one set of records that cannot disagree with each other.',
  },
  {
    title: 'Your money, your account',
    body: 'With Paystack, fees settle directly into the school’s own bank account. SCOLAIRA records and reconciles — it does not hold school funds.',
  },
  {
    title: 'Privacy by design',
    body: 'Student and guardian data is minimised and scoped. The platform is built toward Nigeria’s data-protection requirements from day one.',
  },
  {
    title: 'Provable, not estimated',
    body: 'Billed, collected, outstanding and overdue are computed from the same ledger. There is no second copy of a balance to fall out of step.',
  },
];

/** The register of what the system actually does. Names map to real surfaces. */
const REGISTER: Array<{ module: string; does: string; surface: string }> = [
  {
    module: 'Term billing',
    does: 'Set the session, the terms, the classes and the fee structure, then bill a cohort once — with every invoice issued against a named student and term.',
    surface: 'Academic roster · Fee structure · Term billing',
  },
  {
    module: 'Invoices',
    does: 'Every fee obligation on record, from draft to paid, with line items, due dates and the payments applied against them.',
    surface: 'Invoice register · Invoice detail',
  },
  {
    module: 'Payments',
    does: 'Cash, transfers, POS and online payments recorded once, then allocated against the invoices they settle — with the unapplied remainder kept visible.',
    surface: 'Payments register · Record payment',
  },
  {
    module: 'Reconciliation',
    does: 'Money that cannot yet be matched sits in a human-reviewed queue with its evidence, instead of being silently absorbed into a balance.',
    surface: 'Reconciliation · Operational queue',
  },
  {
    module: 'Arrears & aging',
    does: 'Who owes what, how old the oldest unpaid invoice is, and when the family was last reminded — read from the ledger, never from a copy of it.',
    surface: 'Debtors & aging · Statement of account',
  },
  {
    module: 'Collections',
    does: 'Follow-up as a controlled case file: state, priority, next action and history, without creating a second set of balances.',
    surface: 'Collections workbench',
  },
  {
    module: 'Receipts & statements',
    does: 'Numbered, immutable documents a bursar can print and a parent can keep — for money received and for what remains outstanding.',
    surface: 'Receipt of record · Statement of account',
  },
  {
    module: 'Oversight',
    does: 'One proprietor-facing position for the term, and a separate read-only platform view for schools that need support.',
    surface: 'Dashboard · Platform support',
  },
];

/** The cycle of a term, stated as the sequence the product enforces. */
const CYCLE: Array<{ step: string; title: string; body: string }> = [
  {
    step: 'i',
    title: 'Set the term',
    body: 'Session, term, classes, enrolment and the fees that apply. Nothing is billed until the structure is right.',
  },
  {
    step: 'ii',
    title: 'Bill the cohort',
    body: 'One controlled run issues every invoice for the term, each traceable to a student and a fee line.',
  },
  {
    step: 'iii',
    title: 'Record money as it arrives',
    body: 'Cash, transfer, POS or online — captured once, with the payer and the reference that identifies it at the bank.',
  },
  {
    step: 'iv',
    title: 'Match money to invoices',
    body: 'Payments are allocated against what they settle. Anything left over stays visible as an unapplied remainder rather than disappearing.',
  },
  {
    step: 'v',
    title: 'Chase what remains',
    body: 'Aging, reminders and collections cases point at the specific invoice that is unpaid — and every reminder is logged.',
  },
  {
    step: 'vi',
    title: 'Close the term funded',
    body: 'The position is provable: billed, collected, outstanding and overdue, all derived from the same ledger.',
  },
];

const TRUST: Array<{ claim: string; detail: string }> = [
  {
    claim: 'Every school is isolated at the database layer',
    detail:
      'SCOLAIRA runs as a least-privilege database principal under row-level security. Isolation is enforced by the database, not by application code remembering to filter.',
  },
  {
    claim: 'Money is stored as integer kobo',
    detail:
      'No floating point is used for money anywhere. Figures on screen are formatted from integers, so a total cannot drift from the sum of its parts.',
  },
  {
    claim: 'Balances are derived, not duplicated',
    detail:
      'Outstanding, overdue and collected are computed from invoices, allocations and confirmations. There is no second copy of a balance to fall out of step.',
  },
  {
    claim: 'Allocations and reversals are recorded, not overwritten',
    detail:
      'Money that was applied stays in the record, with the reversal that undid it. A receipt is issued against money that was genuinely received.',
  },
  {
    claim: 'Support access is a separate, narrow door',
    detail:
      'The platform view is read-only and deliberately limited; it is not an administration console over school data.',
  },
];

const NAV = [
  { href: '#problem', label: 'The problem' },
  { href: '#product', label: 'The product' },
  { href: '#how', label: 'How it works' },
  { href: '#security', label: 'Security' },
];

const PILOT_INCLUDES = [
  'Setup help for your session, terms, classes, fees and student records',
  'Your team trained on billing, payments and reconciliation',
  'Direct line to the team building the product',
];

export default async function PublicHome() {
  // Signed-in users keep the old behaviour exactly: straight to the workspace.
  let session = null;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  if (session) redirect('/dashboard');

  return (
    <div style={{ backgroundColor: 'var(--color-ivory)' }}>
      {/* ─────────────── MASTHEAD ─────────────── */}
      <header
        className="sticky top-0 z-30 border-b backdrop-blur-md"
        style={{
          borderColor: 'rgba(11, 31, 22, 0.08)',
          backgroundColor: 'rgba(253, 251, 246, 0.86)',
        }}
      >
        <div className="mx-auto flex max-w-[1120px] items-center justify-between gap-6 px-6 py-4">
          <Link href="/" aria-label="SCOLAIRA — home" className="shrink-0">
            <ScolairaLockup
              size={23}
              descriptor="Financial operating system"
              descriptorClassName="hidden sm:block"
            />
          </Link>
          <nav aria-label="Site" className="flex items-center gap-6">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="hidden text-[13px] font-medium text-ink-secondary transition-colors hover:text-forest-deep lg:inline"
              >
                {n.label}
              </a>
            ))}
            <Link
              href="/login"
              className="text-[13px] font-medium text-ink-secondary transition-colors hover:text-forest-deep"
            >
              Sign in
            </Link>
            <a
              href="#pilot"
              className="hidden rounded-sm px-4 py-2 text-[13px] font-medium text-ivory transition-[filter] hover:brightness-110 sm:inline-block"
              style={{ backgroundColor: 'var(--color-forest-deep)' }}
            >
              Request pilot access
            </a>
          </nav>
        </div>
      </header>

      {/* `main-content` is the id the skip link in app/layout.tsx targets, and the same
          id nav-shell.tsx uses for the workspace. Matching it here keeps the first tab
          stop working on every surface rather than only inside the app. */}
      <main id="main-content">
        {/* ─────────────── OPENING STATEMENT ─────────────── */}
        <section
          className="relative overflow-hidden border-b"
          style={{ ...RULE, backgroundColor: 'var(--color-forest-wash)' }}
        >
          <div className="mx-auto max-w-[1120px] px-6 pb-24 pt-16 sm:pb-28 sm:pt-24">
            {/* A single mark of gold, at the head of the page. A short solid rule
                rather than a hairline that fades at both ends: an institution
                draws a line, it does not fade one out. This is the only gold on
                the surface — everything below it is paper, forest and ink. */}
            <div
              aria-hidden="true"
              className="h-[2px] w-16"
              style={{ backgroundColor: 'var(--color-gold-rich)' }}
            />
            <p className="mt-8 text-2xs font-semibold uppercase tracking-[0.2em] text-ink-muted">
              For Nigerian private schools
            </p>
            <h1
              className="mt-6 max-w-[19ch] text-balance text-forest-deepest"
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 'clamp(40px, 7vw, 76px)',
                lineHeight: 1.02,
                letterSpacing: '-0.025em',
              }}
            >
              Every term, fully funded.
            </h1>
            <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
              <p className="max-w-[62ch] text-pretty text-[17px] leading-relaxed text-ink-secondary">
                SCOLAIRA is the financial operating system for a private school. It carries the
                whole money cycle — the term&rsquo;s fees, every payment that arrives, the invoices
                those payments settle, what is still owed and how long it has been owed — on{' '}
                <em>one</em> ledger that a bursar, a proprietor and a parent can all be shown.
              </p>
              <div className="border-t pt-6" style={RULE}>
                <p className="text-pretty text-xs leading-relaxed text-ink-muted">
                  School fees are the school&rsquo;s income and a family&rsquo;s obligation at the
                  same time. When the two are kept in different places — a register here, a bank
                  statement there, a notebook for the rest — the arrears become invisible, and
                  invisible arrears are not collected. SCOLAIRA exists so that the position is never
                  in doubt.
                </p>
              </div>
            </div>

            <div className="mt-12 flex flex-wrap items-center gap-3">
              <a
                href="#pilot"
                className="group inline-flex items-center gap-2 rounded-sm px-5 py-3 text-sm font-medium text-ivory transition-[filter] hover:brightness-110"
                style={{ backgroundColor: 'var(--color-forest-deep)' }}
              >
                Request pilot access
                <ArrowRight
                  size={15}
                  className="transition-transform duration-300 group-hover:translate-x-0.5"
                />
              </a>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-sm border bg-white px-5 py-3 text-sm font-medium text-ink-secondary transition-colors hover:border-forest-deep hover:text-forest-deep"
                style={{ borderColor: 'var(--color-border)' }}
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>

        {/* ─────────────── THE FOUR ANSWERS ───────────────
    A ruled register, not a card row.
    The page's own principle is that structure is carried by rules and
    typography; four rounded cards with a hover shadow would be the
    generic feature grid this design deliberately is not. One plate,
    divided by hairlines, numbered like a prospectus — which also makes
    the copy's point structurally: these four answers are one document,
    not four separate claims. ─────────────── */}
        <section className="mx-auto max-w-[1120px] px-6 pt-16 sm:pt-20">
          <dl className="grid gap-x-14 md:grid-cols-2">
            {PILLARS.map((p, i) => (
              <Reveal key={p.title} delay={i * 60} className="border-t border-ink-faint">
                <div className="flex h-full gap-4 py-6 md:py-7">
                  <span
                    aria-hidden="true"
                    className="shrink-0 pt-1 text-2xs font-semibold tabular-nums"
                    style={{ color: 'var(--color-gold-rich)' }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <dt
                      className="text-pretty text-[17px] leading-snug tracking-[-0.01em]"
                      style={{
                        color: 'var(--color-forest-deepest)',
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      {p.title}
                    </dt>
                    <dd
                      className="mt-2 max-w-[44ch] text-pretty text-[13px] leading-relaxed"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {p.body}
                    </dd>
                  </div>
                </div>
              </Reveal>
            ))}
          </dl>
        </section>

        {/* ─────────────── THE PRODUCT, AS IT ACTUALLY RENDERS ─────────────── */}
        <section id="product" className="border-t" style={RULE}>
          <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-24">
            <Reveal>
              <p className="text-2xs font-semibold uppercase tracking-[0.2em] text-ink-muted">
                The product
              </p>
              <h2
                className="mt-5 max-w-[22ch] text-balance text-forest-deepest"
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 'clamp(30px, 4vw, 46px)',
                  lineHeight: 1.08,
                  letterSpacing: '-0.02em',
                }}
              >
                This is the software, not an artist&rsquo;s impression of it.
              </h2>
              <p className="mt-5 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-secondary">
                Every figure below is computed live from the ledger of a demonstration school. No
                number on this page was drawn by hand.
              </p>
            </Reveal>

            {/* Primary plate — the Command Center */}
            <Reveal delay={80} className="mt-12">
              <figure className="m-0">
                <div
                  className="overflow-hidden rounded-sm border"
                  style={{ borderColor: 'var(--color-border-strong)' }}
                >
                  <Image
                    src="/product/command-center.webp"
                    alt="The SCOLAIRA Command Center: collected to date, outstanding, overdue, unreconciled payments and students, followed by items needing attention and recent activity."
                    width={1600}
                    height={1044}
                    sizes="(max-width: 1120px) 100vw, 1120px"
                    priority
                    className="block h-auto w-full"
                  />
                </div>
                <figcaption className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted">
                  <span className="font-medium text-ink-secondary">Dashboard</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    One term&rsquo;s position: what was billed, what was collected, and what needs
                    attention before it ages.
                  </span>
                </figcaption>
              </figure>
            </Reveal>

            {/* Secondary plate — the invoice register */}
            <Reveal delay={120} className="mt-14">
              <figure className="m-0">
                <div
                  className="overflow-hidden rounded-sm border"
                  style={{ borderColor: 'var(--color-border-strong)' }}
                >
                  <Image
                    src="/product/invoice-register.webp"
                    alt="The invoice register: totals computed over every invoice, then one row per invoice with student, term, amount billed, amount paid, remaining balance and due date."
                    width={1600}
                    height={721}
                    sizes="(max-width: 1120px) 100vw, 1120px"
                    loading="lazy"
                    className="block h-auto w-full"
                  />
                </div>
                <figcaption className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted">
                  <span className="font-medium text-ink-secondary">Invoice register</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Totals are computed over the whole register, not over the rows on screen.
                  </span>
                </figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        {/* ─────────────── THE PROBLEM ─────────────── */}
        <section
          id="problem"
          className="border-t"
          style={{ ...RULE, backgroundColor: 'var(--color-white)' }}
        >
          <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-20">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-20">
              <Reveal>
                <h2
                  className="text-balance text-forest-deepest"
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 'clamp(26px, 3.2vw, 36px)',
                    lineHeight: 1.14,
                    letterSpacing: '-0.02em',
                  }}
                >
                  The term ends.
                  <br />
                  Did it fund you?
                </h2>
              </Reveal>
              <div className="space-y-6">
                <Reveal>
                  <p className="max-w-[68ch] text-pretty text-[15px] leading-relaxed text-ink-secondary">
                    Most schools can answer that question only approximately — and the approximate
                    answer is always more optimistic than the truth. The failure is never one
                    dramatic loss; it is a slow leak in four places at once.
                  </p>
                </Reveal>
                <ul className="space-y-4">
                  {[
                    [
                      'Fees billed from memory',
                      'A fee change agreed in a meeting never reaches the invoice, so the school quietly under-bills an entire class.',
                    ],
                    [
                      'Payments that cannot be traced',
                      'A transfer arrives with a reference nobody recognises, so it sits unapplied while the family is chased for money already paid.',
                    ],
                    [
                      'Arrears that age out of view',
                      'An unpaid invoice from last term stops being anybody’s task the moment the new term begins, and the debt becomes history.',
                    ],
                    [
                      'A position nobody can prove',
                      'When the proprietor asks what was collected this term, the honest answer is a number reconstructed after the fact.',
                    ],
                  ].map(([title, body], i) => (
                    <Reveal
                      as="li"
                      key={title}
                      delay={i * 60}
                      className="border-t border-ink-faint pt-4"
                    >
                      <h3 className="text-[15px] font-medium text-ink-primary">{title}</h3>
                      <p className="mt-1 max-w-[68ch] text-pretty text-[14px] leading-relaxed text-ink-muted">
                        {body}
                      </p>
                    </Reveal>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ─────────────── THE REGISTER ─────────────── */}
        <section
          id="system"
          className="border-t"
          style={{ ...RULE, backgroundColor: 'var(--color-forest-wash)' }}
        >
          <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-20">
            <Reveal>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                <h2
                  className="text-balance text-forest-deepest"
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 'clamp(26px, 3.2vw, 36px)',
                    lineHeight: 1.14,
                    letterSpacing: '-0.02em',
                  }}
                >
                  One ledger, in eight parts
                </h2>
                <p className="text-xs text-ink-muted">
                  Each part is a working surface in the product.
                </p>
              </div>
            </Reveal>

            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <thead>
                  <tr className="border-y" style={{ borderColor: 'var(--color-ink-subtle)' }}>
                    <th className="w-[24%] py-3 pr-6 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                      Part
                    </th>
                    <th className="py-3 pr-6 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                      What it holds
                    </th>
                    <th className="hidden w-[26%] py-3 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted lg:table-cell">
                      Where you find it
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {REGISTER.map((r) => (
                    <tr
                      key={r.module}
                      className="border-b border-ink-faint align-top transition-colors hover:bg-white/70"
                    >
                      <th
                        scope="row"
                        className="py-4 pr-6 text-[14px] font-medium text-forest-deep"
                      >
                        {r.module}
                      </th>
                      <td className="py-4 pr-6 text-[14px] leading-relaxed text-ink-secondary">
                        {r.does}
                      </td>
                      <td className="hidden py-4 text-xs leading-relaxed text-ink-muted lg:table-cell">
                        {r.surface}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ─────────────── HOW IT WORKS ─────────────── */}
        <section id="how" className="border-t" style={RULE}>
          <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-20">
            <Reveal>
              <h2
                className="text-balance text-forest-deepest"
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 'clamp(26px, 3.2vw, 36px)',
                  lineHeight: 1.14,
                  letterSpacing: '-0.02em',
                }}
              >
                How a term runs
              </h2>
              <p className="mt-2 max-w-[62ch] text-pretty text-sm leading-relaxed text-ink-muted">
                The same six steps every term. The software&rsquo;s job is to make each one
                unavoidable.
              </p>
            </Reveal>
            <ol className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {CYCLE.map((c, i) => (
                <Reveal
                  as="li"
                  key={c.step}
                  delay={i * 50}
                  className="border-t border-ink-faint pt-4"
                >
                  <div className="flex items-baseline gap-3">
                    <span
                      className="text-[13px] font-medium text-gold-rich"
                      style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
                    >
                      {c.step}
                    </span>
                    <h3 className="text-[15px] font-medium text-ink-primary">{c.title}</h3>
                  </div>
                  <p className="mt-2 text-pretty text-[13.5px] leading-relaxed text-ink-muted">
                    {c.body}
                  </p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* ─────────────── SECURITY ─────────────── */}
        <section
          id="security"
          className="border-t"
          style={{ ...RULE, backgroundColor: 'var(--color-forest-deepest)' }}
        >
          <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-24">
            <Reveal>
              <h2
                className="text-balance text-ivory"
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 'clamp(26px, 3.2vw, 36px)',
                  lineHeight: 1.14,
                  letterSpacing: '-0.02em',
                }}
              >
                Why a school can trust it with the money
              </h2>
              <p
                className="mt-2 max-w-[62ch] text-pretty text-sm leading-relaxed"
                style={{ color: 'rgba(253,251,246,0.62)' }}
              >
                These are structural properties of how the system is built — not policies, and not
                promises about what happens if something goes wrong.
              </p>
            </Reveal>
            <dl className="mt-10 grid gap-x-14 gap-y-7 sm:grid-cols-2">
              {TRUST.map((t, i) => (
                <Reveal key={t.claim} delay={i * 50}>
                  <div className="border-t pt-4" style={{ borderColor: 'rgba(253,251,246,0.16)' }}>
                    <dt className="text-[15px] font-medium text-ivory">{t.claim}</dt>
                    <dd
                      className="mt-1.5 text-pretty text-[13.5px] leading-relaxed"
                      style={{ color: 'rgba(253,251,246,0.68)' }}
                    >
                      {t.detail}
                    </dd>
                  </div>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        {/* ─────────────── PILOT PROGRAMME ─────────────── */}
        <section id="pilot" className="border-t" style={RULE}>
          <div className="mx-auto grid max-w-[1120px] gap-12 px-6 py-16 sm:py-24 lg:grid-cols-2 lg:gap-20">
            <Reveal>
              <p className="text-2xs font-semibold uppercase tracking-[0.2em] text-forest-primary">
                Pilot programme
              </p>
              <h2
                className="mt-6 max-w-[16ch] text-balance text-forest-deepest"
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 'clamp(30px, 4vw, 46px)',
                  lineHeight: 1.06,
                  letterSpacing: '-0.02em',
                }}
              >
                Bring SCOLAIRA into your school.
              </h2>
              <p className="mt-6 max-w-[52ch] text-pretty text-[15px] leading-relaxed text-ink-secondary">
                We are onboarding a small number of schools as pilot partners. The pilot measures
                one thing honestly:{' '}
                <strong className="font-semibold text-ink-primary">
                  does SCOLAIRA measurably improve fee collection visibility and operations?
                </strong>
              </p>
              <ul className="mt-8 space-y-3">
                {PILOT_INCLUDES.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-[14px] text-ink-secondary">
                    <span aria-hidden="true" className="mt-[3px] shrink-0 text-forest-primary">
                      <Check size={14} />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-8 max-w-[52ch] text-pretty text-[13px] leading-relaxed text-ink-muted">
                No invented case studies, no invented numbers. The pilot exists to produce genuine
                evidence.
              </p>
            </Reveal>

            <Reveal delay={100}>
              <PilotRequestForm />
            </Reveal>
          </div>
        </section>
      </main>

      {/* ─────────────── FOOTER ─────────────── */}
      <footer className="border-t" style={{ ...RULE, backgroundColor: 'var(--color-white)' }}>
        <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <ScolairaLockup size={20} />
            <p className="mt-3 max-w-[42ch] text-xs leading-relaxed text-ink-muted">
              The financial operating system for Nigerian private schools. Fees settle into the
              school&rsquo;s own account; SCOLAIRA records and reconciles them.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="text-ink-muted underline-offset-4 transition-colors hover:text-forest-deep hover:underline"
              >
                {n.label}
              </a>
            ))}
            <Link
              href="/login"
              className="text-ink-muted underline-offset-4 transition-colors hover:text-forest-deep hover:underline"
            >
              Sign in
            </Link>
            <a
              href="#pilot"
              className="font-medium text-forest-deep underline-offset-4 hover:underline"
            >
              Request pilot access
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
