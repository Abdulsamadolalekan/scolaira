'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { csrfHeaders } from '@/lib/ui/csrf';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Money } from '@/components/ui/money';

 type Fee = {
  id: string; code: string; name: string; description: string | null;
  defaultAmountKobo: number; isActive: boolean;
};
 type Term = { id: string; name: string; label: string; status: string; billed: boolean; isCurrent: boolean };
 type Klass = { id: string; label: string };
 type Assignment = {
  id: string; feeDefinitionId: string; feeCode?: string; feeName?: string;
  classId: string | null; className?: string | null; amountKobo: number;
  adjustmentKobo: number; dueDate: string | null; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
 };
 type Draft = {
  feeDefinitionId: string; classId: string | null; amountKobo: number;
  adjustmentKobo: number; status: 'DRAFT' | 'ACTIVE';
 };

const fmt = (k: number) => `₦${(k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function FeeSetup() {
  const [fees, setFees] = useState<Fee[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [termId, setTermId] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newFee, setNewFee] = useState({ code: '', name: '', amount: '' });

  const selectedTerm = terms.find((term) => term.id === termId);
  const activeFees = useMemo(() => fees.filter((fee) => fee.isActive), [fees]);

  const getJson = useCallback(async (path: string) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? 'Could not load fee setup.');
    return data;
  }, []);

  const loadAssignments = useCallback(async (nextTermId: string) => {
    if (!nextTermId) return;
    try {
      const data = await getJson(`/api/terms/${nextTermId}/fee-assignments`);
      const rows = (data.assignments ?? []) as Assignment[];
      setAssignments(rows);
      setDrafts(rows.filter((row) => row.status !== 'ARCHIVED').map((row) => ({
        feeDefinitionId: row.feeDefinitionId,
        classId: row.classId,
        amountKobo: row.amountKobo,
        adjustmentKobo: row.adjustmentKobo,
        status: row.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
      })));
    } catch (e) { setError((e as Error).message); }
  }, [getJson]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJson('/api/fee-definitions'), getJson('/api/terms'), getJson('/api/classes')])
      .then(([feeData, termData, classData]) => {
        if (cancelled) return;
        const nextFees = (feeData.feeDefinitions ?? []) as Fee[];
        const nextTerms = (termData.terms ?? []) as Term[];
        setFees(nextFees); setTerms(nextTerms); setClasses((classData.classes ?? []) as Klass[]);
        const current = nextTerms.find((term) => term.isCurrent) ?? nextTerms[0];
        if (current) setTermId(current.id);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [getJson]);

  useEffect(() => { if (termId) void loadAssignments(termId); }, [loadAssignments, termId]);

  async function createFee(e: React.FormEvent) {
    e.preventDefault(); setError(null); setNotice(null);
    const amount = Number(newFee.amount);
    if (!newFee.code.trim() || !newFee.name.trim() || !Number.isSafeInteger(amount) || amount <= 0) {
      setError('Enter a fee code, name, and a positive amount in kobo.'); return;
    }
    try {
      const response = await fetch('/api/fee-definitions', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ code: newFee.code, name: newFee.name, defaultAmountKobo: amount * 100 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not create fee.');
      setFees((current) => [...current, data.feeDefinition]);
      setNewFee({ code: '', name: '', amount: '' });
      setNotice('Fee definition saved.');
    } catch (e) { setError((e as Error).message); }
  }

  function addAssignment() {
    const fee = activeFees[0];
    if (!fee) { setError('Create at least one active fee definition first.'); return; }
    setDrafts((current) => [...current, {
      feeDefinitionId: fee.id, classId: null, amountKobo: fee.defaultAmountKobo,
      adjustmentKobo: 0, status: 'ACTIVE',
    }]);
  }

  function updateDraft(index: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function removeDraft(index: number) { setDrafts((current) => current.filter((_, rowIndex) => rowIndex !== index)); }

  async function saveAssignments() {
    if (!termId) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/terms/${termId}/fee-assignments`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ assignments: drafts.map((row) => ({ ...row, amountKobo: Number(row.amountKobo), adjustmentKobo: Number(row.adjustmentKobo) })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not save fee assignments.');
      setAssignments(data.assignments ?? []);
      setNotice('Term fee structure saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="py-12 text-sm" style={{ color: 'var(--color-text-secondary)' }}>Loading fee structure…</div>;

  return (
    <div className="space-y-4">
      {error && <Alert variant="danger" title="Could not complete that action">{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}

      <Card>
        <CardHeader title="Reusable fee definitions" description="Name the fees your school charges. The default is copied into a term assignment and remains auditable there." />
        <form onSubmit={createFee} className="grid gap-3 border-b p-4 sm:grid-cols-[120px_1fr_160px_auto]" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <label className="text-xs"><span className="mb-1 block font-medium">Code</span><input value={newFee.code} onChange={(e) => setNewFee({ ...newFee, code: e.target.value })} placeholder="TUITION" className="h-9 w-full rounded border px-2 text-sm" /></label>
          <label className="text-xs"><span className="mb-1 block font-medium">Name</span><input value={newFee.name} onChange={(e) => setNewFee({ ...newFee, name: e.target.value })} placeholder="Tuition" className="h-9 w-full rounded border px-2 text-sm" /></label>
          <label className="text-xs"><span className="mb-1 block font-medium">Default amount (₦)</span><input value={newFee.amount} onChange={(e) => setNewFee({ ...newFee, amount: e.target.value })} inputMode="numeric" placeholder="150000" className="h-9 w-full rounded border px-2 text-sm" /></label>
          <Button type="submit" size="sm" className="self-end">Add fee</Button>
        </form>
        {fees.length === 0 ? <p className="p-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>No fees defined yet.</p> : (
          <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {fees.map((fee) => <div key={fee.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div><div className="text-sm font-medium">{fee.name} <span className="ml-1 text-[11px] uppercase" style={{ color: 'var(--color-text-faint)' }}>{fee.code}</span></div><div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{fee.isActive ? 'Active for new term assignments' : 'Archived'} · default {fmt(fee.defaultAmountKobo)}</div></div>
              <span className="text-sm font-semibold tabular-nums"><Money kobo={fee.defaultAmountKobo} /></span>
            </div>)}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Term fee structure" description="Assign each fee school-wide or to a class. A class-specific fee overrides the school-wide fee with the same code." actions={
          <select value={termId} onChange={(e) => setTermId(e.target.value)} className="h-9 rounded border bg-white px-2 text-sm" aria-label="Select term">
            <option value="">Select term</option>{terms.map((term) => <option key={term.id} value={term.id}>{term.name} · {term.status}{term.billed ? ' · Billed' : ''}</option>)}
          </select>
        } />
        {!selectedTerm ? <p className="p-5 text-sm" style={{ color: 'var(--color-text-secondary)' }}>Select a term to configure its fees.</p> : (
          <>
            {selectedTerm.billed && <div className="mx-4 mt-4 rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-gold)', backgroundColor: 'var(--color-gold-tint)', color: 'var(--color-gold-dark)' }}>This term is BILLED. Its fee structure is locked; new enrolments can be topped up from the billing preview.</div>}
            <div className="overflow-x-auto p-4">
              <table className="min-w-[680px] w-full text-sm"><thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-faint)' }}><th className="pb-2">Fee</th><th className="pb-2">Scope</th><th className="pb-2">Amount (₦)</th><th className="pb-2">Adjustment (₦)</th><th className="pb-2 w-8" /></tr></thead><tbody className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
                {drafts.map((row, index) => { return <tr key={`${row.feeDefinitionId}-${row.classId ?? 'org'}-${index}`}>
                  <td className="py-2 pr-2"><select disabled={selectedTerm.billed} value={row.feeDefinitionId} onChange={(e) => { const next = fees.find((feeItem) => feeItem.id === e.target.value); updateDraft(index, { feeDefinitionId: e.target.value, amountKobo: next?.defaultAmountKobo ?? row.amountKobo }); }} className="h-9 w-full rounded border bg-white px-2 text-sm"><option value="">Select fee</option>{activeFees.map((feeItem) => <option key={feeItem.id} value={feeItem.id}>{feeItem.code} · {feeItem.name}</option>)}</select></td>
                  <td className="py-2 pr-2"><select disabled={selectedTerm.billed} value={row.classId ?? ''} onChange={(e) => updateDraft(index, { classId: e.target.value || null })} className="h-9 w-full rounded border bg-white px-2 text-sm"><option value="">School-wide</option>{classes.map((klass) => <option key={klass.id} value={klass.id}>{klass.label}</option>)}</select></td>
                  <td className="py-2 pr-2"><input disabled={selectedTerm.billed} value={Math.round(row.amountKobo / 100)} onChange={(e) => updateDraft(index, { amountKobo: Number(e.target.value || 0) * 100 })} inputMode="numeric" className="h-9 w-28 rounded border px-2 text-sm" /></td>
                  <td className="py-2 pr-2"><input disabled={selectedTerm.billed} value={Math.round(row.adjustmentKobo / 100)} onChange={(e) => updateDraft(index, { adjustmentKobo: Number(e.target.value || 0) * 100 })} inputMode="numeric" className="h-9 w-28 rounded border px-2 text-sm" /></td>
                  <td className="py-2 text-right"><button disabled={selectedTerm.billed} type="button" onClick={() => removeDraft(index)} className="text-xs" style={{ color: 'var(--color-danger,#a82a1c)' }}>Remove</button></td>
                </tr>; })}
              </tbody></table>
              {drafts.length === 0 && <p className="py-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>No assignments yet. Add the first fee below.</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <button type="button" disabled={selectedTerm.billed} onClick={addAssignment} className="text-sm font-medium" style={{ color: 'var(--color-forest)' }}>+ Add assignment</button>
              <div className="flex gap-2"><Link href={`/terms/${termId}/bill`} className="inline-flex h-8 items-center rounded border px-3 text-sm" style={{ color: 'var(--color-forest)', borderColor: 'var(--color-border)' }}>Review billing</Link><Button size="sm" disabled={selectedTerm.billed || saving} loading={saving} onClick={saveAssignments}>Save structure</Button></div>
            </div>
          </>
        )}
      </Card>

      {selectedTerm && assignments.length > 0 && <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>{assignments.length} assignment{assignments.length === 1 ? '' : 's'} are currently stored for {selectedTerm.name}. Review the bill run before issuing obligations.</p>}
    </div>
  );
}
