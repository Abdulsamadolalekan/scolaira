import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import AcademicWorkspace from './academic-workspace';

export const runtime = 'nodejs';

export default async function AcademicPage() {
  const read = await checkPermission('roster.read');
  if (!read.allowed) return <AccessDenied surface="Academic roster" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const manage = await checkPermission('enrollment.manage');
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Academic roster</h1>
        <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Set up the academic context, maintain term-specific enrollment, and resolve readiness exceptions before the explicit M8 billing run.
        </p>
      </div>
      <AcademicWorkspace canManage={manage.allowed} />
    </div>
  );
}
