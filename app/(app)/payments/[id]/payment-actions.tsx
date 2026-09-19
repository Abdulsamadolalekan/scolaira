'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { csrfHeaders } from '@/lib/ui/csrf';

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-bg-page)',
  color: 'var(--color-text-primary)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 14,
  width: '100%',
  outline: 'none',
};
const btnBase: React.CSSProperties = {
  borderRadius: 6,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  border: '1px solid transparent',
};

type InvoiceOpt = { id: string; invoiceNumber: string; studentName: string; remainingKobo: number; totalKobo: number; paidKobo: number; status: string };

function parseKobo(s: string): number {
  const clean = s.replace(/[^0-9.]/g, '');
  const n = Number(clean);
  if (!clean || Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}
function fmtN(k: number) { return `₦${(k/100).toLocaleString('en-NG',{minimumFractionDigits:0})}`; }

export default function PaymentActions({ paymentId, status, unallocatedKobo }: { paymentId: string; status: string; unallocatedKobo: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string|null>(null);
  const [flash, setFlash] = useState<string|null>(null);
  const [showAllocate, setShowAllocate] = useState(false);
  const [showReverse, setShowReverse] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceOpt[]>([]);

  // Load open invoices when the allocate panel opens.
  useEffect(() => {
    if (!showAllocate || invoices.length) return;
    fetch('/api/invoices', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        const open = (d.invoices ?? []).filter((i: any) => i.remainingKobo > 0 && i.status !== 'VOID' && i.status !== 'DRAFT');
        setInvoices(open);
      })
      .catch(() => setError('Could not load open invoices.'));
  }, [showAllocate, invoices.length]);

  async function post(path: string, body: any, label: string) {
    setBusy(label); setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'content-type':'application/json', ...csrfHeaders() },
        credentials: 'same-origin', body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error?.message ?? `Could not ${label.toLowerCase()}.`); setBusy(null); return; }
      setFlash(`${label} succeeded.`);
      setShowAllocate(false); setShowReverse(false);
      router.refresh();
      setTimeout(()=>{ setFlash(null); }, 2500);
    } catch { setError('Network error.'); setBusy(null); }
  }

  if (status === 'REVERSED' || status === 'FAILED' || status === 'REJECTED') return null;

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      {status === 'PENDING' && (
        <PrimaryBtn onClick={()=>post(`/api/payments/${paymentId}/confirm`, {}, 'Confirm')} loading={busy==='Confirm'}>
          Confirm payment
        </PrimaryBtn>
      )}
      {status === 'CONFIRMED' && unallocatedKobo > 0 && (
        <PrimaryBtn onClick={()=>setShowAllocate(v=>!v)} loading={false}>
          {showAllocate ? 'Cancel' : 'Allocate to invoices'}
        </PrimaryBtn>
      )}
      {status !== 'PENDING' && (
        <button type="button" onClick={()=>setShowReverse(v=>!v)} disabled={busy!==null} style={{
          ...btnBase, backgroundColor: 'transparent', borderColor: 'var(--color-border)', color: 'var(--color-danger,#a82a1c)',
        }}>Reverse</button>
      )}
      {status === 'CONFIRMED' && (
        <Link href={`/payments/${paymentId}/receipt`}
              className="inline-flex items-center rounded-md border px-3 py-2 text-[13px] font-medium"
              style={{ borderColor:'var(--color-border)', color:'var(--color-text-primary)' }}>
          Print receipt
        </Link>
      )}
      {error && <div className="w-full rounded-md px-3 py-2 text-sm" style={{backgroundColor:'rgba(185,56,42,.08)',color:'var(--color-danger)',border:'1px solid rgba(185,56,42,.25)'}}>{error}</div>}
      {flash && <div className="w-full rounded-md px-3 py-2 text-sm" style={{backgroundColor:'var(--color-forest-tint)',color:'var(--color-forest-deep)',border:'1px solid rgba(31,74,53,.2)'}}>{flash}</div>}

      {showAllocate && (
        <AllocateForm
          paymentId={paymentId}
          unallocatedKobo={unallocatedKobo}
          invoices={invoices}
          busy={busy==='Allocate'}
          onSubmit={(allocations)=>post(`/api/payments/${paymentId}/allocate`, { allocations }, 'Allocate')}
        />
      )}
      {showReverse && (
        <ReverseForm
          busy={busy==='Reverse'}
          onSubmit={(data)=>post(`/api/payments/${paymentId}/reverse`, data, 'Reverse')}
        />
      )}
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading, disabled }: { children: React.ReactNode; onClick: ()=>void; loading?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={loading||disabled}
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3.5 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] disabled:opacity-50">
      {loading ? 'Working…' : children}
    </button>
  );
}

