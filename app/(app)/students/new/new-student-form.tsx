'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

export default function NewStudentForm() {
  const router = useRouter();
  const [studentId, setStudentId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState<'M'|'F'|'OTHER'|''>('');
  const [error, setError] = useState<string|null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const body: any = { studentId: studentId.trim(), firstName: firstName.trim(), lastName: lastName.trim() };
      if (gender) body.gender = gender;
      const res = await fetch('/api/students', {
        method: 'POST', headers: { 'content-type':'application/json', ...csrfHeaders() }, credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'Could not create student.'); setLoading(false); return; }
      router.push(`/students/${data.student.id}`);
      router.refresh();
    } catch { setError('Network error.'); setLoading(false); }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" style={{backgroundColor:'var(--color-bg-panel)',border:'1px solid var(--color-border-subtle)',borderRadius:12,padding:24}}>
      {error && <div className="rounded-lg px-3 py-2 text-sm" style={{backgroundColor:'rgba(185,56,42,.08)',color:'var(--color-danger)',border:'1px solid rgba(185,56,42,.25)'}}>{error}</div>}
      <Field label="Student ID / Admission number" hint="Unique within your school. Cannot be changed.">
        <input required value={studentId} onChange={e=>setStudentId(e.target.value)} style={inputStyle} placeholder="e.g. STU-2026-001" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input required value={firstName} onChange={e=>setFirstName(e.target.value)} style={inputStyle} /></Field>
        <Field label="Last name"><input required value={lastName} onChange={e=>setLastName(e.target.value)} style={inputStyle} /></Field>
      </div>
      <Field label="Gender">
        <select value={gender} onChange={e=>setGender(e.target.value as any)} style={inputStyle}>
          <option value="">Prefer not to say</option>
          <option value="M">Male</option>
          <option value="F">Female</option>
          <option value="OTHER">Other</option>
        </select>
      </Field>
      <div className="pt-2 flex gap-2 justify-end">
        <button type="button" onClick={()=>router.back()} className="rounded-md px-3 py-2 text-[13px] font-medium" style={{color:'var(--color-text-secondary)'}}>Cancel</button>
        <button type="submit" disabled={loading}
                className="rounded-md bg-[color:var(--color-forest)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)] disabled:opacity-50">
          {loading ? 'Saving…' : 'Save student'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={{color:'var(--color-text-faint)'}}>{hint}</span>}
    </label>
  );
}
