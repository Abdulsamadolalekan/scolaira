'use client';
import { useState } from 'react';
import Link from 'next/link';

export default function ResetRequestPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // In dev/test the API echoes the reset token so we can complete the flow.
  // In production, email delivery handles the link.
  const [devToken, setDevToken] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/auth/reset-request', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not process.'); setLoading(false); return; }
      setSubmitted(true);
      setDevToken(data.token ?? null);
    } catch { setError('Network error.'); } finally { setLoading(false); }
  }

  if (submitted) {
    return (
      <div>
        <h2 className="text-xl mb-1" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Check your email</h2>
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
          If an account exists for <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{email}</span>,
          we have sent a password-reset link valid for one hour.
        </p>
        {devToken && (
          <div className="rounded-lg p-3 mb-4 text-xs font-mono break-all" style={{
            backgroundColor: 'rgba(191,155,79,0.08)', border: '1px dashed var(--color-gold)', color: 'var(--color-forest-deepest)',
          }}>
            <div className="font-sans text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Development preview — use this link:
            </div>
            <Link href={`/reset/confirm?token=${encodeURIComponent(devToken)}`} style={{ color: 'var(--color-forest-deep)' }}>
              /reset/confirm?token=…
            </Link>
          </div>
        )}
        <Link href="/login" className="inline-block w-full text-center rounded-lg py-2.5 text-sm font-medium" style={{
          backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)',
        }}>
          Return to sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl mb-1" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Reset password</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
        Enter your email and we will send you a link to choose a new password.
      </p>
      {error && <div className="rounded-lg px-3 py-2 mb-4 text-sm" style={{ backgroundColor: 'rgba(185,56,42,0.08)', color: 'var(--color-danger)', border: '1px solid rgba(185,56,42,0.25)' }}>{error}</div>}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email address</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid var(--color-border)', backgroundColor: 'white' }} />
        </div>
        <button type="submit" disabled={loading} className="w-full rounded-lg py-2.5 text-sm font-medium" style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)', opacity: loading ? 0.7 : 1 }}>
          {loading ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <div className="mt-6 pt-5 text-center text-sm" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        <Link href="/login" className="font-medium" style={{ color: 'var(--color-forest-deep)' }}>Back to sign in</Link>
      </div>
    </div>
  );
}