function AllocateForm({ paymentId: _p, unallocatedKobo, invoices, busy, onSubmit }:{
  paymentId: string; unallocatedKobo: number; invoices: InvoiceOpt[]; busy: boolean;
  onSubmit: (a: { invoiceId: string; amountKobo: number; note?: string }[]) => void;
}) {
  const [selected, setSelected] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const amountK = parseKobo(amount);
  const inv = useMemo(()=>invoices.find(i=>i.id===selected), [invoices, selected]);
  const max = inv ? Math.min(unallocatedKobo, inv.remainingKobo) : 0;
  const capped = Math.min(amountK, max);
  useEffect(() => { if (inv && !amount) setAmount(String(Math.floor(max/100))); }, [inv?.id]); // eslint-disable-line
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!inv || capped <= 0) return;
    onSubmit([{ invoiceId: inv.id, amountKobo: capped, note: note.trim() || undefined }]);
  }
  return (
    <form onSubmit={submit} className="w-full rounded-md p-4 mt-2" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid var(--color-border-subtle)'}}>
      <div className="text-[11px] uppercase tracking-wider font-medium mb-2" style={{color:'var(--color-text-faint)'}}>Allocate</div>
      <label className="block mb-2">
        <span className="block text-sm font-medium mb-1">Invoice</span>
        <select value={selected} onChange={e=>setSelected(e.target.value)} style={inputStyle} required>
          <option value="">Select an open invoice…</option>
          {invoices.map(i=>(<option key={i.id} value={i.id}>{i.invoiceNumber} — {i.studentName} — {fmtN(i.remainingKobo)} remaining</option>))}
        </select>
      </label>
      <label className="block mb-2">
        <span className="block text-sm font-medium mb-1">Amount (₦)</span>
        <input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} style={inputStyle} required />
        {inv && amountK > 0 && (
          <div className="text-[11px] mt-1" style={{color: capped<amountK ? 'var(--color-danger,#a82a1c)' : 'var(--color-text-faint)'}}>
            Will allocate {fmtN(capped)}{capped<amountK?` (clamped from ${fmtN(amountK)} to available ${fmtN(max)})`:''}.
          </div>
        )}
      </label>
      <label className="block mb-3">
        <span className="block text-sm font-medium mb-1">Note (optional)</span>
        <input value={note} onChange={e=>setNote(e.target.value)} style={inputStyle} placeholder="e.g. Part payment — cash" />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={()=>{/*handled by parent*/}} className="hidden" />
        <button type="submit" disabled={busy||!inv||capped<=0}
                className="rounded-md bg-[color:var(--color-forest)] px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-50">
          {busy?'Allocating…':'Apply allocation'}
        </button>
      </div>
    </form>
  );
}

function ReverseForm({ busy, onSubmit }: { busy: boolean; onSubmit: (d: any)=>void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const [type, setType] = useState<'REVERSAL'|'REFUND'|'CORRECTION'>('REVERSAL');
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountKobo = parseKobo(amount);
    if (amountKobo <= 0 || !reason.trim()) return;
    onSubmit({ amountKobo, reason: reason.trim(), reference: ref.trim() || undefined, type });
  }
  return (
    <form onSubmit={submit} className="w-full rounded-md p-4 mt-2" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid rgba(185,56,42,.25)'}}>
      <div className="text-[11px] uppercase tracking-wider font-medium mb-2" style={{color:'var(--color-danger,#a82a1c)'}}>Reverse / refund</div>
      <p className="text-[12px] mb-3" style={{color:'var(--color-text-secondary)'}}>
        Reversing unwinds allocations and restores invoice balances. This action is append-only and cannot be undone from the UI.
      </p>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <label className="block">
          <span className="block text-sm font-medium mb-1">Type</span>
          <select value={type} onChange={e=>setType(e.target.value as any)} style={inputStyle}>
            <option value="REVERSAL">Reversal</option>
            <option value="REFUND">Refund</option>
            <option value="CORRECTION">Correction</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-sm font-medium mb-1">Amount (₦)</span>
          <input inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)} style={inputStyle} />
        </label>
      </div>
      <label className="block mb-2">
        <span className="block text-sm font-medium mb-1">Reason</span>
        <input required value={reason} onChange={e=>setReason(e.target.value)} style={inputStyle} placeholder="Required" />
      </label>
      <label className="block mb-3">
        <span className="block text-sm font-medium mb-1">Reference (optional)</span>
        <input value={ref} onChange={e=>setRef(e.target.value)} style={inputStyle} />
      </label>
      <div className="flex justify-end">
        <button type="submit" disabled={busy}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-50"
                style={{backgroundColor:'var(--color-danger,#a82a1c)'}}>
          {busy?'Processing…':'Record reversal'}
        </button>
      </div>
    </form>
  );
}
