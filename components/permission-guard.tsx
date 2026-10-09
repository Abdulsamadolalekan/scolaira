/**
 * Server-side permission gates for authenticated routes.
 *
 * In a level-4 product, permission failures don't show broken UI or raw 403s.
 * A staff member who lands on /invoices sees a calm explanation — not an error.
 */
import { getSession } from '@/lib/auth';
import { authorize, type Action } from '@/lib/authz/permissions';

export type GateResult = { allowed: true; role: string | null } | { allowed: false; reason?: string };

export async function checkPermission(action: Action): Promise<GateResult> {
  const session = await getSession();
  if (!session) return { allowed: false, reason: 'unauthenticated' };
  const membership = session.memberships.find(
    m => m.organizationId === session.activeOrganizationId,
  );
  const role = membership?.role ?? null;
  const decision = authorize({
    role: role as any,
    isPlatformSupport: !!session.isPlatformSession,
  }, action);
  if (decision.allowed) return { allowed: true, role };
  return { allowed: false, reason: decision.reason };
}
