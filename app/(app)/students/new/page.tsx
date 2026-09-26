import NewStudentForm from './new-student-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

export default async function NewStudentPage() {
  const guard = await checkPermission('student.create');
  if (!guard.allowed) {
    return <AccessDenied surface="New student" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  }
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>New student</h1>
      <p className="mt-1 text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
        Register a student on the school roll. This does not create an invoice — invoices are issued separately.
      </p>
      <NewStudentForm />
    </div>
  );
}
