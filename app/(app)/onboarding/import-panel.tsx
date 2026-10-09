'use client';
/**
 * CSV student import — upload, review, confirm.
 *
 * WHY THE THREE-STEP SHAPE
 *   A school is about to add hundreds of children to the roll it bills from. The
 *   interface therefore never imports on upload: the file is validated first, the
 *   school reads what will happen, and only then does a separate, explicit
 *   confirmation write anything. The plan the school approves is fingerprinted,
 *   and the server refuses to import if the file or the roll changed in between —
 *   so "review then confirm" is a guarantee, not a courtesy.
 *
 * WHAT THE SCHOOL IS TOLD, AND WHERE
 *   - Errors: what is wrong, on which LINE, in which COLUMN, and how to fix it.
 *     Errors block the import. There is no "import anyway".
 *   - Warnings: things that are probably fine but worth a look — an ambiguous
 *     date read day-first, a phone number that could not be dialled and was NOT
 *     imported, a possible duplicate. Warnings do not block; they inform.
 *   - Column mapping: which of the school's columns was used for what, and which
 *     were not recognised. Nothing is dropped quietly.
 *
 * FAILURE BEHAVIOUR
 *   The commit button disables while in flight and carries an Idempotency-Key, so
 *   a slow connection cannot produce two imports of the same file. If the commit
 *   fails, the review is still on screen and the message says plainly that
 *   nothing was imported — which is true, because the whole import is one
 *   transaction.
 */
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label, Select } from '@/components/ui/input';
import { csrfHeaders } from '@/lib/ui/csrf';
import { AlertTriangle, AlertCircle, Info, FileText } from '@/components/ui/icons';

interface Issue {
  severity: 'ERROR' | 'WARNING';
  line: number;
  code: string;
  column?: string;
  message: string;
}

interface PlanRow {
  line: number;
  studentId: string;
  firstName: string;
  lastName: string;
  gender: string | null;
  dateOfBirth: string | null;
  className: string | null;
  guardian: {
    firstName: string;
    lastName: string;
    phone: string | null;
    isPrimary: boolean;
  } | null;
}

interface Summary {
  totalRows: number;
  blankRows: number;
  importable: number;
  rowsWithErrors: number;
  rowsWithWarnings: number;
  guardiansToCreate: number;
  enrollmentsToCreate: number;
  studentsWithoutClass: number;
  unrecognisedColumns: string[];
  matchedColumns: Record<string, string>;
  notes: string[];
  planHash: string;
}

interface ValidateResponse {
  plan: { rows: PlanRow[]; issues: Issue[]; summary: Summary };
  canCommit: boolean;
  errorReportCsv: string | null;
  term: { id: string; name: string; startsOn: string } | null;
  classes: Array<{ id: string; label: string }>;
}

type Phase = 'idle' | 'checking' | 'review' | 'importing' | 'done';

const FIELD_LABELS: Record<string, string> = {
  studentId: 'Admission number',
  firstName: 'First name',
  lastName: 'Last name',
  middleName: 'Middle name',
  gender: 'Gender',
  dateOfBirth: 'Date of birth',
  admissionDate: 'Admission date',
  className: 'Class',
  guardianName: 'Guardian name',
  guardianFirstName: 'Guardian first name',
  guardianLastName: 'Guardian last name',
  guardianPhone: 'Guardian phone',
  guardianEmail: 'Guardian email',
  relationship: 'Relationship',
  primary: 'Primary guardian',
};

