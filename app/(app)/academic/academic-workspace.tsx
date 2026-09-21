'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { csrfHeaders } from '@/lib/ui/csrf';

interface Session { id: string; name: string; startsOn: string; endsOn: string | null; isCurrent: boolean; status: string; }
interface Term { id: string; name: string; label: string; sessionId: string; startsOn: string; endsOn: string | null; dueDate: string | null; isCurrent: boolean; status: string; billed: boolean; }
interface SchoolClass { id: string; name: string; arm: string | null; sortOrder: number; deletedAt: string | null; label: string; }
interface Student { id: string; studentId: string; name: string; status: string; }
interface RosterRow { id: string; studentId: string; studentCode: string; studentName: string; studentStatus: string; classId: string; className: string; classArm: string | null; enrolledOn: string; leftOn: string | null; active: boolean; }
interface RosterData { term: Term; roster: RosterRow[]; summary: { activeEnrollmentCount: number; activeStudentCount: number; noEnrollmentStudentCount: number; inactiveActiveEnrollmentCount: number; archivedClassActiveEnrollmentCount: number }; billingReadiness: { ready: boolean; activeEnrollmentCount?: number; activeAssignmentCount?: number; incompleteStudentIds?: string[]; blockedStudentIds?: string[]; missingKeyCount?: number; toIssueKobo?: number; error?: { code: string; message: string } | null }; }

