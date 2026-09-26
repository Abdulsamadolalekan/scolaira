'use client';
/**
 * The accept button.
 *
 * `POST /api/invitations/<token>/accept` is CSRF-protected and requires the
 * signed-in session — the token alone is not enough. On success the new
 * membership exists, so a full navigation to the workspace lets the shell resolve
 * the new active organization from a fresh session.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';

export function AcceptInvitation({
  token,
  organizationName,
}: {
  token: string;
  organizationName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'The invitation could not be accepted.');
      router.push('/dashboard');
      router.refresh();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'The invitation could not be accepted.');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-md px-3 py-2 text-[13px] font-medium disabled:opacity-60"
        style={{ backgroundColor: 'var(--color-forest)', color: 'var(--color-ivory)' }}
      >
        {busy ? 'Joining…' : `Accept and join ${organizationName}`}
      </button>
      {error && (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--color-danger, #a82a1c)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
