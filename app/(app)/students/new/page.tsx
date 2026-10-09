import NewStudentForm from './new-student-form';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { PageContainer, PageHeader, Crumb } from '@/components/ui/page-header';

export const runtime = 'nodejs';

export default async function NewStudentPage() {
  const guard = await checkPermission('student.create');
  if (!guard.allowed) {
    return (
      <AccessDenied
        surface="New student"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  }
  return (
    <PageContainer width="narrow">
      <PageHeader
        breadcrumbs={<Crumb parent="Students" parentHref="/students" trail="New student" />}
        title="New student"
        lede="Register a student on the school roll. This does not create an invoice — invoices are issued separately."
      />
      <NewStudentForm />
    </PageContainer>
  );
}
