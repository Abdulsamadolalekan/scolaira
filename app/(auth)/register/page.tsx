'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    organizationName: '',
    organizationSlug: '',
    password: '',
    confirm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) { setError('Passwords do not match.'); return; }
    if (form.password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(form.organizationSlug)) {
      setError('School URL slug must be lowercase letters, numbers, and hyphens only.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          firstName: form.firstName,
          lastName: form.lastName,
          organizationName: form.organizationName,
          organizationSlug: form.organizationSlug,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not create account.'); setLoading(false); return; }
      router.replace('/dashboard');
      router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  const inputStyle = {
    border: '1px solid var(--color-border)',
    backgroundColor: 'white',
  };

  return (
    <div>
      <h2 className="text-xl mb-1" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>
        Create your school workspace
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
        Set up SCOLAIRA for your school. You will be the school administrator.
      </p>

      {error && (
        <div className="rounded-lg px-3 py-2 mb-4 text-sm" style={{
          backgroundColor: 'rgba(185, 56, 42, 0.08)', color: 'var(--color-danger)',
          border: '1px solid rgba(185, 56, 42, 0.25)',
        }}>{error}</div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">First name</label>
            <input required value={form.firstName} onChange={(e) => set('firstName', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Last name</label>
            <input required value={form.lastName} onChange={(e) => set('lastName', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Work email</label>
          <input type="email" required autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} placeholder="you@school.edu.ng" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">School name</label>
          <input required value={form.organizationName} onChange={(e) => set('organizationName', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} placeholder="Grace Academy" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">School URL slug</label>
          <input required value={form.organizationSlug} onChange={(e) => set('organizationSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} className="w-full rounded-lg px-3 py-2 text-sm font-mono" style={inputStyle} placeholder="grace-academy" />
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-faint)' }}>
            Lowercase letters, numbers, hyphens. Used as your unique school path.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Password</label>
          <input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} placeholder="At least 10 characters" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm password</label>
          <input type="password" required minLength={10} autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} />
        </div>

        <button type="submit" disabled={loading} className="w-full rounded-lg py-2.5 text-sm font-medium" style={{
          backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)', opacity: loading ? 0.7 : 1,
        }}>
          {loading ? 'Creating workspace…' : 'Create workspace'}
        </button>
      </form>

      <div className="mt-6 pt-5 text-center text-sm" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        <span style={{ color: 'var(--color-text-muted)' }}>Already have an account?</span>{' '}
        <Link href="/login" className="font-medium" style={{ color: 'var(--color-forest-deep)' }}>Sign in</Link>
      </div>
    </div>
  );
}
