import { headers } from 'next/headers';
import NewInvoiceForm from './new-invoice-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import { PageContainer, PageHeader, Crumb } from '@/components/ui/page-header';

export const runtime = 'nodejs';

type TermOpt = { id: string; name: string; label: string; isCurrent: boolean };
type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };

async function loadOpts(): Promise<{
  terms: TermOpt[];
  students: StudentOpt[];
  presetStudentId?: string;
  studentsTruncated: boolean;
}> {
  const h = await headers();
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  // The referer is the PUBLIC url the browser used, so it deliberately stays
  // inbound-derived: it carries the user's own query string (`?studentId=`),
  // which an internal origin has no way to know.
  const inboundHost = h.get('x-forwarded-host') || h.get('host');
  const inboundProto = h.get('x-forwarded-proto') ?? 'http';
  const url = new URL(
    h.get('referer') ?? `${inboundProto}://${inboundHost}/`,
    `${inboundProto}://${inboundHost}`,
  );
  const preset = url.searchParams.get('studentId') ?? undefined;
  if (!base) return { terms: [], students: [], studentsTruncated: false };
  // H-2: `/api/students` is a capped surface (200 default / 1000 cap). Request
  // the declared cap and surface a truncation notice rather than quietly
  // offering a partial pick-list.
  const [t, s] = await Promise.all([
    fetch(`${base}/api/terms`, { cache: 'no-store', headers: { cookie } })
      .then((r) => r.json())
      .catch(() => ({ terms: [] })),
    fetch(`${base}/api/students?limit=1000`, { cache: 'no-store', headers: { cookie } })
      .then((r) => r.json())
      .catch(() => ({ students: [] })),
  ]);
  const studentsTruncated =
    Boolean(s?.page?.hasMore) || (s?.page?.total ?? 0) > (s?.students?.length ?? 0);
  return {
    terms: t.terms ?? [],
    students: s.students ?? [],
    presetStudentId: preset,
    studentsTruncated,
  };
}

export default async function NewInvoicePage() {
  const g = await checkPermission('invoice.create');
  if (!g.allowed)
    return (
      <AccessDenied
        surface="New invoice"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const { terms, students, presetStudentId, studentsTruncated } = await loadOpts();
  return (
    <PageContainer width="narrow">
      <PageHeader
        breadcrumbs={<Crumb parent="Invoices" parentHref="/invoices" trail="New invoice" />}
        title="New invoice"
        lede="Issue an invoice to a student for the current term. On save it is issued and appears in the register."
      />
      {studentsTruncated && (
        <p
          className="mb-4 rounded-sm border px-3 py-2 text-[12.5px]"
          style={{
            borderColor: 'var(--color-gold)',
            backgroundColor: 'var(--color-gold-tint,#fbf1d1)',
            color: 'var(--color-gold-dark,#8a6b11)',
          }}
        >
          Showing the first 1000 students on this account. If a student is missing here, issue the
          invoice from that student&apos;s page instead.
        </p>
      )}
      <NewInvoiceForm terms={terms} students={students} presetStudentId={presetStudentId} />
    </PageContainer>
  );
}
