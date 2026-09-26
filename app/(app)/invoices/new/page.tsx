import { headers } from 'next/headers';
import Link from 'next/link';
import NewInvoiceForm from './new-invoice-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type TermOpt = { id: string; name: string; label: string; isCurrent: boolean };
type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };

async function loadOpts(): Promise<{ terms: TermOpt[]; students: StudentOpt[]; presetStudentId?: string; studentsTruncated: boolean }> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  const url = new URL(h.get('referer') ?? `${proto}://${host}/`, `${proto}://${host}`);
  const preset = url.searchParams.get('studentId') ?? undefined;
  if (!host) return { terms: [], students: [], studentsTruncated: false };
  // H-2: `/api/students` is a capped surface (200 default / 1000 cap). Request
  // the declared cap and surface a truncation notice rather than quietly
  // offering a partial pick-list.
  const [t, s] = await Promise.all([
    fetch(`${proto}://${host}/api/terms`, { cache: 'no-store', headers: { cookie } }).then(r => r.json()).catch(() => ({ terms: [] })),
    fetch(`${proto}://${host}/api/students?limit=1000`, { cache: 'no-store', headers: { cookie } }).then(r => r.json()).catch(() => ({ students: [] })),
  ]);
  const studentsTruncated = Boolean(s?.page?.hasMore) || (s?.page?.total ?? 0) > (s?.students?.length ?? 0);
  return { terms: t.terms ?? [], students: s.students ?? [], presetStudentId: preset, studentsTruncated };
}

export default async function NewInvoicePage() {
  const g = await checkPermission('invoice.create');
  if (!g.allowed) return <AccessDenied surface="New invoice" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const { terms, students, presetStudentId, studentsTruncated } = await loadOpts();
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/invoices" className="inline-flex items-center gap-1 text-[13px] mb-4" style={{color:'var(--color-text-secondary)'}}>← Invoices</Link>
      <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>New invoice</h1>
      <p className="mt-1 text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
        Issue an invoice to a student for the current term. On save the invoice will be issued and available in the register.
      </p>
      {studentsTruncated && (
        <p className="mb-4 rounded-md border px-3 py-2 text-[12.5px]"
           style={{ borderColor: 'var(--color-gold)', backgroundColor: 'var(--color-gold-tint,#fbf1d1)', color: 'var(--color-gold-dark,#8a6b11)' }}>
          Showing the first 1000 students on this account. If a student is missing here, issue the invoice from that student&apos;s page instead.
        </p>
      )}
      <NewInvoiceForm terms={terms} students={students} presetStudentId={presetStudentId} />
    </div>
  );
}
