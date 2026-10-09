'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';

const btnSecondary: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  backgroundColor: '#fff',
  color: 'var(--color-text-primary)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  border: '1px solid rgba(168,42,28,.25)',
  backgroundColor: 'rgba(168,42,28,.08)',
  color: 'var(--color-danger,#a82a1c)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

export default function StudentActions({ studentId, status }: { studentId: string; status: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string|null>(null);
  const isArchived = status !== 'ACTIVE';

  async function onArchive(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/students/${studentId}/archive`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ reason: 'Archived by user' }),
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) { setError(data?.error?.message ?? 'Could not archive student.'); setLoading(false); return; }
      setOpen(false); router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  async function onRestore() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/students/${studentId}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: '{}',
      });
      if (!res.ok) { const d = await res.json().catch(()=>({})); setError(d?.error?.message ?? 'Could not restore student.'); setLoading(false); return; }
      router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  if (isArchived) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-[12px]" style={{color:'var(--color-danger,#a82a1c)'}}>{error}</span>}
        <button type="button" style={btnSecondary} disabled={loading} onClick={onRestore}>
          {loading ? 'Working…' : 'Re-enrol (restore)'}
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {!open ? (
        <button type="button" style={btnDanger} disabled={loading} onClick={()=>setOpen(true)}>Archive student</button>
      ) : (
        <form onSubmit={onArchive} className="flex items-center gap-2">
          {error && <span className="text-[12px]" style={{color:'var(--color-danger,#a82a1c)'}}>{error}</span>}
          <span className="text-[12px]" style={{color:'var(--color-text-secondary)'}}>Archive? This student has no open invoices.</span>
          <button type="button" style={btnSecondary} onClick={()=>setOpen(false)}>Cancel</button>
          <button type="submit" style={btnDanger} disabled={loading}>{loading ? 'Archiving…' : 'Confirm archive'}</button>
        </form>
      )}
    </div>
  );
}
