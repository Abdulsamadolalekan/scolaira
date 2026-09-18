import { headers } from 'next/headers';
import Link from 'next/link';
import RecordPaymentForm from './record-payment-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type StudentOpt = { id: string; studentId: string; name: string; outstandingKobo: number };
type InvoiceOpt = { id: string; invoiceNumber: string; studentId: string; studentName: string; totalKobo: number; paidKobo: number; remainingKobo: number; status: string; };

async function load(presetStudentId?: string): Promise<{ students: StudentOpt[]; invoices: InvoiceOpt[]; presetStudentId?: string }> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return { students: [], invoices: [] };
  const [s, i] = await Promise.all([
    fetch(`${proto}://${host}/api/students`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({students:[]})),
    fetch(`${proto}://${host}/api/invoices`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({invoices:[]})),
  ]);
  return { students: s.students ?? [], invoices: (i.invoices ?? []).filter((x:any)=>x.status!=='VOID' && x.remainingKobo>0), presetStudentId };
}

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<{ studentId?: string }> }) {
  const g = await checkPermission('payment.record');
  if (!g.allowed) return <AccessDenied surface="Record payment" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const sp = await searchParams;
  const { students, invoices, presetStudentId } = await load(sp.studentId);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link href="/payments" className="inline-flex items-center gap-1 text-[13px] mb-4" style={{color:'var(--color-text-secondary)'}}>← Payments</Link>
      <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Record payment</h1>
      <p className="mt-1 text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
        Log a payment received from a parent. Allocate it to one or more outstanding invoices. Any surplus is held as unallocated credit on the payment.
      </p>
      <RecordPaymentForm students={students} invoices={invoices} presetStudentId={presetStudentId} />
    </div>
  );
}
