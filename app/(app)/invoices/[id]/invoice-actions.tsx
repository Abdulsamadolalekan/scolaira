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

export default function InvoiceActions({ invoiceId, status, paidKobo, remainingKobo, canRotate = false }: { invoiceId: string; status: string; paidKobo: number; remainingKobo: number; canRotate?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [flash, setFlash] = useState<string|null>(null);
  const [showVoid, setShowVoid] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  // H-5: rotation is the operational remedy for a leaked payment-link URL.
  const [showRotate, setShowRotate] = useState(false);
  const [rotateReason, setRotateReason] = useState('');
  const [rotatedUrl, setRotatedUrl] = useState<string | null>(null);

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

  /**
   * H-5 — rotate the invoice's active payment link.
   *
   * Rotation is deliberately narrow: it retires the bearer token that is known
   * (or suspected) to have leaked and issues a fresh one, while the link, the
   * invoice binding and every payment already attributed stay exactly as they
   * are. Stored history is append-only and is NOT rewritten — the exposed token
   * simply stops authorizing anything.
   *
   * The operator is told the operational consequence before confirming, because
   * a URL already sent to parents stops working the moment this succeeds.
   */
  async function rotatePaymentLink() {
    setBusy('Rotate'); setError(null); setRotatedUrl(null);
    try {
      const existingRes = await fetch('/api/payment-links', { credentials: 'same-origin', cache: 'no-store' });
      const existing = await existingRes.json().catch(() => ({}));
      const active = (existing?.links ?? []).find((link: any) => link.invoiceId === invoiceId && link.status === 'ACTIVE');
      if (!active?.token) throw new Error('This invoice has no active payment link to rotate.');
      const res = await fetch(`/api/payment-links/${encodeURIComponent(active.token as string)}/rotate`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(rotateReason.trim() ? { reason: rotateReason.trim() } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message ?? 'Could not rotate the payment link.');
      const url = data?.link?.url as string | undefined;
      setShowRotate(false); setRotateReason('');
      setRotatedUrl(url ?? null);
      setFlash('Payment link rotated — the previous URL no longer works.');
      setBusy(null);
      router.refresh();
      setTimeout(() => setFlash(null), 6000);
    } catch (e: any) { setError(e?.message ?? 'Could not rotate the payment link.'); setBusy(null); }
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
        {/* H-5: owner-only. The route enforces `payment_link.rotate`; this is
            the affordance for the operator who may actually use it. */}
        {canRotate && !isVoid && (
          <button type="button"
                  style={{...btnBase, backgroundColor:'transparent', borderColor:'var(--color-border)', color:'var(--color-text-secondary)'}}
                  disabled={busy!==null}
                  title="Retire this link&apos;s URL and issue a new one"
                  onClick={()=>setShowRotate(v=>!v)}>
            Rotate link
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

      {showRotate && (
        <form onSubmit={(e)=>{ e.preventDefault(); rotatePaymentLink(); }}
              className="w-full max-w-sm rounded-md p-3 mt-1" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid var(--color-border)'}}>
          <div className="text-[11px] uppercase tracking-wider font-medium mb-1" style={{color:'var(--color-forest)'}}>Rotate payment link</div>
          <p className="text-[12px] mb-2" style={{color:'var(--color-text-secondary)'}}>
            Use this when the link&apos;s URL has leaked (a forwarded message, a screenshot, a shared device).
            A new URL is issued and the old one stops working immediately. The invoice, its amount and every
            payment already recorded are unchanged.
          </p>
          <p className="text-[12px] mb-2" style={{color:'var(--color-danger,#a82a1c)'}}>
            Anyone still holding the old URL will no longer be able to pay with it — send them the new one.
          </p>
          <label className="block mb-2">
            <span className="block text-sm font-medium mb-1">Reason (optional, audited)</span>
            <input value={rotateReason} onChange={e=>setRotateReason(e.target.value)} style={inputStyle} maxLength={300} placeholder="e.g. URL forwarded to a public group" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={()=>setShowRotate(false)} className="text-[13px] px-2 py-1" style={{color:'var(--color-text-secondary)'}}>Cancel</button>
            <button type="submit" disabled={busy!==null}
                    className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                    style={{backgroundColor:'var(--color-forest)'}}>
              {busy==='Rotate'?'Rotating…':'Rotate link'}
            </button>
          </div>
        </form>
      )}
      {rotatedUrl && (
        <div className="w-full max-w-sm rounded-md p-3" style={{backgroundColor:'var(--color-bg-page)',border:'1px solid var(--color-border)'}}>
          <div className="text-[11px] uppercase tracking-wider font-medium mb-1" style={{color:'var(--color-forest)'}}>New payment link</div>
          <code className="block break-all text-[12px] mb-2">{window.location.origin}{rotatedUrl}</code>
          <div className="flex justify-end gap-2">
            <button type="button" className="text-[13px] px-2 py-1" style={{color:'var(--color-forest)'}}
                    onClick={async () => {
                      const absolute = `${window.location.origin}${rotatedUrl}`;
                      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(absolute);
                      else window.prompt('Copy payment link', absolute);
                      setFlash('New payment link copied.');
                      setTimeout(()=>setFlash(null), 2500);
                    }}>
              Copy new link
            </button>
            <button type="button" className="text-[13px] px-2 py-1" style={{color:'var(--color-text-secondary)'}} onClick={()=>setRotatedUrl(null)}>Dismiss</button>
          </div>
        </div>
      )}
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
