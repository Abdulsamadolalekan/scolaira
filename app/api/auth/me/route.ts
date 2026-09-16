import { NextResponse } from 'next/server';
import { getSession, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

/** Return current authenticated principal; 401 if unauthenticated. */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } }, { status: 401 });
    return NextResponse.json({
      user: {
        id: session.user.id,
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
      },
      activeOrganizationId: session.activeOrganizationId,
      memberships: session.memberships,
    });
  } catch (e: any) {
    console.error('me error', e?.code, e?.message);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
