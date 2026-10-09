'use client';
/**
 * Register — client inner.
 *
 * Split out of `page.tsx` so the route can read search params through a Suspense
 * boundary, matching the pattern already used by `/login` (login-inner.tsx). The form,
 * its validation, its endpoint and its error handling are unchanged.
 *
 * PREFILL
 *   The public site's pilot enquiry form hands off here with `?school=…&email=…&from=pilot`.
 *   Carrying those two values across is the whole point of the handoff — the visitor has
 *   already typed them once. The slug is derived from the school name so the field is not
 *   empty on arrival; it remains fully editable and is still validated server-side.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function RegisterPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const prefillSchool = params.get('school')?.trim() ?? '';
  const prefillEmail = params.get('email')?.trim() ?? '';
  const fromPilot = params.get('from') === 'pilot';

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: prefillEmail,
    organizationName: prefillSchool,
    organizationSlug: deriveSlug(prefillSchool),
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
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (form.password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
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
      if (!res.ok) {
        setError(data?.error?.message ?? 'Could not create account.');
        setLoading(false);
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Network error.');
      setLoading(false);
    }
  }

  const inputStyle = {
    border: '1px solid var(--color-border)',
    backgroundColor: 'white',
  };

  return (
    <div>
      <h1 className="mb-2 text-display-sm" style={{ color: 'var(--color-forest-deepest)' }}>
        Create your school workspace
      </h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
        {fromPilot
          ? 'Your pilot enquiry is carried across. Create the workspace and you will be its administrator.'
          : 'Set up SCOLAIRA for your school. You will be the school administrator.'}
      </p>

      {error && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-sm"
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium">First name</label>
            <input
              required
              value={form.firstName}
              onChange={(e) => set('firstName', e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Last name</label>
            <input
              required
              value={form.lastName}
              onChange={(e) => set('lastName', e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm"
              style={inputStyle}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Work email</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={inputStyle}
            placeholder="you@school.edu.ng"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">School name</label>
          <input
            required
            value={form.organizationName}
            onChange={(e) => set('organizationName', e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={inputStyle}
            placeholder="Grace Academy"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">School URL slug</label>
          <input
            required
            value={form.organizationSlug}
            onChange={(e) =>
              set('organizationSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
            }
            className="w-full rounded-lg px-3 py-2 font-mono text-sm"
            style={inputStyle}
            placeholder="grace-academy"
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            Lowercase letters, numbers, hyphens. Used as your unique school path.
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Password</label>
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={inputStyle}
            placeholder="At least 10 characters"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Confirm password</label>
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => set('confirm', e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={inputStyle}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg py-2.5 text-sm font-medium"
          style={{
            backgroundColor: 'var(--color-forest-deep)',
            color: 'var(--color-ivory)',
            border: '1px solid var(--color-gold)',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Creating workspace…' : 'Create workspace'}
        </button>
      </form>

      <div
        className="mt-6 pt-5 text-center text-sm"
        style={{ borderTop: '1px solid var(--color-border-subtle)' }}
      >
        <span style={{ color: 'var(--color-text-muted)' }}>Already have an account?</span>{' '}
        <Link href="/login" className="font-medium" style={{ color: 'var(--color-forest-deep)' }}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