const inputStyle: React.CSSProperties = { border: '1px solid var(--color-border)', background: 'var(--color-bg-page)', borderRadius: 7, padding: '8px 10px', fontSize: 13, width: '100%' };
const primaryStyle: React.CSSProperties = { border: 0, background: 'var(--color-forest)', color: 'white', borderRadius: 7, padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const secondaryStyle: React.CSSProperties = { border: '1px solid var(--color-border)', background: 'white', color: 'var(--color-text-primary)', borderRadius: 7, padding: '7px 10px', fontSize: 12, cursor: 'pointer' };

export default function AcademicWorkspace({ canManage }: { canManage: boolean }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [termId, setTermId] = useState('');
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sessionForm, setSessionForm] = useState({ name: '', startsOn: '', endsOn: '' });
  const [termForm, setTermForm] = useState({ sessionId: '', name: '', label: '', startsOn: '', endsOn: '', dueDate: '' });
  const [classForm, setClassForm] = useState({ name: '', arm: '' });
  const [studentForm, setStudentForm] = useState({ studentId: '', firstName: '', lastName: '', classId: '', enrolledOn: '' });
  const [enrollForm, setEnrollForm] = useState({ studentId: '', classId: '', enrolledOn: '' });

  const activeClasses = useMemo(() => classes.filter((row) => !row.deletedAt), [classes]);
  async function api(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    Object.entries(csrfHeaders()).forEach(([key, value]) => headers.set(key, value));
    if (!headers.has('idempotency-key') && init.method && init.method !== 'GET') headers.set('idempotency-key', `m9-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const response = await fetch(path, { ...init, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? 'The request could not be completed.');
    return data;
  }

  async function refresh() {
    const [sessionData, termData, classData, studentData] = await Promise.all([
      fetch('/api/academic-sessions', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/terms', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/classes?includeArchived=1', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/students', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setSessions(sessionData.sessions ?? []);
    setTerms(termData.terms ?? []);
    setClasses(classData.classes ?? []);
    setStudents(studentData.students ?? []);
    const requestedTermId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('termId') : null;
    const requestedTermExists = requestedTermId && (termData.terms ?? []).some((row: Term) => row.id === requestedTermId);
    setTermId((current) => (requestedTermExists ? requestedTermId! : current || (termData.terms ?? []).find((row: Term) => row.isCurrent)?.id || termData.terms?.[0]?.id || ''));
    setTermForm((current) => ({ ...current, sessionId: current.sessionId || sessionData.sessions?.find((row: Session) => row.isCurrent)?.id || sessionData.sessions?.[0]?.id || '' }));
  }

  async function loadRoster(id: string) {
    if (!id) { setRoster(null); return; }
    const response = await fetch(`/api/terms/${id}/roster`, { cache: 'no-store' });
    const data = await response.json();
    if (response.ok) setRoster(data);
    else setRoster(null);
  }

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  useEffect(() => { loadRoster(termId).catch((e) => setError(e.message)); }, [termId]);

  async function submit(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); await refresh(); if (termId) await loadRoster(termId); setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); }
    finally { setBusy(false); }
  }

  if (!canManage) {
    return <RosterReadOnly terms={terms} termId={termId} setTermId={setTermId} roster={roster} />;
  }

  return (
    <div className="space-y-4">
      {(notice || error) && <div className="rounded-md px-3 py-2 text-sm" style={{ background: error ? 'rgba(185,56,42,.08)' : 'var(--color-forest-tint)', color: error ? 'var(--color-danger,#a82a1c)' : 'var(--color-forest-deep)', border: `1px solid ${error ? 'rgba(185,56,42,.25)' : 'var(--color-border-subtle)'}` }}>{error || notice}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <SetupCard title="1. Academic session" description="Create the school year before adding terms.">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(async () => { await api('/api/academic-sessions', { method: 'POST', body: JSON.stringify(sessionForm) }); setSessionForm({ name: '', startsOn: '', endsOn: '' }); }, 'Academic session created.'); }}>
            <input required placeholder="2026/2027" value={sessionForm.name} onChange={(e) => setSessionForm({ ...sessionForm, name: e.target.value })} style={inputStyle} />
            <div className="grid grid-cols-2 gap-2"><input required type="date" value={sessionForm.startsOn} onChange={(e) => setSessionForm({ ...sessionForm, startsOn: e.target.value })} style={inputStyle} /><input type="date" value={sessionForm.endsOn} onChange={(e) => setSessionForm({ ...sessionForm, endsOn: e.target.value })} style={inputStyle} /></div>
            <button disabled={busy} style={primaryStyle}>Create planned session</button>
          </form>
          <div className="mt-3 space-y-1">{sessions.map((row) => <div key={row.id} className="flex items-center justify-between gap-2 text-xs"><span>{row.name}</span>{row.status === 'PLANNED' ? <button disabled={busy} style={secondaryStyle} onClick={() => void submit(async () => { await api(`/api/academic-sessions/${row.id}/activate`, { method: 'POST', body: '{}' }); }, 'Academic session activated.')}>Activate</button> : <span style={{ color: row.isCurrent ? 'var(--color-forest)' : 'var(--color-text-faint)' }}>{row.isCurrent ? 'Current' : row.status}</span>}</div>)}</div>
        </SetupCard>

        <SetupCard title="2. Terms" description="Create planned terms, then activate one current term.">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(async () => { await api('/api/terms', { method: 'POST', body: JSON.stringify(termForm) }); setTermForm({ ...termForm, name: '', label: '', startsOn: '', endsOn: '', dueDate: '' }); }, 'Term created.'); }}>
            <select required value={termForm.sessionId} onChange={(e) => setTermForm({ ...termForm, sessionId: e.target.value })} style={inputStyle}><option value="">Select session</option>{sessions.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
            <div className="grid grid-cols-2 gap-2"><input required placeholder="First Term" value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })} style={inputStyle} /><input required placeholder="1st" value={termForm.label} onChange={(e) => setTermForm({ ...termForm, label: e.target.value })} style={inputStyle} /></div>
            <div className="grid grid-cols-2 gap-2"><input required type="date" value={termForm.startsOn} onChange={(e) => setTermForm({ ...termForm, startsOn: e.target.value })} style={inputStyle} /><input type="date" value={termForm.endsOn} onChange={(e) => setTermForm({ ...termForm, endsOn: e.target.value })} style={inputStyle} /></div>
            <input type="date" value={termForm.dueDate} onChange={(e) => setTermForm({ ...termForm, dueDate: e.target.value })} style={inputStyle} />
            <button disabled={busy} style={primaryStyle}>Create planned term</button>
          </form>
          <div className="mt-3 space-y-1">{terms.map((row) => <div key={row.id} className="flex items-center justify-between gap-2 text-xs"><span>{row.name} · {row.status}</span>{row.status === 'PLANNED' ? <button disabled={busy} style={secondaryStyle} onClick={() => void submit(async () => { await api(`/api/terms/${row.id}/activate`, { method: 'POST', body: '{}' }); }, 'Term activated.')}>Activate</button> : row.isCurrent ? <span style={{ color: 'var(--color-forest)' }}>Current</span> : null}</div>)}</div>
        </SetupCard>

        <SetupCard title="3. Classes" description="Classes are reusable labels; enrollment is term-specific.">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(async () => { await api('/api/classes', { method: 'POST', body: JSON.stringify({ name: classForm.name, arm: classForm.arm || null, sortOrder: 0 }) }); setClassForm({ name: '', arm: '' }); }, 'Class created.'); }}>
            <input required placeholder="JSS 1" value={classForm.name} onChange={(e) => setClassForm({ ...classForm, name: e.target.value })} style={inputStyle} />
            <input placeholder="Arm (optional)" value={classForm.arm} onChange={(e) => setClassForm({ ...classForm, arm: e.target.value })} style={inputStyle} />
            <button disabled={busy} style={primaryStyle}>Create class</button>
          </form>
          <div className="mt-3 space-y-1">{classes.map((row) => <div key={row.id} className="flex items-center justify-between gap-2 text-xs"><span style={{ color: row.deletedAt ? 'var(--color-text-faint)' : 'var(--color-text-primary)' }}>{row.label}{row.deletedAt ? ' · Archived' : ''}</span>{row.deletedAt ? <button disabled={busy} style={secondaryStyle} onClick={() => void submit(async () => { await api(`/api/classes/${row.id}/restore`, { method: 'POST', body: '{}' }); }, 'Class restored.')}>Restore</button> : <button disabled={busy} style={secondaryStyle} onClick={() => void submit(async () => { await api(`/api/classes/${row.id}/archive`, { method: 'POST', body: '{}' }); }, 'Class archived.')}>Archive</button>}</div>)}</div>
        </SetupCard>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <SetupCard title="4. Admit and enroll" description="Student identity and term enrollment are separate data, created atomically here.">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(async () => { await api('/api/students', { method: 'POST', body: JSON.stringify({ studentId: studentForm.studentId, firstName: studentForm.firstName, lastName: studentForm.lastName, initialEnrollment: { termId, classId: studentForm.classId, enrolledOn: studentForm.enrolledOn } }) }); setStudentForm({ studentId: '', firstName: '', lastName: '', classId: '', enrolledOn: '' }); }, 'Student admitted and enrolled.'); }}>
            <div className="grid grid-cols-2 gap-2"><input required placeholder="Student ID" value={studentForm.studentId} onChange={(e) => setStudentForm({ ...studentForm, studentId: e.target.value })} style={inputStyle} /><input required placeholder="First name" value={studentForm.firstName} onChange={(e) => setStudentForm({ ...studentForm, firstName: e.target.value })} style={inputStyle} /></div>
            <input required placeholder="Last name" value={studentForm.lastName} onChange={(e) => setStudentForm({ ...studentForm, lastName: e.target.value })} style={inputStyle} />
            <select required value={studentForm.classId} onChange={(e) => setStudentForm({ ...studentForm, classId: e.target.value })} style={inputStyle}><option value="">Select class</option>{activeClasses.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select>
            <input required type="date" value={studentForm.enrolledOn} onChange={(e) => setStudentForm({ ...studentForm, enrolledOn: e.target.value })} style={inputStyle} />
            <button disabled={busy || !termId} style={primaryStyle}>Admit and enroll</button>
          </form>
        </SetupCard>

        <SetupCard title="Enroll existing student" description="Use this for a student already in the directory.">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(async () => { await api(`/api/terms/${termId}/enrollments`, { method: 'POST', body: JSON.stringify(enrollForm) }); setEnrollForm({ ...enrollForm, studentId: '' }); }, 'Student enrolled.'); }}>
            <select required value={enrollForm.studentId} onChange={(e) => setEnrollForm({ ...enrollForm, studentId: e.target.value })} style={inputStyle}><option value="">Select student</option>{students.filter((row) => row.status === 'ACTIVE').map((row) => <option key={row.id} value={row.id}>{row.name} · {row.studentId}</option>)}</select>
            <select required value={enrollForm.classId} onChange={(e) => setEnrollForm({ ...enrollForm, classId: e.target.value })} style={inputStyle}><option value="">Select class</option>{activeClasses.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select>
            <input required type="date" value={enrollForm.enrolledOn} onChange={(e) => setEnrollForm({ ...enrollForm, enrolledOn: e.target.value })} style={inputStyle} />
            <button disabled={busy || !termId} style={primaryStyle}>Enroll student</button>
          </form>
        </SetupCard>

        <RosterReadiness terms={terms} termId={termId} setTermId={setTermId} roster={roster} />
      </div>

      <RosterTable roster={roster} classes={activeClasses} canManage={canManage} busy={busy} onChange={async (id, classId) => { await submit(async () => { await api(`/api/enrollments/${id}`, { method: 'PATCH', body: JSON.stringify({ classId }) }); }, 'Enrollment transferred.'); }} onLeave={async (id) => { await submit(async () => { await api(`/api/enrollments/${id}/leave`, { method: 'POST', body: JSON.stringify({}) }); }, 'Enrollment closed.'); }} />
    </div>
  );
}

function SetupCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-lg border p-4" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-panel)' }}><h2 className="text-sm font-semibold" style={{ color: 'var(--color-forest-deepest)' }}>{title}</h2><p className="mt-1 mb-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{description}</p>{children}</section>;
}

function RosterReadOnly({ terms, termId, setTermId, roster }: { terms: Term[]; termId: string; setTermId: (v: string) => void; roster: RosterData | null }) {
  return <div className="space-y-4"><RosterReadiness terms={terms} termId={termId} setTermId={setTermId} roster={roster} /><RosterTable roster={roster} classes={[]} canManage={false} busy={false} onChange={async () => undefined} onLeave={async () => undefined} /></div>;
}

function RosterReadiness({ terms, termId, setTermId, roster }: { terms: Term[]; termId: string; setTermId: (v: string) => void; roster: RosterData | null }) {
  const readiness = roster?.billingReadiness;
  return <SetupCard title="Roster readiness" description="The selected term is the handoff into M8 controlled billing."><select value={termId} onChange={(e) => setTermId(e.target.value)} style={inputStyle}><option value="">Select term</option>{terms.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.status}{row.isCurrent ? ' · Current' : ''}</option>)}</select>{roster && <div className="mt-3 space-y-1 text-xs"><div>Active enrollment: <strong>{roster.summary.activeEnrollmentCount}</strong></div><div>Students without enrollment: <strong>{roster.summary.noEnrollmentStudentCount}</strong></div><div>Billing state: <strong style={{ color: readiness?.ready ? 'var(--color-forest)' : 'var(--color-gold-dark,#8a6b11)' }}>{readiness?.ready ? 'Ready for review' : 'Needs attention'}</strong></div>{readiness?.error && <div style={{ color: 'var(--color-danger,#a82a1c)' }}>{readiness.error.message}</div>}{readiness && !readiness.error && <div>Fee keys to issue: <strong>{readiness.missingKeyCount ?? 0}</strong></div>}{termId && <div className="mt-3 flex flex-wrap gap-3 border-t pt-3" style={{ borderColor: 'var(--color-border-subtle)' }}><Link href="/settings/fees" className="font-medium underline" style={{ color: 'var(--color-forest)' }}>Open M8 fee setup</Link><Link href={`/terms/${termId}/bill`} className="font-medium underline" style={{ color: 'var(--color-forest)' }}>Review controlled billing</Link></div>}</div>}</SetupCard>;
}

function RosterTable({ roster, classes, canManage, busy, onChange, onLeave }: { roster: RosterData | null; classes: SchoolClass[]; canManage: boolean; busy: boolean; onChange: (id: string, classId: string) => Promise<void>; onLeave: (id: string) => Promise<void> }) {
  if (!roster) return <section className="rounded-lg border p-6 text-sm" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-faint)' }}>Select a term to inspect its roster.</section>;
  return <section className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-panel)' }}><div className="px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}><h2 className="text-sm font-semibold">{roster.term.name} roster</h2><p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>{roster.roster.filter((row) => row.active).length} active enrollment(s); class changes are restricted after billing.</p></div>{roster.roster.length === 0 ? <div className="p-6 text-sm" style={{ color: 'var(--color-text-faint)' }}>No enrollment rows yet.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}><th className="px-4 py-2 text-left text-xs">Student</th><th className="px-3 py-2 text-left text-xs">Class</th><th className="px-3 py-2 text-left text-xs">State</th><th className="px-3 py-2"></th></tr></thead><tbody>{roster.roster.map((row) => <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}><td className="px-4 py-3"><div className="font-medium">{row.studentName}</div><div className="text-xs" style={{ color: 'var(--color-text-faint)' }}>{row.studentCode}</div></td><td className="px-3 py-3">{canManage && row.active ? <select disabled={busy || roster.term.status !== 'ACTIVE'} value={row.classId} onChange={(e) => void onChange(row.id, e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>{classes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : row.classArm ? `${row.className} ${row.classArm}` : row.className}</td><td className="px-3 py-3 text-xs" style={{ color: row.active ? 'var(--color-forest)' : 'var(--color-text-faint)' }}>{row.active ? 'Active' : `Left ${row.leftOn}`}</td><td className="px-3 py-3 text-right">{canManage && row.active && <button disabled={busy || roster.term.status === 'CLOSED'} style={secondaryStyle} onClick={() => void onLeave(row.id)}>Record leave</button>}</td></tr>)}</tbody></table></div>}</section>;
}
