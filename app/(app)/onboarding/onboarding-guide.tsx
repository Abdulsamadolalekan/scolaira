'use client';
/**
 * The setup guide.
 *
 * Steps that already exist in the product are performed by calling the SAME
 * endpoints the Academic roster calls — `POST /api/academic-sessions`,
 * `POST /api/terms`, `POST /api/terms/[id]/activate`, `POST /api/classes`. No
 * second implementation, no second set of rules, no second permission check.
 * That is deliberate: a school that sets up here and a school that sets up in
 * the roster must end up with identical data and identical controls.
 *
 * Students are the exception, and only because nothing existed to reuse: there
 * was no way to get a school's roll into SCOLAIRA except typing it. That gap is
 * what the importer closes.
 *
 * The guide only ever shows ONE primary action per step, so a bursar opening this
 * on a phone sees what to do next rather than a form for every decision at once.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { csrfHeaders } from '@/lib/ui/csrf';
import StepRail, { type GuideStep } from './step-rail';
import ImportPanel from './import-panel';

interface Term {
  id: string;
  name: string;
  label: string;
  status: string;
  startsOn: string;
}

interface Status {
  organization: { id: string; name: string } | null;
  counts: { sessions: number; terms: number; classes: number; students: number };
  sessions: Array<{ id: string; name: string; startsOn: string; isCurrent: boolean }>;
  currentTerm: { id: string; name: string; label: string; status: string; startsOn: string } | null;
  steps: GuideStep[];
  nextStep: string;
  readyToBill: boolean;
  /**
   * Null unless the viewer may read invoices — the API omits it rather than
   * zeroing it, so a role with no financial visibility is not shown a financial
   * figure dressed as an academic one.
   */
  openingBalances?: {
    count: number;
    pendingReviewCount: number;
    pendingPostCount: number;
    /** Approved rows the ledger has not taken yet, postable or not. */
    approvedNotPostedCount: number;
    outstandingKobo: number;
    hasPriorTerm: boolean;
  } | null;
}

const NIGERIAN_TERMS = [
  { name: 'First Term', label: '1st', month: '09', day: '08' },
  { name: 'Second Term', label: '2nd', month: '01', day: '06' },
  { name: 'Third Term', label: '3rd', month: '04', day: '20' },
] as const;

/** Common Nigerian private-school class ladder, offered as one-click chips. */
const CLASS_PRESETS = [
  'Nursery 1',
  'Nursery 2',
  'Primary 1',
  'Primary 2',
  'Primary 3',
  'Primary 4',
  'Primary 5',
  'Primary 6',
  'JSS1',
  'JSS2',
  'JSS3',
  'SS1',
  'SS2',
  'SS3',
] as const;

function sessionYearBounds(): { startYear: number; endYear: number; name: string } {
  const now = new Date();
  // A Nigerian school year starts in September, so before September we are still
  // inside the session that began last calendar year.
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return { startYear, endYear: startYear + 1, name: `${startYear}/${startYear + 1}` };
}

