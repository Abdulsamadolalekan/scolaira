import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { ArrowLeft } from '@/components/ui/icons';
import Link from 'next/link';
import BillPreview from './bill-preview';

export const runtime = 'nodejs';

export default async function TermBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = await checkPermission('term.read');
  if (!review.allowed) return <AccessDenied surface="Term billing preview" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const finalizer = await checkPermission('term.bill');

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-5"><Link href="/settings/fees" className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}><ArrowLeft size={12} /> Fee structure</Link></div>
      <div className="mb-6"><h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Controlled term billing</h1><p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--color-text-secondary)' }}>Review exactly who will be billed, why each fee applies, which exceptions need attention, and what the school will be owed before invoices exist.</p></div>
      <BillPreview termId={id} canBill={finalizer.allowed} />
      <Card className="mt-4"><CardHeader title="What Issue does" description="The server locks the term, creates ordinary draft invoices and lines, applies immutable concessions, issues through the existing state machine, proves cohort completeness, then marks the term BILLED in the same transaction." /></Card>
    </div>
  );
}
