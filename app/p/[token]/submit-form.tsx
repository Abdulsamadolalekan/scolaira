'use client';
import { useState } from 'react';

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-bg-page)',
  color: 'var(--color-text-primary)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 14,
  width: '100%',
  outline: 'none',
};

export default function SubmitForm({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  // One submission key per rendered form. Retrying the same submission (a lost
  // response, a flaky network, a double click) is then a REPLAY of the original
  // outcome instead of a second PENDING row for the bursar to clean up.
  const [idempotencyKey] = useState(() => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/p/${token}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          payerName: name.trim(),
          payerPhone: phone.trim() || undefined,
          payerEmail: email.trim() || undefined,
          reference: reference.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error?.message ?? 'Could not submit payment.'); setLoading(false); return; }
      setConfirmed(data.payment.paymentNumber);
    } catch { setError('Network error. Please try again.'); setLoading(false); }
  }

  if (confirmed) {
    return (
      <div className="mt-6 rounded-md p-4" style={{ backgroundColor: 'var(--color-forest-tint)', border: '1px solid var(--color-border-subtle)' }}>
        <div className="font-semibold" style={{ color: 'var(--color-forest-deepest)' }}>Thank you — your payment has been logged.</div>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Reference <span className="font-mono tabular-nums">{confirmed}</span> has been sent to the bursar for confirmation. You may close this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      {error && <div className="rounded-md px-3 py-2 text-sm" style={{backgroundColor:'rgba(185,56,42,.08)',color:'var(--color-danger)',border:'1px solid rgba(185,56,42,.25)'}}>{error}</div>}
      <label className="block">
        <span className="block text-sm font-medium mb-1">Your name</span>
        <input required value={name} onChange={e=>setName(e.target.value)} style={inputStyle} placeholder="Parent/guardian name" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm font-medium mb-1">Phone</span>
          <input value={phone} onChange={e=>setPhone(e.target.value)} style={inputStyle} placeholder="080…" />
        </label>
        <label className="block">
          <span className="block text-sm font-medium mb-1">Email (optional)</span>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} style={inputStyle} />
        </label>
      </div>
      <label className="block">
        <span className="block text-sm font-medium mb-1">Teller / transfer reference</span>
        <input required value={reference} onChange={e=>setReference(e.target.value)} style={inputStyle} placeholder="The reference from your bank transfer" />
      </label>
      <button type="submit" disabled={loading}
              className="w-full rounded-md bg-[color:var(--color-forest)] px-4 py-3 text-[14px] font-medium text-white disabled:opacity-50">
        {loading ? 'Submitting…' : 'Notify the school of my payment'}
      </button>
      <p className="text-[11px] text-center" style={{ color: 'var(--color-text-faint)' }}>
        Your payment is <strong>not confirmed</strong> until the bursar verifies it with the bank.
      </p>
    </form>
  );
}
