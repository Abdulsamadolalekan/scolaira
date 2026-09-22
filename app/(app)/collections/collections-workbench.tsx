'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { csrfHeaders } from '@/lib/ui/csrf';
import { Money } from '@/components/ui/money';

type State = 'OPEN' | 'IN_PROGRESS' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

type QueueCase = {
  id: string;
  studentId: string;
  studentIdCode: string;
  studentName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceDueDate: string | null;
  state: State;
  priority: Priority;
  reason: string;
  assignedTo: string | null;
  nextActionAt: string | null;
  outstandingKobo: number;
  studentOutstandingKobo: number;
  openInvoiceCount: number;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
};

type Event = {
  id: string;
  eventType: string;
  previousState: State | null;
  nextState: State | null;
  previousAssignee: string | null;
  nextAssignee: string | null;
  note: string | null;
  reminderId: string | null;
  createdBy: string;
  createdAt: string;
};

type Detail = {
  case: QueueCase & {
    createdBy: string;
    resolvedBy: string | null;
    resolvedAt: string | null;
    closedBy: string | null;
    closedAt: string | null;
  };
  events: Event[];
  obligations: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    issueDate: string | null;
    dueDate: string | null;
    totalKobo: number;
    paidKobo: number;
    outstandingKobo: number;
  }>;
  payments: Array<{
    paymentId: string;
    paymentNumber: string;
    paymentStatus: string;
    method: string;
    amountKobo: number;
    unallocatedKobo: number;
    reference: string | null;
    payerName: string | null;
    paidAt: string | null;
    allocationId: string;
    invoiceId: string;
    invoiceNumber: string;
    allocationAmountKobo: number;
    allocationStatus: string;
    allocatedAt: string | null;
    allocationNote: string | null;
  }>;
  reversals: Array<Record<string, string | number | null>>;
  receipts: Array<Record<string, string | number | null>>;
  reconciliation: Array<Record<string, string | null>>;
  audit: Array<{
    id: string;
    action: string;
    entityType: string;
    actorUserId: string | null;
    createdAt: string;
    reason: string | null;
  }>;
};

type Member = { userId: string; name: string; role: string; status: string };
type Debtor = {
  studentId: string;
  studentName: string;
  studentIdCode: string;
  outstandingKobo: number;
  openInvoiceCount: number;
};

