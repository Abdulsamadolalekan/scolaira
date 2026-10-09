import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import AcademicWorkspace from './academic-workspace';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

export default async function AcademicPage() {
  const read = await checkPermission('roster.read');
  if (!read.allowed)
    return (
      <AccessDenied
        surface="Academic roster"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const manage = await checkPermission('enrollment.manage');
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Academic roster"
        lede="Set up the academic context, maintain term enrollment, and resolve readiness exceptions before the billing run."
      />
      <AcademicWorkspace canManage={manage.allowed} />
    </div>
  );
}
