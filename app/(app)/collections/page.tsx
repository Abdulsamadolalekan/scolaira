import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import CollectionsWorkbench from './collections-workbench';

export const runtime = 'nodejs';

export default async function CollectionsPage() {
  const permission = await checkPermission('collections.read');
  if (!permission.allowed) {
    return (
      <AccessDenied
        surface="Collections Workbench"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  }
  return <CollectionsWorkbench canMutate={Boolean(permission.role)} />;
}
