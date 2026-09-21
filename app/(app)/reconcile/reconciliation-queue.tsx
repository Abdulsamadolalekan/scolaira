'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { csrfHeaders } from '@/lib/ui/csrf';
import type { QueueRow } from '@/lib/db/repo/reconciliation';

type Detail = {
  payment: {
    id: string;
    paymentNumber: string;
    status: string;
    method: string;
    amountKobo: number;
    unallocatedKobo: number;
    reference: string | null;
    payerName: string | null;
    payerPhone: string | null;
    payerEmail: string | null;
    paidAt: string | null;
    createdAt: string;
  };
  reconciliation: {
    case: any | null;
    derived?: { state: string; kind: string } | null;
    evidence: any[];
    candidates: any[];
    history: any[];
  };
  allocations: Array<{ status: string }>;
  audit: any[];
};

export default function ReconciliationQueue({
  initialRows,
  nextCursor: initialCursor,
}: {
  initialRows: QueueRow[];
  nextCursor: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // router.refresh() replaces the server props, but does not reset local state
  // initialized from those props. Keep the visible queue aligned with the
  // server response after every successful mutation or navigation refresh.
  useEffect(() => {
    setRows(initialRows);
    setCursor(initialCursor);
  }, [initialRows, initialCursor]);

  async function loadDetail(paymentId: string) {
    if (details[paymentId]) return;
    const response = await fetch(`/api/reconciliation/payments/${paymentId}`, {
      credentials: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? 'Could not load payment detail.');
    setDetails((old) => ({ ...old, [paymentId]: data }));
  }

  async function toggle(paymentId: string) {
    setError(null);
    if (expanded === paymentId) {
      setExpanded(null);
      return;
    }
    setExpanded(paymentId);
    try {
      await loadDetail(paymentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payment detail.');
    }
  }

  async function post(paymentId: string, path: string, body: unknown, label: string) {
    setBusy(`${paymentId}:${path}`);
    setError(null);
    try {
      const response = await fetch(`/api/reconciliation/payments/${paymentId}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...csrfHeaders(),
        },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data?.error?.message ?? `Could not ${label.toLowerCase()}.`);
      setDetails((old) => {
        const copy = { ...old };
        delete copy[paymentId];
        return copy;
      });
      setBusy(null);
      router.refresh();
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : `Could not ${label.toLowerCase()}.`);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setBusy('more');
    setError(null);
    try {
      const response = await fetch(
        `/api/reconciliation/queue?limit=50&cursor=${encodeURIComponent(cursor)}`,
        { credentials: 'same-origin' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not load more cases.');
      setRows((old) => [...old, ...(data.queue ?? [])]);
      setCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more cases.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {error && (
        <div
          className="mb-3 rounded-md px-3 py-2 text-sm"
          style={{
            background: 'rgba(185,56,42,.08)',
            color: 'var(--color-danger,#a82a1c)',
            border: '1px solid rgba(185,56,42,.25)',
          }}
        >
          {error}
        </div>
      )}
      <div
        className="overflow-hidden rounded-md border"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div
          className="hidden grid-cols-[1.1fr_1fr_1fr_.9fr_1fr_auto] gap-3 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider md:grid"
          style={{ color: 'var(--color-text-faint)', background: 'var(--color-bg-page)' }}
        >
          <div>Payment</div>
          <div>Source / date</div>
          <div>Student / invoice</div>
          <div>Amount</div>
          <div>Control state</div>
          <div />
        </div>
        {rows.length === 0 && (
          <div className="p-10 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>
            No payments currently require reconciliation.
          </div>
        )}
        {rows.map((row) => (
          <div
            key={`${row.paymentId}:${row.caseId ?? 'derived'}`}
            className="border-t first:border-t-0"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <button
              type="button"
              onClick={() => void toggle(row.paymentId)}
              className="w-full px-4 py-3 text-left hover:bg-[color:var(--color-bg-page)]"
            >
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1.1fr_1fr_1fr_.9fr_1fr_auto] md:items-center md:gap-3">
                <div className="min-w-0">
                  <div
                    className="text-[13px] font-medium tabular-nums"
                    style={{ color: 'var(--color-forest)' }}
                  >
                    {row.paymentNumber}
                  </div>
                  <div
                    className="truncate text-[11px]"
                    style={{ color: 'var(--color-text-faint)' }}
                  >
                    {row.payerName || 'Payer not recorded'}
                    {row.reference ? ` · ${row.reference}` : ''}
                  </div>
                </div>
                <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                  <div>{row.method.replaceAll('_', ' ')}</div>
                  <div className="text-[11px]">{formatDate(row.paidAt || row.createdAt)}</div>
                </div>
                <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                  <div>{row.studentName || 'Not established'}</div>
                  <div className="text-[11px]">{row.invoiceNumber || 'No invoice linked'}</div>
                </div>
                <div className="text-[12px] tabular-nums">
                  <div className="font-semibold">
                    <Money kobo={row.amountKobo} size="sm" hideDecimals />
                  </div>
                  <div
                    className="text-[11px]"
                    style={{
                      color:
                        row.unallocatedKobo > 0
                          ? 'var(--color-gold-dark,#8a6b11)'
                          : 'var(--color-text-faint)',
                    }}
                  >
                    {row.unallocatedKobo > 0
                      ? `${formatMoney(row.unallocatedKobo)} unallocated`
                      : 'Fully allocated'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StateBadge state={row.state} />
                  <span className="text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                    {row.evidenceCount} evidence
                  </span>
                </div>
                <div
                  className="text-right text-[18px]"
                  style={{ color: 'var(--color-text-faint)' }}
                >
                  {expanded === row.paymentId ? '−' : '+'}
                </div>
              </div>
            </button>
            {expanded === row.paymentId && details[row.paymentId] && (
              <CaseDetail row={row} detail={details[row.paymentId]!} busy={busy} onPost={post} />
            )}
          </div>
        ))}
      </div>
      {cursor && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={busy === 'more'}
            className="rounded-md border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          >
            {busy === 'more' ? 'Loading…' : 'Load more cases'}
          </button>
        </div>
      )}
    </div>
  );
}

function CaseDetail({
  row,
  detail,
  busy,
  onPost,
}: {
  row: QueueRow;
  detail: Detail;
  busy: string | null;
  onPost: (paymentId: string, path: string, body: unknown, label: string) => Promise<void>;
}) {
  const currentCase = detail.reconciliation.case;
  const payment = detail.payment;
  const state = currentCase?.state ?? detail.reconciliation.derived?.state ?? row.state;
  const isClosed = Boolean(currentCase?.closedAt);
  const activeAllocationCount = detail.allocations.filter(
    (allocation) => allocation.status === 'ACTIVE',
  ).length;
  const [evidenceKind, setEvidenceKind] = useState('OPERATOR_NOTE');
  const [evidenceText, setEvidenceText] = useState('');
  const [matchInvoice, setMatchInvoice] = useState('');
  const [matchBasis, setMatchBasis] = useState('');
  const [allocateAmount, setAllocateAmount] = useState(String(payment.unallocatedKobo));
  const [reason, setReason] = useState('');
  const actionBusy = (path: string) => busy === `${row.paymentId}:${path}`;

  function submitEvidence(e: React.FormEvent) {
    e.preventDefault();
    if (isClosed || !evidenceText.trim()) return;
    void onPost(
      row.paymentId,
      'evidence',
      { kind: evidenceKind, note: evidenceText.trim() },
      'Add evidence',
    ).then(() => setEvidenceText(''));
  }
  return (
    <div className="px-4 pb-4" style={{ background: 'var(--color-bg-page)' }}>
      <div
        className="grid grid-cols-1 gap-4 border-t pt-4 lg:grid-cols-3"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="space-y-3 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
            <Info label="Case kind" value={currentCase?.kind ?? row.caseKind} />
            <Info label="Payment status" value={payment.status} />
            <Info label="Allocations" value={`${activeAllocationCount} active`} />
            <Info
              label="Assigned"
              value={row.assignedTo ? row.assignedTo.slice(0, 8) : 'Unassigned'}
            />
          </div>
          <div
            className="rounded-md border p-3"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'var(--color-bg-surface)',
            }}
          >
            <div
              className="mb-2 text-[10px] font-medium uppercase tracking-wider"
              style={{ color: 'var(--color-text-faint)' }}
            >
              Evidence
            </div>
            {detail.reconciliation.evidence.length === 0 ? (
              <div className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                No evidence recorded yet. Decisions require at least one durable evidence item.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {detail.reconciliation.evidence.map((e) => (
                  <li key={e.id} className="text-[12px]">
                    <span className="font-medium">{e.kind.replaceAll('_', ' ')}</span>
                    {e.note ? ` — ${e.note}` : ''}
                    <span className="ml-2 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                      {formatDate(e.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {isClosed && (
              <div className="mt-3 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                This case is closed; the server will not accept new evidence or decisions.
              </div>
            )}
            <form
              onSubmit={submitEvidence}
              className="mt-3 grid gap-2 sm:grid-cols-[150px_1fr_auto]"
            >
              <select
                value={evidenceKind}
                onChange={(e) => setEvidenceKind(e.target.value)}
                disabled={isClosed}
                className="rounded-md border px-2 py-2 text-[12px]"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-page)' }}
              >
                <option>OPERATOR_NOTE</option>
                <option>BANK_REFERENCE</option>
                <option>CASH_RECEIPT</option>
                <option>POS_SLIP</option>
                <option>PROVIDER_EVENT</option>
              </select>
              <input
                value={evidenceText}
                onChange={(e) => setEvidenceText(e.target.value)}
                disabled={isClosed}
                placeholder="Reference or observation"
                className="rounded-md border px-2 py-2 text-[12px]"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-page)' }}
              />
              <button
                type="submit"
                disabled={isClosed || !evidenceText.trim() || actionBusy('evidence')}
                className="rounded-md px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--color-forest)' }}
              >
                {actionBusy('evidence') ? 'Adding…' : 'Add evidence'}
              </button>
            </form>
          </div>
          <div
            className="rounded-md border p-3"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'var(--color-bg-surface)',
            }}
          >
            <div
              className="mb-2 text-[10px] font-medium uppercase tracking-wider"
              style={{ color: 'var(--color-text-faint)' }}
            >
              Established context and prior decisions
            </div>
            <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
              {detail.reconciliation.candidates.length
                ? detail.reconciliation.candidates.map((c) => (
                    <div key={c.id}>
                      Candidate <strong>{c.invoiceId || c.studentId}</strong> · {c.state} ·{' '}
                      {c.basis}
                    </div>
                  ))
                : 'No human candidate established.'}
            </div>
            <ul className="mt-2 space-y-1">
              {detail.audit.slice(0, 8).map((a) => (
                <li key={a.id} className="text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                  {formatDate(a.createdAt)} · {a.action}
                  {a.reason ? ` — ${a.reason}` : ''}
                </li>
              ))}
            </ul>
            {detail.reconciliation.history.length > 0 && (
              <div className="mt-2 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                Earlier cases:{' '}
                {detail.reconciliation.history
                  .map(
                    (h) =>
                      `${h.kind} ${h.state}${h.resolutionCode ? ` (${h.resolutionCode})` : ''}`,
                  )
                  .join(' · ')}
              </div>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <div
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: 'var(--color-text-faint)' }}
          >
            Permitted actions
          </div>
          {!isClosed &&
            (payment.status === 'PENDING' ||
              (payment.status === 'DUPLICATE_SUSPECT' && payment.unallocatedKobo > 0)) && (
              <ActionButton
                busy={actionBusy('confirm')}
                onClick={() => void onPost(row.paymentId, 'confirm', {}, 'Confirm payment')}
              >
                {payment.status === 'DUPLICATE_SUSPECT'
                  ? 'Confirm after duplicate review'
                  : 'Confirm payment'}
              </ActionButton>
            )}
          {!isClosed &&
            payment.unallocatedKobo > 0 &&
            state !== 'RECONCILED' &&
            state !== 'ALLOCATED' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (matchInvoice && matchBasis)
                    void onPost(
                      row.paymentId,
                      'match',
                      { invoiceId: matchInvoice, basis: matchBasis },
                      'Match payment',
                    );
                }}
                className="space-y-2 rounded-md border p-3"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                <div className="text-[12px] font-medium">Establish invoice match</div>
                <input
                  required
                  value={matchInvoice}
                  onChange={(e) => setMatchInvoice(e.target.value)}
                  placeholder="Invoice UUID"
                  className="w-full rounded-md border px-2 py-2 text-[11px]"
                  style={{ borderColor: 'var(--color-border)' }}
                />
                <input
                  required
                  value={matchBasis}
                  onChange={(e) => setMatchBasis(e.target.value)}
                  placeholder="Human basis for match"
                  className="w-full rounded-md border px-2 py-2 text-[11px]"
                  style={{ borderColor: 'var(--color-border)' }}
                />
                <ActionButton busy={actionBusy('match')} type="submit">
                  Record match
                </ActionButton>
              </form>
            )}
          {!isClosed && payment.unallocatedKobo > 0 && state === 'RECONCILED' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const amountKobo = Number(allocateAmount);
                if (amountKobo > 0)
                  void onPost(
                    row.paymentId,
                    'allocate',
                    {
                      allocations: [
                        {
                          invoiceId:
                            matchInvoice ||
                            detail.reconciliation.candidates.find((c) => c.invoiceId)?.invoiceId,
                          amountKobo,
                        },
                      ],
                    },
                    'Allocate payment',
                  );
              }}
              className="space-y-2 rounded-md border p-3"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <div className="text-[12px] font-medium">Use existing allocation mechanism</div>
              <input
                value={
                  matchInvoice ||
                  detail.reconciliation.candidates.find((c) => c.invoiceId)?.invoiceId ||
                  ''
                }
                onChange={(e) => setMatchInvoice(e.target.value)}
                placeholder="Invoice UUID"
                className="w-full rounded-md border px-2 py-2 text-[11px]"
                style={{ borderColor: 'var(--color-border)' }}
              />
              <input
                type="number"
                min="1"
                max={payment.unallocatedKobo}
                value={allocateAmount}
                onChange={(e) => setAllocateAmount(e.target.value)}
                className="w-full rounded-md border px-2 py-2 text-[11px]"
                style={{ borderColor: 'var(--color-border)' }}
              />
              <ActionButton busy={actionBusy('allocate')} type="submit">
                Allocate {formatMoney(Number(allocateAmount) || 0)}
              </ActionButton>
            </form>
          )}
          {!isClosed && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim())
                  void onPost(
                    row.paymentId,
                    'flag',
                    { flagged: true, reason: reason.trim() },
                    'Flag case',
                  );
              }}
              className="space-y-2 rounded-md border p-3"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Flag / resolve reason"
                className="w-full rounded-md border px-2 py-2 text-[11px]"
                style={{ borderColor: 'var(--color-border)' }}
              />
              {state === 'FLAGGED' ? (
                <>
                  <ActionButton
                    busy={actionBusy('flag')}
                    type="button"
                    onClick={() =>
                      void onPost(
                        row.paymentId,
                        'flag',
                        { flagged: false, reason: reason.trim() || 'Reviewed and unflagged.' },
                        'Unflag case',
                      )
                    }
                  >
                    Unflag case
                  </ActionButton>
                  <ActionButton
                    busy={actionBusy('resolve')}
                    type="button"
                    onClick={() =>
                      void onPost(
                        row.paymentId,
                        'resolve',
                        {
                          resolutionCode: 'NO_FINANCIAL_ACTION',
                          note: reason.trim() || 'Reviewed with no financial action.',
                        },
                        'Resolve case',
                      )
                    }
                  >
                    Resolve with no financial action
                  </ActionButton>
                </>
              ) : (
                <ActionButton busy={actionBusy('flag')} type="submit">
                  Flag for review
                </ActionButton>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  busy,
  onClick,
  type = 'button',
}: {
  children: React.ReactNode;
  busy?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy}
      className="w-full rounded-md px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
      style={{ background: 'var(--color-forest)' }}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--color-text-faint)' }}
      >
        {label}
      </div>
      <div className="mt-0.5 truncate font-medium" style={{ color: 'var(--color-text-primary)' }}>
        {value}
      </div>
    </div>
  );
}
function StateBadge({ state }: { state: string }) {
  return (
    <Badge
      variant={
        state === 'FLAGGED'
          ? 'danger'
          : state === 'RECONCILED' || state === 'ALLOCATED'
            ? 'success'
            : 'warning'
      }
    >
      {state}
    </Badge>
  );
}
function formatDate(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString('en-NG', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : 'Date not recorded';
}
function formatMoney(kobo: number) {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