const STATES: State[] = ['OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'];
const PRIORITIES: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const TRANSITIONS: Record<State, State[]> = {
  OPEN: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED'],
  IN_PROGRESS: ['OPEN', 'ESCALATED', 'RESOLVED'],
  ESCALATED: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export default function CollectionsWorkbench({ canMutate = true }: { canMutate?: boolean }) {
  const [queue, setQueue] = useState<QueueCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [stateFilter, setStateFilter] = useState<'ALL' | State>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | Priority>('ALL');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [eventType, setEventType] = useState<'NOTE' | 'ACTION'>('NOTE');
  const [transitionNote, setTransitionNote] = useState('');
  const [newStudentId, setNewStudentId] = useState('');
  const [newPriority, setNewPriority] = useState<Priority>('NORMAL');
  const [newReason, setNewReason] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const activeMembers = useMemo(
    () => members.filter((member) => member.status === 'ACTIVE'),
    [members],
  );

  const readJson = useCallback(async function readJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? 'Could not load collections data.');
    return data as T;
  }, []);

  const loadQueue = useCallback(
    async function loadQueue() {
      const params = new URLSearchParams();
      if (stateFilter !== 'ALL') params.set('state', stateFilter);
      if (priorityFilter !== 'ALL') params.set('priority', priorityFilter);
      if (includeClosed) params.set('includeClosed', '1');
      params.set('limit', '100');
      const data = await readJson<{ queue: QueueCase[] }>(`/api/collections?${params.toString()}`);
      setQueue(data.queue);
      if (selectedId && !data.queue.some((row) => row.id === selectedId)) {
        setSelectedId(null);
        setDetail(null);
      }
    },
    [includeClosed, priorityFilter, readJson, selectedId, stateFilter],
  );

  async function refreshDetail(id: string) {
    const data = await readJson<Detail>(`/api/collections/${id}`);
    setDetail(data);
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      loadQueue(),
      readJson<{ members: Member[] }>('/api/members')
        .then((data) => {
          if (live) setMembers(data.members);
        })
        .catch(() => undefined),
      readJson<{ students: Debtor[] }>('/api/debtors')
        .then((data) => {
          if (live) setDebtors(data.students);
        })
        .catch(() => undefined),
    ])
      .catch((reason: unknown) => {
        if (live)
          setError(reason instanceof Error ? reason.message : 'Could not load the workbench.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [loadQueue, readJson]);

  async function selectCase(id: string) {
    setSelectedId(id);
    setError(null);
    try {
      await refreshDetail(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load case detail.');
    }
  }

  async function mutate(url: string, body: unknown, method = 'POST') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
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
        throw new Error(data?.error?.message ?? 'The requested change could not be saved.');
      if (selectedId) await refreshDetail(selectedId);
      await loadQueue();
      return data as { case?: QueueCase };
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The requested change could not be saved.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createCase() {
    if (!newStudentId || !newReason.trim()) {
      setError('Choose an outstanding student and enter a reason before opening a case.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/collections', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...csrfHeaders(),
        },
        body: JSON.stringify({
          studentId: newStudentId,
          priority: newPriority,
          reason: newReason.trim(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not open the case.');
      setShowCreate(false);
      setNewReason('');
      setNewStudentId('');
      await loadQueue();
      if (data.case?.id) await selectCase(data.case.id as string);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the case.');
    } finally {
      setBusy(false);
    }
  }

  async function assign(assigneeId: string) {
    if (!detail) return;
    await mutate(`/api/collections/${detail.case.id}/assign`, {
      assigneeId: assigneeId || null,
      expectedVersion: detail.case.version,
    });
  }

  async function addEvent() {
    if (!detail || !note.trim()) return;
    const result = await mutate(`/api/collections/${detail.case.id}/events`, {
      eventType,
      note: note.trim(),
      expectedVersion: detail.case.version,
    });
    if (result) setNote('');
  }

  async function transition(toState: State) {
    if (!detail || !transitionNote.trim()) {
      setError('Add a transition note before changing case state.');
      return;
    }
    const result = await mutate(`/api/collections/${detail.case.id}/transition`, {
      toState,
      note: transitionNote.trim(),
      expectedVersion: detail.case.version,
    });
    if (result) setTransitionNote('');
  }

  const selectedState = detail?.case.state;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p
            className="text-xs font-medium uppercase tracking-[0.14em]"
            style={{ color: 'var(--color-text-faint)' }}
          >
            Accounts receivable control
          </p>
          <h1
            className="mt-1 text-2xl font-semibold tracking-tight"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            Collections Workbench
          </h1>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Coordinate outstanding-obligation follow-up without creating a second ledger. Every
            balance below is read live from the authoritative financial records.
          </p>
        </div>
        {canMutate && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md px-4 py-2 text-sm font-semibold"
            style={{ background: 'var(--color-forest-deep)', color: 'var(--color-ivory)' }}
          >
            Open a case
          </button>
        )}
      </div>

      {error && (
        <div
          className="mb-4 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: 'rgba(185,56,42,.3)',
            background: 'rgba(185,56,42,.07)',
            color: 'var(--color-danger,#a82a1c)',
          }}
        >
          {error}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Open work" value={queue.filter((row) => row.state !== 'CLOSED').length} />
        <Metric
          label="Escalated"
          value={queue.filter((row) => row.state === 'ESCALATED').length}
          tone="gold"
        />
        <Metric
          label="Urgent"
          value={queue.filter((row) => row.priority === 'URGENT').length}
          tone="danger"
        />
        <Metric
          label="Live balance"
          value={formatMoney(queue.reduce((sum, row) => sum + row.outstandingKobo, 0))}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <section
          className="min-w-0 rounded-lg border"
          style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-ivory)' }}
        >
          <div
            className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <div>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                Case queue
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
                {includeClosed ? 'Open and closed operational cases' : 'Active operational cases'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value as 'ALL' | State)}
                className="rounded-md border px-2 py-1.5 text-xs"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  background: 'var(--color-bg-page)',
                }}
              >
                <option value="ALL">All states</option>
                {STATES.map((state) => (
                  <option key={state} value={state}>
                    {labelState(state)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by priority"
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value as 'ALL' | Priority)}
                className="rounded-md border px-2 py-1.5 text-xs"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  background: 'var(--color-bg-page)',
                }}
              >
                <option value="ALL">All priority</option>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {labelPriority(priority)}
                  </option>
                ))}
              </select>
              <label
                className="flex items-center gap-1.5 text-xs"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <input
                  type="checkbox"
                  checked={includeClosed}
                  onChange={(event) => setIncludeClosed(event.target.checked)}
                />{' '}
                closed
              </label>
            </div>
          </div>

          {loading ? (
            <div className="p-10 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>
              Loading queue…
            </div>
          ) : queue.length === 0 ? (
            <div className="p-10 text-center text-sm" style={{ color: 'var(--color-text-faint)' }}>
              No cases match these filters.
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {queue.map((row) => (
                <QueueRowView
                  key={row.id}
                  row={row}
                  selected={selectedId === row.id}
                  onClick={() => void selectCase(row.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section
          className="min-w-0 rounded-lg border"
          style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-ivory)' }}
        >
          {!detail ? (
            <div className="flex min-h-[420px] items-center justify-center p-8 text-center">
              <div>
                <div className="mb-2 text-3xl" aria-hidden>
                  ◎
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  Select a case
                </p>
                <p className="mt-1 max-w-xs text-xs" style={{ color: 'var(--color-text-faint)' }}>
                  Review live obligation, payment, allocation, reconciliation and history context in
                  one place.
                </p>
              </div>
            </div>
          ) : (
            <CaseDetail
              detail={detail}
              canMutate={canMutate}
              activeMembers={activeMembers}
              busy={busy}
              note={note}
              setNote={setNote}
              eventType={eventType}
              setEventType={setEventType}
              transitionNote={transitionNote}
              setTransitionNote={setTransitionNote}
              onAssign={(id) => void assign(id)}
              onAddEvent={() => void addEvent()}
              onTransition={(state) => void transition(state)}
              allowedTransitions={selectedState ? TRANSITIONS[selectedState] : []}
            />
          )}
        </section>
      </div>

      {showCreate && (
        <CreateCaseModal
          debtors={debtors}
          priority={newPriority}
          setPriority={setNewPriority}
          studentId={newStudentId}
          setStudentId={setNewStudentId}
          reason={newReason}
          setReason={setNewReason}
          busy={busy}
          onClose={() => setShowCreate(false)}
          onCreate={() => void createCase()}
        />
      )}
    </div>
  );
}

function QueueRowView({
  row,
  selected,
  onClick,
}: {
  row: QueueCase;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-4 py-3 text-left transition-colors"
      style={{ background: selected ? 'var(--color-forest-tint)' : 'transparent' }}
    >
      <div className="grid gap-2 md:grid-cols-[minmax(150px,1.35fr)_110px_120px_100px_100px] md:items-center md:gap-3">
        <div className="min-w-0">
          <div
            className="truncate text-[13px] font-semibold"
            style={{ color: 'var(--color-forest)' }}
          >
            {row.studentName}
          </div>
          <div className="truncate text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
            {row.studentIdCode} · {row.invoiceNumber ?? 'Student account'} · {row.reason}
          </div>
        </div>
        <div>
          <StatusPill state={row.state} />
          <div className="mt-1 text-[10px]" style={{ color: 'var(--color-text-faint)' }}>
            {row.assignedTo ? 'Assigned' : 'Unassigned'}
          </div>
        </div>
        <div>
          <PriorityPill priority={row.priority} />
          <div className="mt-1 text-[10px]" style={{ color: 'var(--color-text-faint)' }}>
            {row.nextActionAt ? `Next ${formatDate(row.nextActionAt)}` : 'No next action'}
          </div>
        </div>
        <div className="text-right text-xs font-semibold tabular-nums">
          <Money kobo={row.outstandingKobo} size="sm" />
        </div>
        <div className="text-right text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
          {row.openInvoiceCount} open invoice{row.openInvoiceCount === 1 ? '' : 's'}
        </div>
      </div>
    </button>
  );
}

function CaseDetail({
  detail,
  canMutate,
  activeMembers,
  busy,
  note,
  setNote,
  eventType,
  setEventType,
  transitionNote,
  setTransitionNote,
  onAssign,
  onAddEvent,
  onTransition,
  allowedTransitions,
}: {
  detail: Detail;
  canMutate: boolean;
  activeMembers: Member[];
  busy: boolean;
  note: string;
  setNote: (value: string) => void;
  eventType: 'NOTE' | 'ACTION';
  setEventType: (value: 'NOTE' | 'ACTION') => void;
  transitionNote: string;
  setTransitionNote: (value: string) => void;
  onAssign: (id: string) => void;
  onAddEvent: () => void;
  onTransition: (state: State) => void;
  allowedTransitions: State[];
}) {
  const currentAssignee = activeMembers.find((member) => member.userId === detail.case.assignedTo);
  return (
    <div>
      <div className="border-b px-4 py-4" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p
              className="text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--color-text-faint)' }}
            >
              Case control plane
            </p>
            <h2
              className="mt-1 text-lg font-semibold"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
            >
              {detail.case.studentName}
            </h2>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {detail.case.studentIdCode} · opened {formatDate(detail.case.createdAt)}
            </p>
          </div>
          <StatusPill state={detail.case.state} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Live balance" value={formatMoney(detail.case.outstandingKobo)} />
          <Stat label="Invoices" value={String(detail.case.openInvoiceCount)} />
          <Stat label="Priority" value={labelPriority(detail.case.priority)} />
          <Stat label="Version" value={String(detail.case.version)} />
        </div>
        <div
          className="mt-3 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: 'var(--color-gold)',
            background: 'var(--color-gold-tint,#fbf1d1)',
            color: 'var(--color-gold-dark,#8a6b11)',
          }}
        >
          Financial amounts are live reads from invoices, allocations, payments, receipts and
          reversals. This case stores workflow context only.
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <label
            className="mb-1 block text-[11px] font-medium uppercase tracking-wider"
            style={{ color: 'var(--color-text-faint)' }}
          >
            Ownership
          </label>
          <select
            disabled={!canMutate || busy || detail.case.state === 'CLOSED'}
            value={detail.case.assignedTo ?? ''}
            onChange={(event) => onAssign(event.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'var(--color-bg-page)',
            }}
          >
            <option value="">Unassigned</option>
            {activeMembers.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name} · {member.role.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          {currentAssignee && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
              Current owner: {currentAssignee.name}
            </p>
          )}
        </div>

        <div>
          <label
            className="mb-1 block text-[11px] font-medium uppercase tracking-wider"
            style={{ color: 'var(--color-text-faint)' }}
          >
            Add operational note or action
          </label>
          <div className="flex gap-2">
            <select
              disabled={!canMutate || busy || detail.case.state === 'CLOSED'}
              value={eventType}
              onChange={(event) => setEventType(event.target.value as 'NOTE' | 'ACTION')}
              className="rounded-md border px-2 text-xs"
              style={{
                borderColor: 'var(--color-border-subtle)',
                background: 'var(--color-bg-page)',
              }}
            >
              <option value="NOTE">Note</option>
              <option value="ACTION">Action</option>
            </select>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onAddEvent();
              }}
              disabled={!canMutate || busy || detail.case.state === 'CLOSED'}
              placeholder="What happened or what should happen next?"
              className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            />
            <button
              type="button"
              onClick={onAddEvent}
              disabled={!canMutate || busy || detail.case.state === 'CLOSED' || !note.trim()}
              className="rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--color-forest-deep)', color: 'var(--color-ivory)' }}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <label
            className="mb-1 block text-[11px] font-medium uppercase tracking-wider"
            style={{ color: 'var(--color-text-faint)' }}
          >
            State transition
          </label>
          <textarea
            value={transitionNote}
            onChange={(event) => setTransitionNote(event.target.value)}
            disabled={!canMutate || busy || detail.case.state === 'CLOSED'}
            placeholder="Required reason for the transition"
            rows={2}
            className="mb-2 w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          />
          <div className="flex flex-wrap gap-2">
            {allowedTransitions.map((state) => (
              <button
                key={state}
                type="button"
                disabled={!canMutate || busy}
                onClick={() => onTransition(state)}
                className="rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                style={{
                  borderColor:
                    state === 'CLOSED' ? 'var(--color-gold)' : 'var(--color-border-subtle)',
                  color:
                    state === 'CLOSED' ? 'var(--color-gold-dark,#8a6b11)' : 'var(--color-forest)',
                }}
              >
                {state === 'CLOSED' ? 'Close case' : `Move to ${labelState(state)}`}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Authoritative obligation view
          </h3>
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr
                  style={{ background: 'var(--color-bg-page)', color: 'var(--color-text-faint)' }}
                >
                  <th className="px-2 py-2 text-left">Invoice</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {detail.obligations.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-t"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <td className="px-2 py-2">
                      {invoice.invoiceNumber}
                      <div className="text-[10px]" style={{ color: 'var(--color-text-faint)' }}>
                        Due {formatDate(invoice.dueDate)}
                      </div>
                    </td>
                    <td className="px-2 py-2">{invoice.status}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <Money kobo={invoice.outstandingKobo} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Payments &amp; allocations
          </h3>
          {detail.payments.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
              No allocation history is linked to this student yet.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.payments.slice(0, 8).map((payment) => (
                <div
                  key={payment.allocationId}
                  className="rounded-md border px-3 py-2 text-xs"
                  style={{ borderColor: 'var(--color-border-subtle)' }}
                >
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">
                      {payment.paymentNumber} · {payment.invoiceNumber}
                    </span>
                    <Money kobo={payment.allocationAmountKobo} size="sm" />
                  </div>
                  <div className="mt-1" style={{ color: 'var(--color-text-faint)' }}>
                    {payment.paymentStatus} · allocation {payment.allocationStatus} ·{' '}
                    {formatDate(payment.allocatedAt)}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Reconciliation context
          </h3>
          {detail.reconciliation.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
              No linked reconciliation control record.
            </p>
          ) : (
            <div className="space-y-1 text-xs">
              {detail.reconciliation.map((row, index) => (
                <div
                  key={`${String(row.id)}-${index}`}
                  className="flex justify-between rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--color-border-subtle)' }}
                >
                  <span>
                    {String(row.kind)} · {String(row.paymentId).slice(0, 8)}…
                  </span>
                  <span style={{ color: 'var(--color-text-faint)' }}>{String(row.state)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Append-only case history
          </h3>
          {detail.events.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
              No history recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.events.map((event) => (
                <div
                  key={event.id}
                  className="border-l-2 pl-3 text-xs"
                  style={{
                    borderColor:
                      event.eventType === 'STATE_CHANGE' ||
                      event.eventType === 'RESOLVED' ||
                      event.eventType === 'CLOSED' ||
                      event.eventType === 'REOPENED'
                        ? 'var(--color-gold)'
                        : 'var(--color-border-subtle)',
                  }}
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold">{event.eventType.replaceAll('_', ' ')}</span>
                    <span style={{ color: 'var(--color-text-faint)' }}>
                      {formatDate(event.createdAt)}
                    </span>
                  </div>
                  {event.previousState && (
                    <div style={{ color: 'var(--color-text-secondary)' }}>
                      {labelState(event.previousState)} →{' '}
                      {labelState(event.nextState ?? event.previousState)}
                    </div>
                  )}
                  {event.note && (
                    <div
                      className="mt-0.5 whitespace-pre-wrap"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {event.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateCaseModal({
  debtors,
  priority,
  setPriority,
  studentId,
  setStudentId,
  reason,
  setReason,
  busy,
  onClose,
  onCreate,
}: {
  debtors: Debtor[];
  priority: Priority;
  setPriority: (value: Priority) => void;
  studentId: string;
  setStudentId: (value: string) => void;
  reason: string;
  setReason: (value: string) => void;
  busy: boolean;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-case-title"
    >
      <div
        className="w-full max-w-lg rounded-lg border p-5 shadow-xl"
        style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-ivory)' }}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2
              id="create-case-title"
              className="text-lg font-semibold"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
            >
              Open collections case
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Choose a live outstanding account. The case records workflow context, not a balance.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-xl" aria-label="Close">
            ×
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-xs font-medium">
            Student account
            <select
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <option value="">Select an outstanding student</option>
              {debtors.map((debtor) => (
                <option key={debtor.studentId} value={debtor.studentId}>
                  {debtor.studentName} · {formatMoney(debtor.outstandingKobo)} ·{' '}
                  {debtor.openInvoiceCount} open
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium">
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {labelPriority(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium">
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What requires follow-up?"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={busy || !studentId || !reason.trim()}
            className="rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: 'var(--color-forest-deep)', color: 'var(--color-ivory)' }}
          >
            {busy ? 'Opening…' : 'Open case'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'gold' | 'danger';
}) {
  const color =
    tone === 'danger'
      ? 'var(--color-danger,#a82a1c)'
      : tone === 'gold'
        ? 'var(--color-gold-dark,#8a6b11)'
        : 'var(--color-forest-deepest)';
  return (
    <div
      className="rounded-lg border px-3 py-3"
      style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-ivory)' }}
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--color-text-faint)' }}
      >
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md px-2 py-2" style={{ background: 'var(--color-bg-page)' }}>
      <div className="text-[10px]" style={{ color: 'var(--color-text-faint)' }}>
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-xs font-semibold tabular-nums"
        style={{ color: 'var(--color-text-primary)' }}
      >
        {value}
      </div>
    </div>
  );
}
function StatusPill({ state }: { state: State }) {
  const styles: Record<State, { background: string; color: string }> = {
    OPEN: { background: 'rgba(59,91,70,.1)', color: 'var(--color-forest)' },
    IN_PROGRESS: { background: 'rgba(64,103,133,.1)', color: '#35627f' },
    ESCALATED: { background: 'rgba(194,146,45,.15)', color: 'var(--color-gold-dark,#8a6b11)' },
    RESOLVED: { background: 'rgba(47,126,88,.12)', color: '#2f7e58' },
    CLOSED: { background: 'rgba(100,100,100,.1)', color: 'var(--color-text-secondary)' },
  };
  const style = styles[state];
  return (
    <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold" style={style}>
      {labelState(state)}
    </span>
  );
}
function PriorityPill({ priority }: { priority: Priority }) {
  return (
    <span
      className="text-[10px] font-medium"
      style={{
        color:
          priority === 'URGENT'
            ? 'var(--color-danger,#a82a1c)'
            : priority === 'HIGH'
              ? 'var(--color-gold-dark,#8a6b11)'
              : 'var(--color-text-secondary)',
      }}
    >
      ● {labelPriority(priority)}
    </span>
  );
}
function labelState(state: State | null) {
  return state
    ? state
        .replaceAll('_', ' ')
        .toLowerCase()
        .replace(/(^| )\S/g, (letter) => letter.toUpperCase())
    : '—';
}
function labelPriority(priority: Priority) {
  return priority.charAt(0) + priority.slice(1).toLowerCase();
}
function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatMoney(kobo: number) {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
