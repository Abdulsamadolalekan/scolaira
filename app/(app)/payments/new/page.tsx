import { headers } from 'next/headers';
import Link from 'next/link';
import RecordPaymentForm from './record-payment-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };
type InvoiceOpt = { id: string; invoiceNumber: string; studentId: string; studentName: string; totalKobo: number; paidKobo: number; remainingKobo: number; status: string; };

async function load(presetStudentId?: string): Promise<{
  students: StudentOpt[];
  invoices: InvoiceOpt[];
  presetStudentId?: string;
  studentsTruncated: boolean;
  invoicesTruncated: boolean;
}> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return { students: [], invoices: [], studentsTruncated: false, invoicesTruncated: false };
  // H-2: both pick-lists are capped surfaces. Ask for the declared cap on each
  // and report truncation, so an incomplete allocation list is never presented
  // as if it were the whole book.
  const [s, i] = await Promise.all([
    fetch(`${proto}://${host}/api/students?limit=1000`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({students:[]})),
    fetch(`${proto}://${host}/api/invoices?limit=200`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({invoices:[]})),
  ]);
  const studentsTruncated = Boolean(s?.page?.hasMore) || (s?.page?.total ?? 0) > (s?.students?.length ?? 0);
  const invoicesTruncated = Boolean(i?.page?.hasMore) || (i?.page?.total ?? 0) > (i?.invoices?.length ?? 0);
  return {
    students: s.students ?? [],
    invoices: (i.invoices ?? []).filter((x:any)=>x.status!=='VOID' && x.remainingKobo>0),
    presetStudentId,
    studentsTruncated,
    invoicesTruncated,
  };
}

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<{ studentId?: string }> }) {
  const g = await checkPermission('payment.record');
  if (!g.allowed) return <AccessDenied surface="Record payment" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const sp = await searchParams;
  const { students, invoices, presetStudentId, studentsTruncated, invoicesTruncated } = await load(sp.studentId);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/payments" className="inline-flex items-center gap-1 text-[13px] mb-4" style={{color:'var(--color-text-secondary)'}}>← Payments</Link>
      <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Record payment</h1>
      <p className="mt-1 text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
        Log a payment received from a parent. Allocate it to one or more outstanding invoices. Any surplus is held as unallocated credit on the payment.
      </p>
      {(studentsTruncated || invoicesTruncated) && (
        <p className="mb-4 rounded-md border px-3 py-2 text-[12.5px]"
           style={{ borderColor: 'var(--color-gold)', backgroundColor: 'var(--color-gold-tint,#fbf1d1)', color: 'var(--color-gold-dark,#8a6b11)' }}>
          {invoicesTruncated
            ? 'Showing the 200 most recent invoices. Record the payment now and allocate it to older invoices from the payment page afterwards.'
            : 'Showing the first 1000 students on this account.'}
        </p>
      )}
      <RecordPaymentForm students={students} invoices={invoices} presetStudentId={presetStudentId} />
    </div>
  );
}
