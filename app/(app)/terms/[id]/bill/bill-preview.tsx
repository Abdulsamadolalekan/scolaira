'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { csrfHeaders } from '@/lib/ui/csrf';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Money } from '@/components/ui/money';

type Line = {
  feeAssignmentId: string; feeCode: string; feeName: string; classScope: string | null;
  dueDate: string | null; grossKobo: number; existingLineId: string | null; existingInvoiceNumber: string | null;
  existingInvoiceStatus: string | null; existingAmountKobo: number | null;
  covered: boolean; blocked: boolean;
};
type Student = { studentId: string; studentCode: string; studentName: string; className: string; lines: Line[]; status: string; grossKobo: number; billedKobo: number; toIssueKobo: number };
type Preview = {
  term: { id: string; name: string; label: string; status: string; billed: boolean; dueDate: string | null };
  students: Student[]; activeEnrollmentCount: number; billableKeyCount: number; coveredKeyCount: number;
  missingKeyCount: number; blockedKeyCount: number; activeAssignmentCount: number; grossKobo: number;
  billedKobo: number; toIssueKobo: number; incompleteStudentIds: string[]; blockedStudentIds: string[]; ready: boolean;
};
type Override = { studentId: string; feeAssignmentId: string; amountKobo: number; reason: string; note?: string | null };

