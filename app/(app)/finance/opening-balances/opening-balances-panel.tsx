'use client';
/**
 * The opening-balance register: record → review → post, in that order, on one
 * screen, with the reason a figure cannot move forward stated next to the figure.
 *
 * WHY THE ORDER IS THE INTERFACE
 *   A carry-in enters a school's financial history. Two people are meant to touch
 *   it — whoever read the paper, and whoever decided it is true — so the panel
 *   separates recording from posting rather than offering one "Add balance" button
 *   that quietly invents a charge. Where a school is one person, that person may do
 *   both, and the row says so. That honesty is the control.
 *
 * WHAT IS NEVER CLAIMED
 *   No message here says a figure was posted when it was not, and no success
 *   message is shown until the API has answered. A refused post keeps the row as it
 *   was and prints the server's own sentence, because the sentence is the
 *   explanation ("a credit cannot be posted: …"), not a failure code.
 *
 * MONEY IN, Kobo OUT
 *   Amounts are typed in naira and sent as whole kobo. The parsing is the one the
 *   payment and invoice forms use, so `45000` and `45,000.00` are both valid to
 *   type, and the value that leaves the browser is an integer number of kobo.
 *   There is no other arithmetic on the wire: every figure the register shows is
 *   formatted from kobo by `lib/money`.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { csrfHeaders } from '@/lib/ui/csrf';
import { formatKoboDisplay } from '@/lib/money';

export interface BalanceRow {
  id: string;
  studentId: string;
  studentName: string;
  studentNumber: string | null;
  category: string;
  categoryLabel: string;
  amountKobo: number;
  signedAmountKobo: number;
  asAt: string;
  termId: string | null;
  termName: string | null;
  sourceNote: string;
  evidenceRef: string | null;
  status: 'DRAFT' | 'APPROVED' | 'REJECTED' | 'POSTED' | 'REVERSED';
  reviewNote: string | null;
  selfReviewed: boolean;
  postedInvoiceId: string | null;
  postedInvoiceNumber: string | null;
  postedInvoiceStatus: string | null;
  postedInvoicePaidKobo: number | null;
  outstandingKobo: number | null;
  canPost: boolean;
  postBlockedBecause: string | null;
}

export interface BalanceSummary {
  count: number;
  pendingReviewCount: number;
  pendingPostCount: number;
  postedKobo: number;
  outstandingKobo: number;
  collectedAgainstCarryInKobo: number;
  hasPriorTerm: boolean;
  hasCurrentTerm: boolean;
  byCategory: Record<
    string,
    { count: number; amountKobo: number; signedAmountKobo: number; outstandingKobo: number }
  >;
}

export interface CategoryOption {
  value: string;
  label: string;
  postable: boolean;
}

export interface TermOption {
  id: string;
  name: string;
  startsOn: string;
}

interface Props {
  rows: BalanceRow[];
  summary: BalanceSummary;
  categories: CategoryOption[];
  priorTerms: TermOption[];
  currentTerm: TermOption | null;
  students: Array<{ id: string; name: string; number: string | null }>;
  canCreate: boolean;
  canIssue: boolean;
  canVoid: boolean;
}

const STATUS_WORDS: Record<BalanceRow['status'], string> = {
  DRAFT: 'Not reviewed yet',
  APPROVED: 'Approved, not posted',
  REJECTED: 'Rejected',
  POSTED: 'Posted to the ledger',
  REVERSED: 'Reversed',
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Naira typed as money → whole kobo.
 *
 * `lib/money`'s `parseNaira` deliberately accepts only the strict `naira.kobo`
 * form (it is used where a stored string is being re-parsed). A bursar copying a
 * figure out of an exercise book types `45000`, `45,000` or `45,000.00`, and
 * refusing the first two would make the register unusable. So this panel parses
 * the way the two other money-entry surfaces in the app already do —
 * `payments/new/record-payment-form.tsx` and `invoices/new/new-invoice-form.tsx`
 * carry the identical helper — and `0` out of a non-amount is turned into a
 * message rather than a silent zero. Nothing here sends a fractional kobo.
 */
