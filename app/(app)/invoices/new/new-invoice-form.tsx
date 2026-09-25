'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';

const inputStyle: React.CSSProperties = { border:'1px solid var(--color-border)', backgroundColor:'var(--color-bg-page)', color:'var(--color-text-primary)', borderRadius:8, padding:'8px 12px', fontSize:14, width:'100%', outline:'none' };

type TermOpt = { id: string; name: string; label: string; isCurrent: boolean };
type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };

function parseNaira(s: string): number {
  const clean = s.replace(/[^0-9.]/g, '');
  const n = Number(clean);
  if (!clean || Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}
function formatNaira(k: number): string { return (k/100).toFixed(k%100===0?0:2); }

export default function NewInvoiceForm({ terms, students, presetStudentId }: { terms: TermOpt[]; students: StudentOpt[]; presetStudentId?: string }) {
  const router = useRouter();
  const currentTerm = terms.find(t => t.isCurrent) ?? terms[0];
  const [studentId, setStudentId] = useState(presetStudentId ?? students[0]?.id ?? '');
  const [termId, setTermId] = useState(currentTerm?.id ?? '');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string|null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const unitRateKobo = parseNaira(amount);
      if (unitRateKobo <= 0) { setError('Amount must be greater than zero.'); setLoading(false); return; }
      const body: any = {
        studentId, termId: termId || undefined,
        lines: [{ description: description.trim() || 'Fee', quantity: 1, unitRateKobo }],
      };
      if (dueDate) body.dueDate = dueDate;
      if (notes.trim()) body.memo = notes.trim();
      const res = await fetch('/api/invoices', {
        method:'POST', headers:{'content-type':'application/json', ...csrfHeaders()}, credentials:'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not create invoice.'); setLoading(false); return; }
      router.push(`/invoices/${data.invoice.id}`);
      router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  const amountKobo = parseNaira(amount);

  return (
    <form onSubmit={onSubmit} className="space-y-4" style={{backgroundColor:'var(--color-bg-panel)',border:'1px solid var(--color-border-subtle)',borderRadius:12,padding:24}}>
      {error && <div className="rounded-lg px-3 py-2 text-sm" style={{backgroundColor:'rgba(185,56,42,.08)',color:'var(--color-danger)',border:'1px solid rgba(185,56,42,.25)'}}>{error}</div>}
      <Field label="Student">
        <select required value={studentId} onChange={e=>setStudentId(e.target.value)} style={inputStyle}>
          <option value="">Select student…</option>
          {students.map(s => <option key={s.id} value={s.id}>{s.name} — {s.studentId}{s.outstandingKobo>0?` (₦${formatNaira(s.outstandingKobo)} outstanding)`:''}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Term">
          <select value={termId} onChange={e=>setTermId(e.target.value)} style={inputStyle}>
            {terms.length === 0 && <option value="">(no terms — seed first)</option>}
            {terms.map(t => <option key={t.id} value={t.id}>{t.name} ({t.label}){t.isCurrent?' — current':''}</option>)}
          </select>
        </Field>
        <Field label="Due date"><input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} style={inputStyle} /></Field>
      </div>
      <Field label="Description"><input required value={description} onChange={e=>setDescription(e.target.value)} style={inputStyle} placeholder="e.g. First Term Tuition" /></Field>
      <Field label="Amount (₦)">
        <input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} style={inputStyle} placeholder="150000" />
        {amountKobo > 0 && <div className="text-[11px] mt-1 tabular-nums" style={{color:'var(--color-text-faint)'}}>Total: ₦{formatNaira(amountKobo)}</div>}
      </Field>
      <Field label="Notes (optional)"><textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2} style={{...inputStyle,resize:'vertical'}} /></Field>
      <div className="pt-2 flex gap-2 justify-end">
        <button type="button" onClick={()=>router.back()} className="rounded-md px-3 py-2 text-[13px] font-medium" style={{color:'var(--color-text-secondary)'}}>Cancel</button>
        <button type="submit" disabled={loading} className="rounded-md bg-[color:var(--color-forest)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] disabled:opacity-50">
          {loading ? 'Issuing…' : 'Issue invoice'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label:string; hint?:string; children:React.ReactNode }) {
  return <label className="block"><span className="block text-sm font-medium mb-1">{label}</span>{children}{hint && <span className="block text-[11px] mt-1" style={{color:'var(--color-text-faint)'}}>{hint}</span>}</label>;
}
