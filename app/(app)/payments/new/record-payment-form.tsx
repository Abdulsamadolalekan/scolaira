'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';

const inputStyle: React.CSSProperties = { border:'1px solid var(--color-border)', backgroundColor:'var(--color-bg-page)', color:'var(--color-text-primary)', borderRadius:8, padding:'8px 12px', fontSize:14, width:'100%', outline:'none' };

type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };
type InvoiceOpt = { id: string; invoiceNumber: string; studentId: string; studentName: string; totalKobo: number; paidKobo: number; remainingKobo: number; status: string; };

function parseNaira(s: string): number {
  const clean = s.replace(/[^0-9.]/g,'');
  const n = Number(clean);
  if (!clean || Number.isNaN(n)) return 0;
  return Math.round(n*100);
}
function fmtK(k:number){return `₦${(k/100).toLocaleString('en-NG',{minimumFractionDigits:0})}`;}

export default function RecordPaymentForm({ students, invoices, presetStudentId }: { students: StudentOpt[]; invoices: InvoiceOpt[]; presetStudentId?: string }) {
  const router = useRouter();
  const [studentId, setStudentId] = useState(presetStudentId ?? '');
  const [method, setMethod] = useState<'CASH'|'BANK_TRANSFER'|'POS'|'ONLINE'|'OTHER'>('BANK_TRANSFER');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0,10));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string|null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const studentInvoices = useMemo(
    () => invoices.filter(i => i.studentId === studentId).sort((a,b)=>a.invoiceNumber.localeCompare(b.invoiceNumber)),
    [invoices, studentId],
  );
  useEffect(() => {
    if (studentId && !studentInvoices.find(i => i.id === selectedInvoiceId)) {
      setSelectedInvoiceId(studentInvoices[0]?.id ?? '');
    }
  }, [studentId, studentInvoices, selectedInvoiceId]);

  const amountKobo = parseNaira(amount);
  const selected = studentInvoices.find(i=>i.id===selectedInvoiceId);
  const alloc = selected ? Math.min(amountKobo, selected.remainingKobo) : 0;
  const unallocated = amountKobo - alloc;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      if (amountKobo <= 0) { setError('Amount must be greater than zero.'); setLoading(false); return; }
      const body: any = {
        method, amountKobo, currency: 'NGN',
        paidAt: paidAt ? new Date(paidAt).toISOString() : new Date().toISOString(),
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        allocations: selected ? [{ invoiceId: selected.id, amountKobo: alloc }] : [],
      };
      const res = await fetch('/api/payments', {
        method:'POST', headers:{'content-type':'application/json', ...csrfHeaders()}, credentials:'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not record payment.'); setLoading(false); return; }
      router.push(`/payments/${data.payment.id}`);
      router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" style={{backgroundColor:'var(--color-bg-panel)',border:'1px solid var(--color-border-subtle)',borderRadius:12,padding:24}}>
      {error && <div className="rounded-lg px-3 py-2 text-sm" style={{backgroundColor:'rgba(185,56,42,.08)',color:'var(--color-danger)',border:'1px solid rgba(185,56,42,.25)'}}>{error}</div>}
      <Field label="Student">
        <select required value={studentId} onChange={e=>setStudentId(e.target.value)} style={inputStyle}>
          <option value="">Select student…</option>
          {students.map(s => <option key={s.id} value={s.id}>{s.name} — {s.studentId}{s.outstandingKobo>0?` (${fmtK(s.outstandingKobo)} outstanding)`:' (clear)'}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <select value={method} onChange={e=>setMethod(e.target.value as any)} style={inputStyle}>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CASH">Cash</option>
            <option value="POS">POS</option>
            <option value="ONLINE">Online / Paystack</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
        <Field label="Date paid"><input type="date" value={paidAt} onChange={e=>setPaidAt(e.target.value)} style={inputStyle} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (₦)"><input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} style={inputStyle} placeholder="150000" /></Field>
        <Field label="Reference / Teller no"><input value={reference} onChange={e=>setReference(e.target.value)} style={inputStyle} placeholder="Optional" /></Field>
      </div>
      <Field label="Apply to invoice">
        <select value={selectedInvoiceId} onChange={e=>setSelectedInvoiceId(e.target.value)} style={inputStyle} disabled={!studentId}>
          {studentInvoices.length === 0 && <option value="">(no open invoices — payment held as unallocated)</option>}
          {studentInvoices.map(i => <option key={i.id} value={i.id}>{i.invoiceNumber} — {fmtK(i.remainingKobo)} remaining</option>)}
        </select>
      </Field>
      {amountKobo > 0 && (
        <div className="rounded-lg p-3 text-[13px]" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid var(--color-border-subtle)'}}>
          <Row label="Total received" value={fmtK(amountKobo)} />
          <Row label={selected?`Applied to ${selected.invoiceNumber}`:'Applied'} value={selected?fmtK(alloc):'—'} tone={alloc>0?'pos':undefined} />
          <Row label="Unallocated credit" value={unallocated>0?fmtK(unallocated):'—'} tone={unallocated>0?'warn':undefined} />
        </div>
      )}
      <Field label="Notes (optional)"><textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2} style={{...inputStyle,resize:'vertical'}} /></Field>
      <div className="pt-2 flex gap-2 justify-end">
        <button type="button" onClick={()=>router.back()} className="rounded-md px-3 py-2 text-[13px] font-medium" style={{color:'var(--color-text-secondary)'}}>Cancel</button>
        <button type="submit" disabled={loading} className="rounded-md bg-[color:var(--color-forest)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] disabled:opacity-50">
          {loading ? 'Recording…' : 'Record payment'}
        </button>
      </div>
    </form>
  );
}

function Row({ label, value, tone }: { label:string; value:React.ReactNode; tone?:'pos'|'warn' }) {
  const color = tone==='pos'?'var(--color-forest-deep)':tone==='warn'?'var(--color-gold-dark,#8a6b11)':'var(--color-text-secondary)';
  return <div className="flex justify-between py-0.5"><span style={{color:'var(--color-text-secondary)'}}>{label}</span><span className="font-medium tabular-nums" style={{color}}>{value}</span></div>;
}
function Field({ label, children }: { label:string; children:React.ReactNode }) {
  return <label className="block"><span className="block text-sm font-medium mb-1">{label}</span>{children}</label>;
}
