'use client';
/**
 * Invitation form + one-time link display.
 *
 * The token is returned by the API exactly once and exists only in this
 * component's state. It is never written to storage and never re-fetchable: a
 * reload loses it, which is why the panel is explicit about copying it now.
 */
import { useState } from 'react';
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

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  display: 'block',
  marginBottom: 4,
};

const ROLES = [
  { value: 'SCHOOL_ADMIN', label: 'Administrator', hint: 'Runs the school day to day' },
  { value: 'FINANCE_OFFICER', label: 'Finance Officer', hint: 'Invoices, payments, receipts' },
  { value: 'STAFF', label: 'Staff', hint: 'Read-only view of the roster' },
] as const;

export function InviteForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('SCHOOL_ADMIN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    setCopied(false);
    try {
      const res = await fetch('/api/members/invitations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ email, role }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'The invitation could not be created.');
      setLink(json.acceptUrl as string);
      setSentTo(json?.invitation?.email ?? email);
      setEmail('');
    } catch (err: unknown) {
      setError((err as Error)?.message ?? 'The invitation could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else window.prompt('Copy this invitation link', link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy this invitation link', link);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label style={labelStyle} htmlFor="invite-email">
          Email address
        </label>
        <input
          id="invite-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="bursar@school.ng"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />
      </div>

      <fieldset>
        <legend style={labelStyle}>Role</legend>
        <div className="flex flex-col gap-2">
          {ROLES.map((r) => (
            <label
              key={r.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2"
              style={{
                border: `1px solid ${role === r.value ? 'var(--color-forest)' : 'var(--color-border-subtle)'}`,
                backgroundColor: role === r.value ? 'var(--color-forest-tint)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name="role"
                value={r.value}
                checked={role === r.value}
                onChange={() => setRole(r.value)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span
                  className="block text-[13px] font-medium"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {r.label}
                </span>
                <span className="block text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                  {r.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        style={{ backgroundColor: 'var(--color-forest)' }}
      >
        {busy ? 'Creating link…' : 'Create invitation link'}
      </button>

      {error && (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--color-danger, #a82a1c)' }}>
          {error}
        </p>
      )}

      {link && (
        <div
          className="rounded-lg p-3"
          style={{
            backgroundColor: 'var(--color-forest-tint)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <p className="text-[13px] font-medium" style={{ color: 'var(--color-forest-deepest)' }}>
            Link ready{sentTo ? ` for ${sentTo}` : ''}
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
            Copy it now — SCOLAIRA does not store the link and cannot show it again. Send it to them
            yourself; there is no email in this release.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code
              className="min-w-0 flex-1 break-all rounded-md px-2 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--color-bg-page)',
                color: 'var(--color-text-primary)',
              }}
            >
              {link}
            </code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-md px-3 py-1.5 text-[12px] font-medium"
              style={{ backgroundColor: 'var(--color-forest)', color: 'var(--color-ivory)' }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
