import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import {} from '@/components/ui/icons';
import BillPreview from './bill-preview';
import { Crumb, PageContainer, PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

export default async function TermBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = await checkPermission('term.read');
  if (!review.allowed)
    return (
      <AccessDenied
        surface="Term billing preview"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const finalizer = await checkPermission('term.bill');

  return (
    <PageContainer width="wide">
      <PageHeader
        breadcrumbs={
          <Crumb parent="Fee structure" parentHref="/settings/fees" trail="Term billing" />
        }
        title="Controlled term billing"
        lede="Review exactly who will be billed, why each fee applies, which exceptions need attention, and what the school will be owed before invoices exist."
      />
      <BillPreview termId={id} canBill={finalizer.allowed} />
      <Card className="mt-4">
        <CardHeader
          title="What Issue does"
          description="Issue locks the term, creates the invoices and applies any concessions already granted, then marks the term billed. All of it happens in one step, or none of it does."
        />
      </Card>
    </PageContainer>
  );
}