const reasons = ['SCHOLARSHIP', 'SIBLING_DISCOUNT', 'STAFF_CHILD', 'EARLY_PAYMENT', 'OTHER'];
const naira = (kobo: number) => (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BillPreview({ termId, canBill }: { termId: string; canBill: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/terms/${termId}/bill-preview`, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not load billing preview.');
      setPreview(data.preview);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [termId]);

  const overrideRows = useMemo(() => Object.values(overrides), [overrides]);
  const waiverTotal = overrideRows.reduce((sum, row) => sum + row.amountKobo, 0);
  const issueTotal = Math.max(0, (preview?.toIssueKobo ?? 0) - waiverTotal);

  function setOverride(student: Student, line: Line, patch: Partial<Override>) {
    const key = `${student.studentId}:${line.feeAssignmentId}`;
    const existing = overrides[key] ?? { studentId: student.studentId, feeAssignmentId: line.feeAssignmentId, amountKobo: 0, reason: 'OTHER', note: null };
    const next = { ...existing, ...patch };
    if (!next.amountKobo) {
      setOverrides((current) => { const copy = { ...current }; delete copy[key]; return copy; });
    } else setOverrides((current) => ({ ...current, [key]: next }));
  }

  async function issue() {
    if (!preview || !canBill || !preview.ready || preview.term.status === 'CLOSED' || preview.term.status === 'PLANNED') return;
    if (!window.confirm(`Issue ${preview.missingKeyCount} fee line${preview.missingKeyCount === 1 ? '' : 's'} for ${preview.activeEnrollmentCount} enrolled student${preview.activeEnrollmentCount === 1 ? '' : 's'}? This creates ordinary invoices.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/terms/${termId}/bill`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), ...csrfHeaders() },
        body: JSON.stringify({ overrides: overrideRows }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Billing could not be completed.');
      setNotice(`${data.bill.createdInvoices} invoice${data.bill.createdInvoices === 1 ? '' : 's'} issued. The term is now ${data.bill.term.status}.`);
      setOverrides({});
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="py-12 text-sm" style={{ color: 'var(--color-text-secondary)' }}>Computing the controlled billing preview…</div>;
  if (!preview) return <Alert variant="danger" title="Preview unavailable">{error ?? 'The term could not be loaded.'}</Alert>;

  const hasExceptions = preview.incompleteStudentIds.length > 0 || preview.blockedStudentIds.length > 0;
  return (
    <div className="space-y-4">
      {error && <Alert variant="danger" title="Billing is not complete">{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Metric label="Enrolled" value={String(preview.activeEnrollmentCount)} hint="active students" />
        <Metric label="Fee keys" value={String(preview.billableKeyCount)} hint={`${preview.coveredKeyCount} already covered`} />
        <Metric label="Term value" value={<Money kobo={preview.grossKobo} compact />} hint="before concessions" />
        <Metric label="To issue" value={<Money kobo={issueTotal} compact />} hint={waiverTotal ? `${naira(waiverTotal)} concession` : 'this operation'} />
        <Metric label="Status" value={preview.term.status} hint={preview.term.billed ? 'top-up mode' : 'not yet billed'} />
      </div>

      {preview.term.status === 'PLANNED' && <Alert variant="warning" title="Term is planned">Activate the term before issuing obligations. You can still use this screen to inspect the configured population.</Alert>}
      {preview.term.status === 'CLOSED' && <Alert variant="danger" title="Term is closed">Closed terms cannot be billed.</Alert>}
      {preview.term.billed && <Alert variant="info" title="Top-up mode">This term is already BILLED. A retry will create invoices only for newly enrolled students or uncovered fee keys.</Alert>}
      {preview.activeEnrollmentCount === 0 && <Alert variant="warning" title="No active enrolments">There is no cohort to bill. The term will remain unbilled.</Alert>}
      {preview.activeAssignmentCount === 0 && preview.activeEnrollmentCount > 0 && <Alert variant="warning" title="No active fees">Assign at least one active fee before issuing.</Alert>}
      {hasExceptions && <Alert variant="danger" title="Resolve exceptions before issuing">{preview.incompleteStudentIds.length > 0 ? `${preview.incompleteStudentIds.length} student${preview.incompleteStudentIds.length === 1 ? '' : 's'} have no applicable fee. ` : ''}{preview.blockedStudentIds.length > 0 ? `${preview.blockedStudentIds.length} student${preview.blockedStudentIds.length === 1 ? '' : 's'} have a draft or voided line that cannot be silently replaced.` : ''}</Alert>}

      <Card>
        <CardHeader title="Review every obligation" description="The server recomputes this snapshot during Issue. Concessions are attached to draft invoice lines and become immutable when issued." actions={<Link href="/settings/fees" className="text-sm font-medium" style={{ color: 'var(--color-forest)' }}>Edit fee structure</Link>} />
        <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {preview.students.map((student) => <StudentCard key={student.studentId} student={student} overrides={overrides} setOverride={setOverride} />)}
          {preview.students.length === 0 && <p className="p-6 text-sm" style={{ color: 'var(--color-text-secondary)' }}>No active enrolments found.</p>}
        </div>
      </Card>

      <div className="sticky bottom-2 rounded-lg border bg-white/95 p-3 shadow-lg backdrop-blur sm:flex sm:items-center sm:justify-between" style={{ borderColor: 'var(--color-border)' }}>
        <div><div className="text-sm font-semibold">Review → confirm → issue</div><div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{preview.missingKeyCount} new fee line{preview.missingKeyCount === 1 ? '' : 's'} · {fmtKobo(issueTotal)} after concessions</div></div>
        {canBill ? <Button loading={busy} disabled={busy || !preview.ready || hasExceptions || preview.term.status === 'PLANNED' || preview.term.status === 'CLOSED' || preview.missingKeyCount === 0} onClick={issue}>Issue term billing</Button> : <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>Only an OWNER or FINANCE_OFFICER can issue term billing.</span>}
      </div>
    </div>
  );
}

function StudentCard({ student, overrides, setOverride }: { student: Student; overrides: Record<string, Override>; setOverride: (student: Student, line: Line, patch: Partial<Override>) => void }) {
  const tone = student.status === 'BILLED' ? 'var(--color-forest-deep)' : student.status === 'BLOCKED' || student.status === 'INCOMPLETE' ? 'var(--color-danger,#a82a1c)' : 'var(--color-gold-dark,#8a6b11)';
  return <div className="p-4 sm:p-5">
    <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between"><div><div className="text-sm font-semibold">{student.studentName} <span className="ml-1 text-xs font-normal tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{student.studentCode}</span></div><div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{student.className}</div></div><div className="text-right"><div className="text-xs font-semibold" style={{ color: tone }}>{student.status === 'BILLED' ? 'Covered' : student.status === 'PENDING' ? 'Ready to issue' : student.status}</div><div className="text-sm font-semibold tabular-nums">{fmtKobo(student.billedKobo + student.toIssueKobo)}</div></div></div>
    <div className="space-y-2">
      {student.lines.map((line) => { const key = `${student.studentId}:${line.feeAssignmentId}`; const override = overrides[key]; return <div key={line.feeAssignmentId} className="rounded border p-3" style={{ borderColor: line.blocked ? 'rgba(185,56,42,.35)' : 'var(--color-border-subtle)', backgroundColor: line.covered ? 'var(--color-bg-page)' : 'white' }}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">{line.feeCode} · {line.feeName}</div><div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{line.classScope ? `Class: ${line.classScope}` : 'School-wide'}{line.dueDate ? ` · Due ${line.dueDate}` : ''}{line.existingInvoiceNumber ? ` · ${line.existingInvoiceNumber} · ${line.existingInvoiceStatus}` : ''}</div></div><div className="text-sm font-semibold tabular-nums">{fmtKobo(line.existingAmountKobo ?? line.grossKobo)}</div></div>
        {!line.covered && !line.blocked && <div className="mt-3 grid gap-2 sm:grid-cols-[150px_180px_1fr]"><label className="text-xs"><span className="mb-1 block" style={{ color: 'var(--color-text-secondary)' }}>Concession (₦)</span><input value={override ? String(override.amountKobo / 100) : ''} onChange={(e) => setOverride(student, line, { amountKobo: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) })} inputMode="decimal" placeholder="0" className="h-9 w-full rounded border px-2 text-sm" /></label><label className="text-xs"><span className="mb-1 block" style={{ color: 'var(--color-text-secondary)' }}>Reason</span><select value={override?.reason ?? 'OTHER'} onChange={(e) => setOverride(student, line, { reason: e.target.value })} className="h-9 w-full rounded border bg-white px-2 text-sm">{reasons.map((reason) => <option key={reason}>{reason}</option>)}</select></label><label className="text-xs"><span className="mb-1 block" style={{ color: 'var(--color-text-secondary)' }}>Note (optional)</span><input value={override?.note ?? ''} onChange={(e) => setOverride(student, line, { note: e.target.value })} placeholder="Approval note" className="h-9 w-full rounded border px-2 text-sm" /></label></div>}
        {override && <div className="mt-2 text-xs" style={{ color: 'var(--color-gold-dark,#8a6b11)' }}>Concession recorded at issue: {fmtKobo(override.amountKobo)} · {override.reason}</div>}
      </div>; })}
    </div>
  </div>;
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) { return <div className="rounded-md border p-3" style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}><div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}>{label}</div><div className="mt-1 truncate text-[15px] font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>{value}</div><div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--color-text-faint)' }}>{hint}</div></div>; }
function fmtKobo(kobo: number) { return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