export default function OnboardingGuide({
  status,
  terms,
  canManageAcademic,
  canManageStudents,
}: {
  status: Status;
  terms: Term[];
  canManageAcademic: boolean;
  canManageStudents: boolean;
}) {
  const router = useRouter();
  const [active, setActive] = useState<string>(
    status.nextStep === 'ready' ? 'students' : status.nextStep,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * What this screen has already created, held client-side.
   *
   * Measured defect, found by walking the journey: `router.refresh()` is
   * asynchronous, so a bursar who creates a session and immediately moves to the
   * term step was still looking at the page's OLD data — and was told "Create an
   * academic session first" seconds after creating one. The server's own response
   * names what it created, so the guide keeps those facts and stops depending on
   * a refresh that may not have landed yet. Nothing is invented: each id below
   * came from a 201 response inside a committed transaction.
   */
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [createdTerm, setCreatedTerm] = useState<{
    id: string;
    name: string;
    status: string;
  } | null>(null);
  const [createdClassCount, setCreatedClassCount] = useState(0);
  /**
   * A refresh in flight. Buttons stay disabled until the new data is on screen, so
   * no action is ever taken against data that has already been superseded.
   */
  const [refreshing, startRefresh] = useTransition();
  const updating = busy !== null || refreshing;

  const years = sessionYearBounds();
  const [sessionName, setSessionName] = useState(years.name);
  const [sessionStart, setSessionStart] = useState(`${years.startYear}-09-01`);
  const [sessionEnd, setSessionEnd] = useState(`${years.endYear}-07-31`);

  const [termName, setTermName] = useState<string>(NIGERIAN_TERMS[0]!.name);
  const [termLabel, setTermLabel] = useState<string>(NIGERIAN_TERMS[0]!.label);
  const [termStart, setTermStart] = useState(`${years.startYear}-09-08`);
  const [termEnd, setTermEnd] = useState(`${years.startYear}-12-15`);
  const [termDue, setTermDue] = useState(`${years.startYear}-12-01`);

  const [classNames, setClassNames] = useState<string[]>([]);
  const [customClass, setCustomClass] = useState('');

  /** One request helper for every step, so CSRF and idempotency are uniform. */
  async function send(
    path: string,
    body: unknown,
    who: string,
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(who);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...csrfHeaders(),
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (data as { error?: { message?: string } })?.error?.message ??
            'That step could not be saved. Nothing was changed.',
        );
        return { ok: false, data };
      }
      return { ok: true, data };
    } catch {
      setError('Network error. Nothing was saved — check your connection and try again.');
      return { ok: false, data: {} };
    } finally {
      setBusy(null);
    }
  }

  function refresh(message: string) {
    setNotice(message);
    startRefresh(() => router.refresh());
  }

  // ── Step actions ────────────────────────────────────────────────────────

  async function createSession() {
    const { ok, data } = await send(
      '/api/academic-sessions',
      { name: sessionName, startsOn: sessionStart, endsOn: sessionEnd },
      'session',
    );
    if (!ok) return;
    const created = (data as { session?: { id?: string } }).session;
    if (created?.id) setCreatedSessionId(created.id);
    refresh(`Session ${sessionName} created.`);
  }

  async function createTerm() {
    if (!sessionForTerm) {
      setError('Create an academic session first — a term belongs to a session.');
      return;
    }
    const { ok, data } = await send(
      '/api/terms',
      {
        sessionId: sessionForTerm,
        name: termName,
        label: termLabel,
        startsOn: termStart,
        endsOn: termEnd,
        dueDate: termDue,
      },
      'term',
    );
    if (!ok) return;
    const created = (data as { term?: { id: string; name: string; status: string } }).term;
    if (created?.id) setCreatedTerm({ id: created.id, name: created.name, status: created.status });
    refresh(`${termName} created. Activate it to start enrolling students.`);
  }

  async function createClasses() {
    if (classNames.length === 0) {
      setError('Choose at least one class.');
      return;
    }
    let created = 0;
    for (const name of classNames) {
      const { ok } = await send('/api/classes', { name, sortOrder: 0 }, `class-${name}`);
      if (!ok) {
        setError(
          `Created ${created} of ${classNames.length} classes before stopping. ` +
            `Already-created classes are kept — add the rest individually.`,
        );
        router.refresh();
        return;
      }
      created += 1;
    }
    setClassNames([]);
    setCreatedClassCount((previous) => previous + created);
    refresh(`${created} class${created === 1 ? '' : 'es'} created.`);
  }

  const classStep = status.steps.find((s) => s.key === 'classes');
  const termStep = status.steps.find((s) => s.key === 'term');
  // Newest first, so "the term you are setting up" is unambiguous.
  const termsNewestFirst = [...terms].sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  // The term the importer enrols into: the marked-current one, else the newest.
  const currentTerm = status.currentTerm ?? termsNewestFirst[0] ?? null;
  // The session a NEW term belongs to: the marked-current one, else the newest.
  const sessionForTerm =
    status.sessions.find((s) => s.isCurrent)?.id ??
    createdSessionId ??
    status.sessions[0]?.id ??
    '';
  /**
   * The term this school still needs to activate.
   *
   * Measured gap, caught by walking the journey as a new school would: the first
   * version only offered "Activate" when a term was already marked current, which
   * is never true for a brand-new school. A school that created its first term
   * had no way to make it current, the term step could never complete, and the
   * importer would refuse every enrolment — "First Term is planned. Activate it
   * before importing" with no button in sight. Activation is now offered for the
   * newest term whenever no ACTIVE current term exists.
   */
  const termToActivate = (() => {
    if (status.currentTerm && status.currentTerm.status !== 'ACTIVE') return status.currentTerm;
    // Already activated on this screen: nothing left to offer, even if the refresh
    // has not landed yet.
    if (status.currentTerm?.status === 'ACTIVE') return null;
    if (createdTerm) return createdTerm;
    const newest = termsNewestFirst[0];
    return newest && newest.status !== 'CLOSED' ? newest : null;
  })();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader title="Setup" />
        {/*
          The rail column is 300px wide, so the hint cannot sit on the header's
          baseline without being cut mid-word ("…your records, n…"). It gets its
          own line and wraps instead.
        */}
        <p className="-mt-1 pb-2 text-xs text-ink-muted">
          Progress is read from your records, not ticked off.
        </p>
        <StepRail
          steps={status.steps}
          activeKey={active}
          disabled={updating}
          onSelect={setActive}
        />
      </Card>

      <div>
        {error && (
          <div
            role="alert"
            className="mb-3 rounded-sm border px-3 py-2 text-[12px]"
            style={{
              borderColor: 'rgba(168,42,28,.28)',
              backgroundColor: 'rgba(168,42,28,.06)',
              color: 'var(--color-danger,#a82a1c)',
            }}
          >
            {error}
          </div>
        )}
        {notice && !error && (
          <div
            role="status"
            className="mb-3 rounded-sm border px-3 py-2 text-[12px]"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--color-bg-page)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {notice}
          </div>
        )}

        {/* ── School ────────────────────────────────────────────────────── */}
        {active === 'school' && (
          <Card>
            <CardHeader
              title="Your school"
              description="The name parents see on receipts and statements."
            />
            <div className="px-5 py-5">
              <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                <strong style={{ color: 'var(--color-text-primary)' }}>
                  {status.organization?.name ?? 'Your school'}
                </strong>{' '}
                is set up. Its name, address and contact details appear on every receipt, statement
                and reminder the school issues.
              </p>
              <div className="mt-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => router.push('/settings')}
                >
                  School details
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* ── Academic session ──────────────────────────────────────────── */}
        {active === 'session' && (
          <Card>
            <CardHeader
              title="Academic session"
              description="The school year you are billing in. Every term, invoice and report belongs to a session."
            />
            <div className="px-5 py-5">
              {status.counts.sessions > 0 ? (
                <>
                  <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                    {sessionStep().detail}. You can add another session if you are setting up a
                    previous year.
                  </p>
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setActive('term')}
                    >
                      Continue to terms
                    </Button>
                  </div>
                </>
              ) : null}
              {canManageAcademic ? (
                <div className="mt-4 grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label htmlFor="s-name">Session name</Label>
                    <Input
                      id="s-name"
                      value={sessionName}
                      placeholder="2026/2027"
                      onChange={(e) => setSessionName(e.target.value)}
                    />
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                      Nigerian sessions run September to July.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="s-start">Starts</Label>
                    <Input
                      id="s-start"
                      type="date"
                      value={sessionStart}
                      onChange={(e) => setSessionStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="s-end">Ends</Label>
                    <Input
                      id="s-end"
                      type="date"
                      value={sessionEnd}
                      onChange={(e) => setSessionEnd(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={updating}
                      onClick={createSession}
                    >
                      {busy === 'session' ? 'Saving…' : 'Create session'}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  Your role cannot create academic sessions. Ask the proprietor or an administrator.
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ── Term ──────────────────────────────────────────────────────── */}
        {active === 'term' && (
          <Card>
            <CardHeader
              title="Term"
              description="Billing runs by term. Students are enrolled into a term, and invoices belong to one."
            />
            <div className="px-5 py-5">
              {status.counts.terms > 0 && (
                <p className="mb-4 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                  {status.counts.terms} term{status.counts.terms === 1 ? '' : 's'} set up
                  {status.currentTerm
                    ? ` · current: ${status.currentTerm.name}`
                    : ' · none marked current'}
                  .
                </p>
              )}
              {canManageAcademic ? (
                <div className="grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="t-name">Term</Label>
                    <Select
                      id="t-name"
                      value={termName}
                      onChange={(e) => {
                        const preset = NIGERIAN_TERMS.find((t) => t.name === e.target.value);
                        setTermName(e.target.value);
                        if (preset) {
                          setTermLabel(preset.label);
                          setTermStart(`${years.startYear}-${preset.month}-${preset.day}`);
                        }
                      }}
                    >
                      {NIGERIAN_TERMS.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="t-label">Short label</Label>
                    <Input
                      id="t-label"
                      value={termLabel}
                      onChange={(e) => setTermLabel(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="t-start">Starts</Label>
                    <Input
                      id="t-start"
                      type="date"
                      value={termStart}
                      onChange={(e) => setTermStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="t-end">Ends</Label>
                    <Input
                      id="t-end"
                      type="date"
                      value={termEnd}
                      onChange={(e) => setTermEnd(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="t-due">Fees due</Label>
                    <Input
                      id="t-due"
                      type="date"
                      value={termDue}
                      onChange={(e) => setTermDue(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={updating}
                      onClick={createTerm}
                    >
                      {busy === 'term' ? 'Saving…' : 'Create term'}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  Your role cannot create terms.
                </p>
              )}
              {termToActivate && canManageAcademic && (
                <div className="mt-4">
                  <p className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                    {termStep?.done
                      ? 'A term must be active before students can be enrolled into it.'
                      : 'Activate this term to make it the one you are billing in.'}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    disabled={updating}
                    onClick={async () => {
                      const { ok } = await send(
                        `/api/terms/${termToActivate.id}/activate`,
                        {},
                        'activate',
                      );
                      if (ok)
                        refresh(`${termToActivate.name} activated. You can enrol students now.`);
                    }}
                  >
                    {busy === 'activate' ? 'Activating…' : `Activate ${termToActivate.name}`}
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* ── Classes ───────────────────────────────────────────────────── */}
        {active === 'classes' && (
          <Card>
            <CardHeader
              title="Classes"
              description="The classes you bill by. Imported students are enrolled into these by name."
            />
            <div className="px-5 py-5">
              {classStep?.done && (
                <p className="mb-3 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                  {classStep.detail}. Add more below if you need them.
                </p>
              )}
              {canManageAcademic ? (
                <>
                  <p className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                    Select the classes this school runs, then create them.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {CLASS_PRESETS.map((name) => {
                      const chosen = classNames.includes(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={chosen}
                          onClick={() =>
                            setClassNames((prev) =>
                              prev.includes(name)
                                ? prev.filter((n) => n !== name)
                                : [...prev, name],
                            )
                          }
                          className="rounded-sm border px-2.5 py-1 text-[12px] font-medium"
                          style={{
                            borderColor: chosen
                              ? 'var(--color-forest-deep)'
                              : 'var(--color-border)',
                            backgroundColor: chosen ? 'var(--color-forest-deep)' : 'transparent',
                            color: chosen ? '#fff' : 'var(--color-text-secondary)',
                          }}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex max-w-md items-end gap-2">
                    <div className="flex-1">
                      <Label htmlFor="c-custom">Other class</Label>
                      <Input
                        id="c-custom"
                        value={customClass}
                        placeholder="e.g. JSS1 B"
                        onChange={(e) => setCustomClass(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const name = customClass.trim();
                        if (name && !classNames.includes(name)) setClassNames((p) => [...p, name]);
                        setCustomClass('');
                      }}
                    >
                      Add
                    </Button>
                  </div>
                  {classNames.length > 0 && (
                    <div className="mt-4">
                      <Button
                        type="button"
                        variant="primary"
                        disabled={updating}
                        onClick={createClasses}
                      >
                        {busy?.startsWith('class-')
                          ? 'Creating…'
                          : `Create ${classNames.length} class${classNames.length === 1 ? '' : 'es'}`}
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  Your role cannot create classes.
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ── Students ──────────────────────────────────────────────────── */}
        {active === 'students' && (
          <Card>
            <CardHeader title="Import students" />
            {/*
              On its own line rather than on the header's baseline: measured at
              1024px and 1280px the hint lost 275px of its width to an ellipsis
              there, and a half-read promise about what the import does is worse
              than no promise at all.
            */}
            <p className="-mt-1 pb-2 text-xs text-ink-muted">
              Upload your roll as a CSV. Nothing is imported until you have read the preview and
              confirmed.
            </p>
            {!canManageStudents ? (
              <div className="px-5 py-6 text-center">
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  Your role cannot add students.
                </p>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  Ask the proprietor or a finance officer to run the import.
                </p>
              </div>
            ) : status.counts.classes + createdClassCount === 0 ? (
              <div className="px-5 py-6 text-center">
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  Set up your classes first.
                </p>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  Students are enrolled into classes by name during the import, so the classes need
                  to exist. A file with no class column can still be imported.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => setActive('classes')}
                >
                  Add classes
                </Button>
              </div>
            ) : (
              <ImportPanel terms={terms} initialTermId={currentTerm?.id ?? null} />
            )}
          </Card>
        )}

        {/* ── Carry in what is owed ───────────────────────────────────────── */}
        {active === 'balances' && (
          <Card>
            <CardHeader
              title="Carry in what is owed"
              description="What families owed before SCOLAIRA, written down with the paper it came from."
            />
            <div className="px-5 py-4">
              <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                A balance owed from an earlier term is not the same thing as this term&rsquo;s fees,
                a credit the family is owed, or a figure nobody has confirmed. They are recorded
                separately and never added together, because adding them would be a guess about what
                to charge.
              </p>
              <p className="mt-2 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                Recording one here changes nothing: it becomes a real prior-term invoice only after
                someone approves it and posts it.
              </p>
              {status.openingBalances && status.openingBalances.count > 0 ? (
                <p className="mt-2 text-[13px]">
                  {status.openingBalances.count} figure
                  {status.openingBalances.count === 1 ? '' : 's'} in the register
                  {status.openingBalances.pendingReviewCount > 0
                    ? ` · ${status.openingBalances.pendingReviewCount} waiting to be approved`
                    : ''}
                  {/* `approvedNotPostedCount`, not `pendingPostCount`: a figure that is
                      approved and cannot yet be posted is still approved and not posted,
                      and saying so is what stops this line reading as finished. */}
                  {status.openingBalances.approvedNotPostedCount > 0
                    ? ` · ${status.openingBalances.approvedNotPostedCount} approved but not posted`
                    : ''}
                </p>
              ) : null}
              {status.openingBalances && !status.openingBalances.hasPriorTerm ? (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                  There is no past term recorded yet, so a carry-in can be written down but not
                  posted. Add the session and term the money was owed under when you know them.
                </p>
              ) : null}
              <div className="mt-3">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={updating}
                  onClick={() => router.push('/finance/opening-balances')}
                >
                  Open the register
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* ── Ready ─────────────────────────────────────────────────────── */}
        {(active === 'ready' || status.nextStep === 'ready') && (
          <Card className="mt-4">
            <CardHeader title="Ready" description="What is set up, and what to do next." />
            <div className="px-5 py-5">
              <ul className="space-y-1.5 text-[13px]">
                <ReadyLine
                  label="School"
                  detail={status.organization?.name ?? '—'}
                  done={Boolean(status.organization?.name)}
                />
                <ReadyLine
                  label="Session"
                  detail={`${status.counts.sessions} set up`}
                  done={status.counts.sessions > 0}
                />
                <ReadyLine
                  label="Term"
                  detail={
                    status.currentTerm
                      ? `${status.currentTerm.name} · ${status.currentTerm.status.toLowerCase()}`
                      : 'none current'
                  }
                  done={Boolean(status.currentTerm)}
                />
                <ReadyLine
                  label="Classes"
                  detail={`${status.counts.classes} set up`}
                  done={status.counts.classes > 0}
                />
                <ReadyLine
                  label="Students"
                  detail={`${status.counts.students} on roll`}
                  done={status.counts.students > 0}
                />
                {status.openingBalances ? (
                  <ReadyLine
                    label="Carry-in balances"
                    detail={
                      status.openingBalances.count === 0
                        ? 'Nothing recorded yet — worth a look if any family owed money before today'
                        : status.openingBalances.pendingReviewCount +
                              status.openingBalances.approvedNotPostedCount >
                            0
                          ? 'Some figures still need a decision'
                          : 'Reviewed, and posted where the ledger can hold them'
                    }
                    done={
                      status.openingBalances.count > 0 &&
                      status.openingBalances.pendingReviewCount === 0 &&
                      status.openingBalances.approvedNotPostedCount === 0
                    }
                  />
                ) : null}
              </ul>
              {status.readyToBill ? (
                <div className="mt-4">
                  <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                    Your school is ready to be billed. Set your fee structure, then run the term
                    billing when you are ready — billing creates the invoices.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => router.push('/settings/fees')}
                    >
                      Set up fees
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => router.push('/academic')}
                    >
                      Review the roster
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                    Finish the steps above, then your school is ready to be billed.
                  </p>
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        setActive(status.nextStep === 'ready' ? 'students' : status.nextStep)
                      }
                    >
                      Continue setup
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );

  function sessionStep(): GuideStep {
    return status.steps.find((s) => s.key === 'session')!;
  }
}

function ReadyLine({ label, detail, done }: { label: string; detail: string; done: boolean }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: done ? 'var(--color-forest-deep)' : 'var(--color-border)' }}
        aria-hidden
      />
      <span className="w-[86px] shrink-0" style={{ color: 'var(--color-text-faint)' }}>
        {label}
      </span>
      <span style={{ color: done ? 'var(--color-text-primary)' : 'var(--color-text-faint)' }}>
        {detail}
        <span className="sr-only"> {done ? '— complete' : '— not yet complete'}</span>
      </span>
    </li>
  );
}