function amountToKobo(s: string): number | null {
  const clean = s.replace(/[^0-9.]/g, '');
  const n = Number(clean);
  if (!clean || Number.isNaN(n)) return null;
  const kobo = Math.round(n * 100);
  return kobo > 0 ? kobo : null;
}

/** One round trip, one sentence back. Errors are the server's words, not ours. */
async function send(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...csrfHeaders(),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: { error?: { message?: string }; note?: string } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        message:
          data?.error?.message ?? `SCOLAIRA refused that (${res.status}). Nothing was changed.`,
      };
    }
    return { ok: true, message: data?.note ?? 'Saved.' };
  } catch {
    return {
      ok: false,
      message:
        'The request did not reach SCOLAIRA. Nothing was changed — check the connection and try again.',
    };
  }
}

export default function OpeningBalancesPanel({
  rows,
  summary,
  categories,
  priorTerms,
  currentTerm,
  students,
  canCreate,
  canIssue,
  canVoid,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const [studentId, setStudentId] = useState<string>(students[0]?.id ?? '');
  const [category, setCategory] = useState<string>(
    categories.find((c) => c.postable)?.value ?? categories[0]?.value ?? 'HISTORICAL_BALANCE',
  );
  const [amount, setAmount] = useState('');
  const [asAt, setAsAt] = useState(today());
  const [termId, setTermId] = useState(priorTerms[0]?.id ?? '');
  const [sourceNote, setSourceNote] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [note, setNote] = useState('');

  const updating = busy !== null;
  const selectedCategory = categories.find((c) => c.value === category) ?? null;

  async function run(label: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    const result = await fn();
    setBusy(null);
    if (result.ok) {
      setNotice(result.message);
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  function submitRecord() {
    const koboAmount = amountToKobo(amount);
    if (koboAmount === null) {
      setError(
        'Enter the amount as money greater than zero, for example 45000, 45,000 or 45,000.00.',
      );
      return;
    }
    if (!studentId) {
      setError('Choose the child this balance belongs to.');
      return;
    }
    void run('Record', () =>
      send('/api/opening-balances', {
        studentId,
        category,
        amountKobo: koboAmount,
        asAt,
        termId: termId || null,
        sourceNote,
        evidenceRef: evidenceRef || null,
      }),
    );
  }

  function submitReview(row: BalanceRow, decision: 'APPROVE' | 'REJECT') {
    void run(`${decision} ${row.studentName}`, () =>
      send(`/api/opening-balances/${row.id}/review`, { decision, note: note || null }),
    );
  }

  function submitPost(row: BalanceRow) {
    void run(`Post ${row.studentName}`, () =>
      send(`/api/opening-balances/${row.id}/post`, {}, crypto.randomUUID()),
    );
  }

  function submitReverse(row: BalanceRow) {
    void run(`Reverse ${row.studentName}`, () =>
      send(`/api/opening-balances/${row.id}/reverse`, { reason: note }),
    );
  }

  const totals = [
    {
      label: 'Owed from before, still outstanding',
      value: summary.byCategory.HISTORICAL_BALANCE?.outstandingKobo ?? 0,
      detail:
        summary.postedKobo > 0
          ? 'Read back from the posted invoices, not from this register.'
          : 'Nothing has been posted yet, so nothing is owed in the ledger.',
    },
    {
      label: 'Waiting to be reviewed',
      value: null,
      detail: `${summary.pendingReviewCount} figure${summary.pendingReviewCount === 1 ? '' : 's'} recorded and not yet approved or rejected.`,
    },
    {
      label: 'Approved, not posted',
      value: null,
      detail: `${summary.pendingPostCount} figure${summary.pendingPostCount === 1 ? '' : 's'} ready to become a prior-term invoice.`,
    },
    {
      label: 'Credits and overpayments',
      value: summary.byCategory.CREDIT_OVERPAYMENT?.signedAmountKobo ?? 0,
      detail: 'Recorded, never posted: a credit is not money received.',
    },
    {
      label: 'Unverified',
      value: null,
      detail: `${summary.byCategory.UNVERIFIED?.count ?? 0} figure${summary.byCategory.UNVERIFIED?.count === 1 ? '' : 's'} kept out of every total until someone confirms it.`,
    },
  ];

  return (
    <div className="space-y-4">
      {/* ── What the register says, in the school's own terms ─────────────── */}
      <Card>
        <CardHeader
          title="The register"
          description="Five separate figures, deliberately never added together."
        />
        <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {totals.map((t) => (
            <li key={t.label} className="px-5 py-3">
              <p className="text-[13px] font-medium">{t.label}</p>
              {t.value !== null ? (
                <p className="mt-0.5 text-[15px] font-semibold tabular-nums">
                  {formatKoboDisplay(Math.abs(t.value))}
                  {t.value < 0 ? ' owed to the family' : ''}
                </p>
              ) : null}
              <p className="mt-0.5 text-[12px] text-ink-muted">{t.detail}</p>
            </li>
          ))}
        </ul>
        {!summary.hasPriorTerm ? (
          <div className="border-t px-5 py-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <p className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
              There is no past term recorded yet, so a historical balance can be written down but
              not posted. Add the session and term the money was owed under, and posting opens up.
            </p>
          </div>
        ) : null}
      </Card>

      {/* ── Record a figure ───────────────────────────────────────────────── */}
      {canCreate ? (
        <Card>
          <CardHeader
            title="Record what was owed"
            description="Say where the figure came from. A number with no source is not a record."
          />
          <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
            <div>
              <Label htmlFor="ob-student">Child</Label>
              {students.length === 0 ? (
                <p className="mt-1 text-[12px] text-ink-muted">
                  No students on the roll yet. Import the register first — a balance has to belong
                  to a child.
                </p>
              ) : (
                <Select
                  id="ob-student"
                  value={studentId}
                  disabled={updating}
                  onChange={(e) => setStudentId(e.target.value)}
                >
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.number ? ` · ${s.number}` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <div>
              <Label htmlFor="ob-category">What kind of figure is it</Label>
              <Select
                id="ob-category"
                value={category}
                disabled={updating}
                onChange={(e) => setCategory(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              {selectedCategory && !selectedCategory.postable ? (
                <p className="mt-1 text-[12px] text-ink-muted">
                  This kind is recorded and reported, never posted.
                </p>
              ) : null}
            </div>

            <div>
              <Label htmlFor="ob-amount">Amount (naira)</Label>
              <Input
                id="ob-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="45000"
                value={amount}
                disabled={updating}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="ob-asat">True as at</Label>
              <Input
                id="ob-asat"
                type="date"
                value={asAt}
                disabled={updating}
                onChange={(e) => setAsAt(e.target.value)}
              />
              {currentTerm ? (
                <p className="mt-1 text-[12px] text-ink-muted">
                  For a carry-in this must fall before {currentTerm.name} began (
                  {currentTerm.startsOn}).
                </p>
              ) : null}
            </div>

            <div>
              <Label htmlFor="ob-term">Which past term it was owed under</Label>
              <Select
                id="ob-term"
                value={termId}
                disabled={updating || priorTerms.length === 0}
                onChange={(e) => setTermId(e.target.value)}
              >
                {priorTerms.length === 0 ? <option value="">No past term recorded</option> : null}
                {priorTerms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · began {t.startsOn}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="ob-source">Where it came from</Label>
              <Input
                id="ob-source"
                autoComplete="off"
                placeholder="Old receipt book, page 14"
                value={sourceNote}
                disabled={updating}
                onChange={(e) => setSourceNote(e.target.value)}
              />
            </div>

            <div className="md:col-span-2">
              <Label htmlFor="ob-evidence">Reference (optional)</Label>
              <Input
                id="ob-evidence"
                autoComplete="off"
                placeholder="Bank statement March 2025, or “class file, JSS2”"
                value={evidenceRef}
                disabled={updating}
                onChange={(e) => setEvidenceRef(e.target.value)}
              />
            </div>
          </div>

          <div
            className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <p className="text-[12px] text-ink-muted">
              This records the figure. It does not bill anyone.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={submitRecord}
              disabled={updating || !studentId || !amount || sourceNote.trim().length < 1}
            >
              {busy === 'Record' ? 'Recording…' : 'Record it'}
            </Button>
          </div>
        </Card>
      ) : null}

      <div aria-live="polite">
        {notice ? (
          <p className="text-[13px]" style={{ color: 'var(--color-success-fg)' }}>
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="text-[13px]" style={{ color: 'var(--color-danger-fg)' }}>
            {error}
          </p>
        ) : null}
      </div>

      {/* ── The rows ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={`${rows.length} recorded figure${rows.length === 1 ? '' : 's'}`}
          description="Each row keeps who recorded it, who approved it, and what became of it."
        />
        {rows.length === 0 ? (
          <p
            className="px-5 py-6 text-center text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Nothing carried in yet.
          </p>
        ) : (
          <>
            {/* Wide screens: one row per figure. Narrow: stacked, because a
                sideways-scroll table hides the amount on a phone, and the amount
                is the reason the row exists. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
                    <th className="px-3 py-2 font-medium">Child</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">As at</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <BalanceRowCells
                      key={row.id}
                      row={row}
                      open={openRow === row.id}
                      onToggle={() => setOpenRow(openRow === row.id ? null : row.id)}
                      busy={updating}
                      canIssue={canIssue}
                      canVoid={canVoid}
                      note={note}
                      setNote={setNote}
                      onApprove={() => submitReview(row, 'APPROVE')}
                      onReject={() => submitReview(row, 'REJECT')}
                      onPost={() => submitPost(row)}
                      onReverse={() => submitReverse(row)}
                      busyLabel={busy ?? ''}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y md:hidden">
              {rows.map((row) => (
                <li key={row.id} className="px-4 py-3">
                  <p className="text-[13px] font-medium">{row.studentName}</p>
                  <p className="text-[12px] text-ink-muted">
                    {row.categoryLabel} · {STATUS_WORDS[row.status]}
                  </p>
                  {/* The two things the desktop table puts under the status are the
                      ones that make a carry-in checkable, so a phone gets them too:
                      who approved it, and which ledger invoice now stands for it. */}
                  {row.selfReviewed ? (
                    <p className="mt-1 text-[12px] text-ink-muted">
                      recorded and approved by the same person
                    </p>
                  ) : null}
                  {row.postedInvoiceNumber ? (
                    <p className="mt-1 text-[12px] tabular-nums text-ink-muted">
                      {row.postedInvoiceNumber}
                      {row.postedInvoiceStatus === 'VOID' ? ' · voided' : ''}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[15px] font-semibold tabular-nums">
                    {formatKoboDisplay(Math.abs(row.signedAmountKobo))}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-muted">{row.sourceNote}</p>
                  {row.postBlockedBecause ? (
                    <p className="mt-1 text-[12px]">{row.postBlockedBecause}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={updating}
                      onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                    >
                      {openRow === row.id ? 'Hide actions' : 'Actions'}
                    </Button>
                  </div>
                  {openRow === row.id ? (
                    <RowActions
                      row={row}
                      busy={updating}
                      canIssue={canIssue}
                      canVoid={canVoid}
                      note={note}
                      setNote={setNote}
                      onApprove={() => submitReview(row, 'APPROVE')}
                      onReject={() => submitReview(row, 'REJECT')}
                      onPost={() => submitPost(row)}
                      onReverse={() => submitReverse(row)}
                      busyLabel={busy ?? ''}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function BalanceRowCells({
  row,
  open,
  onToggle,
  busy,
  canIssue,
  canVoid,
  note,
  setNote,
  onApprove,
  onReject,
  onPost,
  onReverse,
  busyLabel,
}: {
  row: BalanceRow;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  canIssue: boolean;
  canVoid: boolean;
  note: string;
  setNote: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onPost: () => void;
  onReverse: () => void;
  busyLabel: string;
}) {
  return (
    <>
      <tr className="border-b align-top" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <td className="px-3 py-3">
          <span className="font-medium">{row.studentName}</span>
          {row.studentNumber ? (
            <span className="block text-[12px] tabular-nums text-ink-muted">
              {row.studentNumber}
            </span>
          ) : null}
        </td>
        <td className="px-3 py-3">
          {row.categoryLabel}
          {row.termName ? (
            <span className="block text-[12px] text-ink-muted">{row.termName}</span>
          ) : null}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {formatKoboDisplay(Math.abs(row.signedAmountKobo))}
          <span className="block text-[12px] text-ink-muted">
            {row.signedAmountKobo < 0
              ? 'the family is owed this'
              : row.outstandingKobo !== null &&
                  row.outstandingKobo !== Math.abs(row.signedAmountKobo)
                ? `${formatKoboDisplay(row.outstandingKobo)} still outstanding`
                : 'as recorded'}
          </span>
        </td>
        <td className="px-3 py-3 tabular-nums">{row.asAt}</td>
        <td className="px-3 py-3">
          <span className="block">{STATUS_WORDS[row.status]}</span>
          {row.selfReviewed ? (
            <span className="block text-[12px] text-ink-muted">
              recorded and approved by the same person
            </span>
          ) : null}
          {row.postedInvoiceNumber ? (
            <span className="block text-[12px] tabular-nums text-ink-muted">
              {row.postedInvoiceNumber}
              {row.postedInvoiceStatus === 'VOID' ? ' · voided' : ''}
            </span>
          ) : null}
        </td>
        <td className="px-3 py-3 text-right">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onToggle}>
            {open ? 'Hide' : 'Actions'}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td
            colSpan={6}
            className="border-b px-3 pb-4"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <RowActions
              row={row}
              busy={busy}
              canIssue={canIssue}
              canVoid={canVoid}
              note={note}
              setNote={setNote}
              onApprove={onApprove}
              onReject={onReject}
              onPost={onPost}
              onReverse={onReverse}
              busyLabel={busyLabel}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RowActions(props: {
  row: BalanceRow;
  busy: boolean;
  canIssue: boolean;
  canVoid: boolean;
  note: string;
  setNote: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onPost: () => void;
  onReverse: () => void;
  busyLabel: string;
}) {
  const {
    row,
    busy,
    canIssue,
    canVoid,
    note,
    setNote,
    onApprove,
    onReject,
    onPost,
    onReverse,
    busyLabel,
  } = props;
  return (
    <div className="space-y-3 pt-2">
      <p className="text-[12px] text-ink-muted">
        <span className="font-medium text-ink-secondary">Source:</span> {row.sourceNote}
        {row.evidenceRef ? ` · ${row.evidenceRef}` : ''}
      </p>
      {row.reviewNote ? (
        <p className="text-[12px] text-ink-muted">
          <span className="font-medium text-ink-secondary">Review note:</span> {row.reviewNote}
        </p>
      ) : null}
      {row.postBlockedBecause ? <p className="text-[12px]">{row.postBlockedBecause}</p> : null}

      <div>
        <Label htmlFor={`ob-note-${row.id}`}>
          {row.status === 'POSTED' ? 'Reason for reversing' : 'Note for the record'}
        </Label>
        <Input
          id={`ob-note-${row.id}`}
          autoComplete="off"
          placeholder={
            row.status === 'POSTED'
              ? 'Why this carry-in is being taken back out'
              : row.status === 'DRAFT'
                ? 'What you checked it against'
                : 'Why it is being rejected'
          }
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {canIssue && row.status === 'DRAFT' ? (
          <Button type="button" size="sm" disabled={busy} onClick={onApprove}>
            {busyLabel.startsWith('APPROVE') ? 'Approving…' : 'Approve'}
          </Button>
        ) : null}
        {canIssue && (row.status === 'DRAFT' || row.status === 'APPROVED') ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onReject}>
            Reject
          </Button>
        ) : null}
        {canIssue && row.canPost ? (
          <Button type="button" size="sm" disabled={busy} onClick={onPost}>
            {busyLabel.startsWith('Post') ? 'Posting…' : 'Post to the ledger'}
          </Button>
        ) : null}
        {canVoid && row.status === 'POSTED' ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onReverse}>
            Reverse
          </Button>
        ) : null}
      </div>

      {row.status === 'APPROVED' && !row.canPost ? (
        <p className="text-[12px] text-ink-muted">
          Approved. It will post as a prior-term invoice as soon as the term it belongs to is set.
        </p>
      ) : null}
    </div>
  );
}
