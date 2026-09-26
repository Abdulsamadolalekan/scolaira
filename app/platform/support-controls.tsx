'use client';
/**
 * Support-mode controls.
 *
 * Both calls go through `/api/platform/support-mode`, which requires the platform
 * capability, CSRF on unsafe methods, and writes the audit row *before* the
 * support cookie exists. The button is disabled while a request is in flight so a
 * double-click cannot leave two audit rows for one visit.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';

const base: React.CSSProperties = {
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: '1px solid transparent',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

export function EnterSupportButton({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/support-mode', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ organizationId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'Support mode could not be opened.');
      router.push(`/platform/orgs/${organizationId}`);
      router.refresh();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Support mode could not be opened.');
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={enter}
        disabled={busy}
        style={{ ...base, backgroundColor: 'var(--color-forest)', color: 'var(--color-ivory)' }}
        aria-label={`Open read-only support view for ${organizationName}`}
      >
        {busy ? 'Opening…' : 'Support view'}
      </button>
      {error && (
        <span
          role="alert"
          className="text-[11px]"
          style={{ color: 'var(--color-danger, #a82a1c)' }}
        >
          {error}
        </span>
      )}
    </span>
  );
}

export function ExitSupportButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/support-mode', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { ...csrfHeaders() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'Support mode could not be closed.');
      router.push('/platform');
      router.refresh();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Support mode could not be closed.');
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={exit}
        disabled={busy}
        style={{
          ...base,
          border: '1px solid var(--color-border-subtle)',
          backgroundColor: 'var(--color-bg-page)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {busy ? 'Closing…' : 'Exit support mode'}
      </button>
      {error && (
        <span
          role="alert"
          className="text-[11px]"
          style={{ color: 'var(--color-danger, #a82a1c)' }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
