import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Settings } from '@/components/ui/icons';
import FeeSetup from './fee-setup';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

export default async function FeeStructurePage() {
  const guard = await checkPermission('fee_definition.manage');
  if (!guard.allowed)
    return (
      <AccessDenied
        surface="Fee structure"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Fee structure"
        lede="The fees this school charges, and the term assignments that billing turns into invoices."
      />
      <FeeSetup />
      <Card className="mt-4">
        <CardHeader
          title="A controlled financial boundary"
          description="Saving a fee structure does not create an obligation. The review screen shows the enrolled population, exceptions, and totals before an OWNER or FINANCE_OFFICER can issue invoices."
        />
        <div
          className="flex items-center gap-3 px-5 pb-5 text-sm"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <Settings size={16} style={{ color: 'var(--color-gold-dark)' }} /> Fee assignments freeze
          once a term is billed; new enrolments are handled as an explicit top-up.
        </div>
      </Card>
    </div>
  );
}