export default function ImportPanel({
  terms,
  initialTermId,
}: {
  terms: Array<{ id: string; name: string; label: string; status: string; startsOn: string }>;
  initialTermId: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [termId, setTermId] = useState<string>(initialTermId ?? terms[0]?.id ?? '');
  const [result, setResult] = useState<ValidateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{
    students: number;
    guardians: number;
    enrollments: number;
  } | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);

  const activeTerm = terms.find((t) => t.id === termId) ?? null;

  const { errors, warnings } = useMemo(() => {
    const issues = result?.plan.issues ?? [];
    return {
      errors: issues.filter((i) => i.severity === 'ERROR'),
      warnings: issues.filter((i) => i.severity === 'WARNING'),
    };
  }, [result]);

  async function onFile(file: File) {
    setError(null);
    setResult(null);
    setImported(null);
    if (file.size > 2_000_000) {
      setError('That file is larger than 2 MB. Split the list and import it in parts.');
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    if (termId) await check(text, termId);
    else setPhase('idle');
  }

  async function check(text: string, term: string) {
    setPhase('checking');
    setError(null);
    try {
      const res = await fetch('/api/onboarding/students/import/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ csv: text, termId: term }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message ?? 'The file could not be checked.');
        setPhase('idle');
        return;
      }
      setResult(data as ValidateResponse);
      setPhase('review');
    } catch {
      setError('Network error. The file was not checked and nothing was imported.');
      setPhase('idle');
    }
  }

  async function onConfirm() {
    if (!result || !csv) return;
    setPhase('importing');
    setError(null);
    try {
      const res = await fetch('/api/onboarding/students/import/commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...csrfHeaders(),
        },
        body: JSON.stringify({
          csv,
          termId,
          planHash: result.plan.summary.planHash,
          acknowledgedWarnings: warnings.length > 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message ?? 'The import did not complete. Nothing was imported.');
        setPhase('review');
        return;
      }
      setImported(data.imported);
      setPhase('done');
      router.refresh();
    } catch {
      setError('Network error. Nothing was imported — the whole import is one transaction.');
      setPhase('review');
    }
  }

  function reset() {
    setPhase('idle');
    setResult(null);
    setCsv(null);
    setFileName(null);
    setError(null);
    setImported(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function downloadErrors() {
    if (!result?.errorReportCsv) return;
    const blob = new Blob([result.errorReportCsv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Done ────────────────────────────────────────────────────────────────
  if (phase === 'done' && imported) {
    return (
      <div className="px-5 py-6">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm"
            style={{ backgroundColor: 'var(--color-forest-deep)', color: '#fff' }}
            aria-hidden
          >
            <Info size={14} />
          </span>
          <div>
            <p className="text-[15px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {imported.students} student{imported.students === 1 ? '' : 's'} imported
            </p>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
              {imported.enrollments} enrolled into a class
              {imported.guardians > 0
                ? `, ${imported.guardians} guardian${imported.guardians === 1 ? '' : 's'} recorded`
                : ''}
              . No invoices or charges were created — billing is a separate step.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => router.push('/students')}
              >
                View students
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={reset}>
                Import another file
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The preview is shown twice — a ruled table from md upward, a stacked list
  // below it (the same treatment the student roll uses) — so the row cap is
  // computed once rather than written in two places.
  const previewRows = !result ? [] : showAllRows ? result.plan.rows : result.plan.rows.slice(0, 12);

  return (
    <div className="px-5 py-5">
      {/* ── Step 1: the file ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <Label htmlFor="import-term">Enrol into term</Label>
          <Select
            id="import-term"
            value={termId}
            disabled={terms.length === 0 || phase === 'importing'}
            onChange={(e) => {
              setTermId(e.target.value);
              if (csv) void check(csv, e.target.value);
            }}
          >
            {terms.length === 0 && <option value="">No term yet</option>}
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.label}) · {t.status.toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="import-file">CSV file</Label>
          <input
            ref={fileRef}
            id="import-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            disabled={phase === 'importing'}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
            className="block w-full text-[13px] file:mr-3 file:cursor-pointer file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[12px] file:font-medium"
            style={{ color: 'var(--color-text-secondary)', borderColor: 'var(--color-border)' }}
          />
        </div>
        {fileName && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!csv || phase === 'importing' || !termId}
            onClick={() => csv && void check(csv, termId)}
          >
            {phase === 'checking' ? 'Checking…' : 'Check file again'}
          </Button>
        )}
      </div>

      {activeTerm && activeTerm.status !== 'ACTIVE' && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
          {activeTerm.name} is {activeTerm.status.toLowerCase()}. Activate it before importing, or
          students cannot be enrolled.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-sm border px-3 py-2 text-[12px]"
          style={{
            borderColor: 'rgba(168,42,28,.28)',
            backgroundColor: 'rgba(168,42,28,.06)',
            color: 'var(--color-danger,#a82a1c)',
          }}
        >
          {error}
        </div>
      )}

      {phase === 'checking' && (
        <p className="mt-4 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
          Checking {fileName} against your classes and your roll…
        </p>
      )}

      {/* ── Step 2: the review ──────────────────────────────────────────── */}
      {phase !== 'checking' && result && (
        <div className="mt-5">
          <div
            className="rounded-sm border p-4"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--color-bg-page)',
            }}
          >
            <p className="text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {result.plan.summary.importable} student
              {result.plan.summary.importable === 1 ? '' : 's'} ready to import
              {result.plan.summary.blankRows > 0
                ? ` · ${result.plan.summary.blankRows} blank row${result.plan.summary.blankRows === 1 ? '' : 's'} skipped`
                : ''}
              {result.plan.summary.rowsWithErrors > 0
                ? ` · ${result.plan.summary.rowsWithErrors} row${result.plan.summary.rowsWithErrors === 1 ? '' : 's'} blocked`
                : ''}
            </p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
              {result.plan.summary.enrollmentsToCreate} class enrollment
              {result.plan.summary.enrollmentsToCreate === 1 ? '' : 's'} ·{' '}
              {result.plan.summary.guardiansToCreate} guardian
              {result.plan.summary.guardiansToCreate === 1 ? '' : 's'} · no invoices or charges will
              be created
            </p>
            {result.plan.summary.notes.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {result.plan.summary.notes.map((note) => (
                  <li
                    key={note}
                    className="text-[12px]"
                    style={{ color: 'var(--color-text-faint)' }}
                  >
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Column mapping — nothing is dropped quietly. */}
          <details className="mt-3">
            <summary
              className="cursor-pointer text-[12px] font-medium"
              style={{ color: 'var(--color-forest)' }}
            >
              Column mapping ({Object.keys(result.plan.summary.matchedColumns).length} matched
              {result.plan.summary.unrecognisedColumns.length > 0
                ? `, ${result.plan.summary.unrecognisedColumns.length} not used`
                : ''}
              )
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {Object.entries(result.plan.summary.matchedColumns).map(([field, header]) => (
                <div key={field} className="flex items-baseline gap-2 text-[12px]">
                  <span style={{ color: 'var(--color-text-faint)' }}>
                    {FIELD_LABELS[field] ?? field}
                  </span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>← “{header}”</span>
                </div>
              ))}
            </div>
            {result.plan.summary.unrecognisedColumns.length > 0 && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                Not imported:{' '}
                {result.plan.summary.unrecognisedColumns.map((c) => `“${c}”`).join(', ')}
              </p>
            )}
          </details>

          {/* Errors — these block. */}
          {errors.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <p
                  className="text-[13px] font-medium"
                  style={{ color: 'var(--color-danger,#a82a1c)' }}
                >
                  <AlertCircle size={13} className="mr-1 inline align-[-2px]" />
                  {errors.length} problem{errors.length === 1 ? '' : 's'} must be fixed before
                  importing
                </p>
                <Button type="button" variant="secondary" size="sm" onClick={downloadErrors}>
                  Download problem list
                </Button>
              </div>
              <IssueList issues={errors} />
            </div>
          )}

          {/* Warnings — these inform. */}
          {warnings.length > 0 && (
            <div className="mt-4">
              <p
                className="text-[13px] font-medium"
                style={{ color: 'var(--color-gold-dark,#8a6b11)' }}
              >
                <AlertTriangle size={13} className="mr-1 inline align-[-2px]" />
                {warnings.length} thing{warnings.length === 1 ? '' : 's'} worth checking — these do
                not block the import
              </p>
              <IssueList issues={warnings} />
            </div>
          )}

          {/* The row preview — what will actually be created. */}
          {result.plan.rows.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <p
                  className="text-[13px] font-medium"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Students to be created
                </p>
                {result.plan.rows.length > 12 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllRows((v) => !v)}
                  >
                    {showAllRows ? 'Show first 12' : `Show all ${result.plan.rows.length}`}
                  </Button>
                )}
              </div>
              {/*
                From md upward the preview is a ruled table. Below md the same
                rows stack into a list, because a five-column table squeezed into
                390px clips the guardian and the admission number — and a review
                whose numbers you cannot read is not a review. This mirrors the
                student roll, which makes the same choice for the same reason.
              */}
              <div className="mt-2 hidden overflow-x-auto md:block">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      <Th>Line</Th>
                      <Th>Admission no</Th>
                      <Th>Student</Th>
                      <Th>Class</Th>
                      <Th>Guardian</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row) => {
                      const rowIssues = warnings.filter((w) => w.line === row.line);
                      return (
                        <tr
                          key={row.line}
                          style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                        >
                          <td
                            className="px-2 py-2 tabular-nums"
                            style={{ color: 'var(--color-text-faint)' }}
                          >
                            {row.line}
                          </td>
                          <td className="px-2 py-2 tabular-nums">{row.studentId}</td>
                          <td className="px-2 py-2">
                            {row.firstName} {row.lastName}
                          </td>
                          <td
                            className="px-2 py-2"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {row.className ?? '—'}
                          </td>
                          <td
                            className="px-2 py-2"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {row.guardian ? (
                              <>
                                {row.guardian.firstName} {row.guardian.lastName}
                                {row.guardian.phone ? ` · ${row.guardian.phone}` : ''}
                              </>
                            ) : (
                              <span style={{ color: 'var(--color-text-faint)' }}>None</span>
                            )}
                            {rowIssues.length > 0 && (
                              <span className="ml-2">
                                <Badge variant="warning">Check</Badge>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul
                className="mt-2 divide-y md:hidden"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                {previewRows.map((row) => {
                  const rowIssues = warnings.filter((w) => w.line === row.line);
                  return (
                    <li key={row.line} className="py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--color-text-primary)' }}
                          >
                            {row.firstName} {row.lastName}
                          </div>
                          <div
                            className="mt-0.5 text-[11px] tabular-nums"
                            style={{ color: 'var(--color-text-faint)' }}
                          >
                            Line {row.line} · {row.studentId}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className="text-[12px]"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {row.className ?? '—'}
                          </div>
                          <div
                            className="mt-0.5 text-[11px]"
                            style={{ color: 'var(--color-text-faint)' }}
                          >
                            {row.guardian
                              ? `${row.guardian.firstName} ${row.guardian.lastName}`
                              : 'No guardian'}
                          </div>
                          {row.guardian?.phone ? (
                            <div
                              className="text-[11px] tabular-nums"
                              style={{ color: 'var(--color-text-faint)' }}
                            >
                              {row.guardian.phone}
                            </div>
                          ) : null}
                          {rowIssues.length > 0 && (
                            <div className="mt-1 flex justify-end">
                              <Badge variant="warning">Check</Badge>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* ── Step 3: the confirmation ─────────────────────────────────── */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={!result.canCommit || phase === 'importing'}
              onClick={onConfirm}
            >
              {phase === 'importing'
                ? 'Importing…'
                : `Import ${result.plan.summary.importable} student${
                    result.plan.summary.importable === 1 ? '' : 's'
                  }`}
            </Button>
            <Button type="button" variant="ghost" disabled={phase === 'importing'} onClick={reset}>
              Cancel
            </Button>
            {!result.canCommit && (
              <span className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                Fix the problems above, then upload the corrected file.
              </span>
            )}
          </div>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
            <FileText size={12} className="mr-1 inline align-[-2px]" />
            Importing creates students and class enrollments only. It does not create invoices,
            payments or receipts. If anything goes wrong, nothing is imported at all.
          </p>
        </div>
      )}
    </div>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? issues : issues.slice(0, 8);
  return (
    <>
      <ul className="mt-2 space-y-1.5">
        {shown.map((issue, i) => (
          <li
            key={`${issue.line}-${issue.code}-${i}`}
            className="rounded-sm border px-3 py-2 text-[12px]"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <span className="tabular-nums" style={{ color: 'var(--color-text-faint)' }}>
              {issue.line === 1 ? 'File' : `Line ${issue.line}`}
              {issue.column ? ` · ${issue.column}` : ''}
            </span>
            <span className="ml-2" style={{ color: 'var(--color-text-secondary)' }}>
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
      {issues.length > 8 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show fewer' : `Show all ${issues.length}`}
        </Button>
      )}
    </>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider"
      style={{ color: 'var(--color-text-faint)' }}
    >
      {children}
    </th>
  );
}
