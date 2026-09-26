'use client';
import { useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

function ConfirmForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not reset password.'); setLoading(false); return; }
      setDone(true);
    } catch { setError('Network error.'); setLoading(false); }
  }

  if (!token) {
    return (
      <div>
        <h2 className="text-xl mb-2" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Invalid reset link</h2>
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>This link is missing or invalid. Please request a new password reset.</p>
        <Link href="/reset" className="inline-block w-full text-center rounded-lg py-2.5 text-sm font-medium" style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)' }}>Request new link</Link>
      </div>
    );
  }

  if (done) {
    return (
      <div>
        <h2 className="text-xl mb-2" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Password updated</h2>
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>Your password has been changed. All other sessions have been signed out.</p>
        <button onClick={() => router.push('/login')} className="w-full rounded-lg py-2.5 text-sm font-medium" style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)' }}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl mb-1" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Set new password</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>Choose a new password. At least 10 characters.</p>
      {error && <div className="rounded-lg px-3 py-2 mb-4 text-sm" style={{ backgroundColor: 'rgba(185,56,42,0.08)', color: 'var(--color-danger)', border: '1px solid rgba(185,56,42,0.25)' }}>{error}</div>}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">New password</label>
          <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid var(--color-border)', backgroundColor: 'white' }} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm new password</label>
          <input type="password" required minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid var(--color-border)', backgroundColor: 'white' }} />
        </div>
        <button type="submit" disabled={loading} className="w-full rounded-lg py-2.5 text-sm font-medium" style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)', opacity: loading ? 0.7 : 1 }}>
          {loading ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><ConfirmForm /></Suspense>;
}
