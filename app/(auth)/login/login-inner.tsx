'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? 'Sign in failed.');
        setLoading(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div>
      <h2
        className="text-xl mb-1"
        style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
      >
        Sign in
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
        Enter your credentials to access your school workspace.
      </p>

      {error && (
        <div
          className="rounded-lg px-3 py-2 mb-4 text-sm"
          style={{
            backgroundColor: 'rgba(185, 56, 42, 0.08)',
            color: 'var(--color-danger)',
            border: '1px solid rgba(185, 56, 42, 0.25)',
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium mb-1">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{
              border: '1px solid var(--color-border)',
              backgroundColor: 'white',
              color: 'var(--color-text-primary)',
            }}
            placeholder="name@school.edu.ng"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="password" className="block text-sm font-medium">
              Password
            </label>
            <Link
              href="/reset"
              className="text-xs"
              style={{ color: 'var(--color-forest)' }}
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{
              border: '1px solid var(--color-border)',
              backgroundColor: 'white',
            }}
            placeholder="••••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg py-2.5 text-sm font-medium transition"
          style={{
            backgroundColor: 'var(--color-forest-deep)',
            color: 'var(--color-ivory)',
            border: '1px solid var(--color-gold)',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="mt-6 pt-5 text-center text-sm" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        <span style={{ color: 'var(--color-text-muted)' }}>New school?</span>{' '}
        <Link href="/register" className="font-medium" style={{ color: 'var(--color-forest-deep)' }}>
          Create an account
        </Link>
      </div>
    </div>
  );
}
