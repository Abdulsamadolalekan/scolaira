'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { csrfHeaders } from '@/lib/ui/csrf';

const btnBase: React.CSSProperties = {
  borderRadius: 6, padding: '6px 12px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
  border: '1px solid transparent', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', backgroundColor: 'var(--color-bg-page)',
  color: 'var(--color-text-primary)', borderRadius: 8, padding: '8px 12px', fontSize: 14, width: '100%', outline:'none',
};

export default function InvoiceActions({ invoiceId, status, paidKobo, remainingKobo }: { invoiceId: string; status: string; paidKobo: number; remainingKobo: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [flash, setFlash] = useState<string|null>(null);
  const [showVoid, setShowVoid] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const isVoid = status === 'VOID';
  const isDraft = status === 'DRAFT';
  const isPaid = status === 'PAID';
  const hasBalance = remainingKobo > 0;

  async function copyPaymentLink() {
    setBusy('Copy payment link'); setError(null);
    try {
      const existingRes = await fetch('/api/payment-links', { credentials: 'same-origin', cache: 'no-store' });
      const existing = await existingRes.json().catch(() => ({}));
      const active = (existing?.links ?? []).find((link: any) => link.invoiceId === invoiceId && link.status === 'ACTIVE');
      let url = active?.url as string | undefined;
      if (!url) {
        const createdRes = await fetch('/api/payment-links', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify({ invoiceId }),
        });
        const created = await createdRes.json().catch(() => ({}));
        if (!createdRes.ok) throw new Error(created?.error?.message ?? 'Could not create a payment link.');
        url = created?.link?.url;
      }
      if (!url) throw new Error('Payment link was not returned.');
      const absolute = `${window.location.origin}${url}`;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(absolute);
      else window.prompt('Copy payment link', absolute);
      setFlash('Payment link copied.');
      setBusy(null);
      setTimeout(() => setFlash(null), 2500);
    } catch (e: any) { setError(e?.message ?? 'Could not copy payment link.'); setBusy(null); }
  }

  async function post(path: string, body: any, label: string) {
    setBusy(label); setError(null);
    try {
      const res = await fetch(path, {
        // R2/H-7: voiding an invoice is a financial mutation and requires an
        // Idempotency-Key so a retried request replays instead of re-deciding.
        method:'POST', headers:{'content-type':'application/json', 'Idempotency-Key': crypto.randomUUID(), ...csrfHeaders()}, credentials:'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) { setError(data?.error?.message ?? `Could not ${label.toLowerCase()}.`); setBusy(null); return; }
      setFlash(`${label} succeeded.`);
      setShowVoid(false); setVoidReason('');
      router.refresh();
      setTimeout(()=>setFlash(null), 2500);
    } catch { setError('Network error.'); setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-2 items-end">
      <div className="flex flex-wrap gap-2 justify-end">
        {!isVoid && !isPaid && hasBalance && (
          <Link href={`/payments/new?invoiceId=${invoiceId}`}
                style={{...btnBase, backgroundColor:'var(--color-forest)', color:'white'}}>
            Record payment
          </Link>
        )}
        {!isVoid && hasBalance && (
          <button type="button" style={{...btnBase, backgroundColor:'transparent', borderColor:'var(--color-border)', color:'var(--color-forest)'}} disabled={busy!==null} onClick={copyPaymentLink}>
            {busy === 'Copy payment link' ? 'Preparing…' : 'Copy payment link'}
          </button>
        )}
        {isDraft && (
          <button type="button" style={{...btnBase, backgroundColor:'var(--color-forest)', color:'white'}}
                  disabled={busy!==null}
                  onClick={()=>post(`/api/invoices/${invoiceId}/issue`, {}, 'Issue')}>
            {busy==='Issue'?'Issuing…':'Issue invoice'}
          </button>
        )}
        {!isVoid && (
          <button type="button"
                  style={{...btnBase, backgroundColor:'transparent', borderColor:'var(--color-border)', color:'var(--color-danger,#a82a1c)'}}
                  disabled={busy!==null}
                  onClick={()=>setShowVoid(v=>!v)}>
            Void
          </button>
        )}
        {isVoid && <span className="text-[12px] px-2 py-1 rounded-sm bg-neutral-bg text-neutral-fg">Voided</span>}
      </div>
      {error && <div className="text-right text-[12px]" style={{color:'var(--color-danger,#a82a1c)'}}>{error}</div>}
      {flash && <div className="text-right text-[12px]" style={{color:'var(--color-forest-deep)'}}>{flash}</div>}

      {showVoid && (
        <form onSubmit={(e)=>{ e.preventDefault(); if(!voidReason.trim()) return; post(`/api/invoices/${invoiceId}/void`, { reason: voidReason.trim() }, 'Void'); }}
              className="w-full max-w-sm rounded-md p-3 mt-1" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid rgba(185,56,42,.25)'}}>
          <div className="text-[11px] uppercase tracking-wider font-medium mb-1" style={{color:'var(--color-danger,#a82a1c)'}}>Void invoice</div>
          {paidKobo > 0 && (
            <p className="text-[12px] mb-2" style={{color:'var(--color-danger,#a82a1c)'}}>
              This invoice has recorded payments. Reverse those payments first.
            </p>
          )}
          <label className="block mb-2">
            <span className="block text-sm font-medium mb-1">Reason (required)</span>
            <input value={voidReason} onChange={e=>setVoidReason(e.target.value)} style={inputStyle} required placeholder="e.g. Issued in error" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={()=>setShowVoid(false)} className="text-[13px] px-2 py-1" style={{color:'var(--color-text-secondary)'}}>Cancel</button>
            <button type="submit" disabled={busy!==null || paidKobo>0 || !voidReason.trim()}
                    className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                    style={{backgroundColor:'var(--color-danger,#a82a1c)'}}>
              {busy==='Void'?'Voiding…':'Void invoice'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
