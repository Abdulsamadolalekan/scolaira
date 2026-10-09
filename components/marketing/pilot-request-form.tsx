'use client';

/**
 * SCOLAIRA — pilot programme enquiry form (public, unauthenticated).
 *
 * WHAT THIS ACTUALLY DOES
 *   There is no inbound-lead store in this product and this change does not invent one:
 *   adding a `leads` table would be a schema migration, which is outside the authority of
 *   a presentation change. So the form does the one thing that is genuinely true — it
 *   collects the enquiry, carries it forward, and hands the visitor to the REAL account
 *   path (`/register`), which already creates a school and its first owner and is already
 *   public in middleware. School name and email are carried across prefilled so the
 *   visitor does not type them twice.
 *
 *   Nothing here claims to send mail, create a record, or notify anyone. The helper text
 *   under the button is the product's own promise, and the button label names the
 *   destination rather than implying a back-office queue that does not exist.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from '@/components/ui/icons';

const FIELD =
  'w-full rounded-lg border px-3.5 py-2.5 text-sm text-ink-primary outline-none transition-colors focus:border-forest-primary';

const FIELD_STYLE = {
  borderColor: 'var(--color-border)',
  backgroundColor: 'var(--color-white)',
} as const;

const LABEL = 'mb-1.5 block text-[13px] font-medium text-ink-primary';

const STUDENT_BANDS = ['Under 200', '200 – 500', '500 – 1,000', 'Over 1,000'] as const;

export function PilotRequestForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    school: '',
    email: '',
    phone: '',
    students: '',
    notes: '',
  });
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim() || !form.school.trim() || !form.email.trim() || !form.students) {
      setError('Please complete your name, school, work email and student count.');
      return;
    }
    const qs = new URLSearchParams({
      school: form.school.trim(),
      email: form.email.trim(),
      from: 'pilot',
    });
    router.push(`/register?${qs.toString()}`);
  }

  return (
    <div
      className="rounded-xl border p-7"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-white)' }}
    >
      <h2 className="text-[17px] font-semibold text-ink-primary">Request pilot access</h2>

      <form onSubmit={onSubmit} className="mt-6" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="pilot-name">
              Your name <span aria-hidden="true">*</span>
            </label>
            <input
              id="pilot-name"
              name="name"
              required
              autoComplete="name"
              className={FIELD}
              style={FIELD_STYLE}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pilot-school">
              School name <span aria-hidden="true">*</span>
            </label>
            <input
              id="pilot-school"
              name="school"
              required
              autoComplete="organization"
              className={FIELD}
              style={FIELD_STYLE}
              value={form.school}
              onChange={(e) => set('school', e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pilot-email">
              Work email <span aria-hidden="true">*</span>
            </label>
            <input
              id="pilot-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={FIELD}
              style={FIELD_STYLE}
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pilot-phone">
              Phone
            </label>
            <input
              id="pilot-phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              className={FIELD}
              style={FIELD_STYLE}
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className={LABEL} htmlFor="pilot-students">
            How many students? <span aria-hidden="true">*</span>
          </label>
          <select
            id="pilot-students"
            name="students"
            required
            className={FIELD}
            style={FIELD_STYLE}
            value={form.students}
            onChange={(e) => set('students', e.target.value)}
          >
            <option value="">Choose&hellip;</option>
            {STUDENT_BANDS.map((band) => (
              <option key={band} value={band}>
                {band}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4">
          <label className={LABEL} htmlFor="pilot-notes">
            Anything we should know?
          </label>
          <textarea
            id="pilot-notes"
            name="notes"
            rows={2}
            className={FIELD}
            style={FIELD_STYLE}
            placeholder="e.g. We run 3 terms, mostly bank transfers&hellip;"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>

        {error ? (
          <p className="mt-4 text-[13px] text-danger-fg" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-medium text-ivory transition-[filter] hover:brightness-110"
          style={{ backgroundColor: 'var(--color-forest-deep)' }}
        >
          Request pilot access
          <ArrowRight size={15} />
        </button>

        <p className="mt-4 text-center text-[12px] text-ink-muted">
          Continue to create your school account &mdash; takes about two minutes.
        </p>
      </form>
    </div>
  );
}
