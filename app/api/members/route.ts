/** GET /api/members — list organization members (member.read). */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { organizationMembers } from '@/lib/db/schema/tenancy';
import { users } from '@/lib/db/schema/tenancy';

export type MemberRow = {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: 'OWNER' | 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF';
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  joinedAt: string | null;
  invitedAt: string | null;
  isCurrentUser: boolean;
};

const fmtDateTime = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
};

const ROLE_LABEL: Record<MemberRow['role'], string> = {
  OWNER: 'Proprietor',
  SCHOOL_ADMIN: 'Administrator',
  FINANCE_OFFICER: 'Finance Officer',
  STAFF: 'Staff',
};

export const GET = withAuthorizedRoute(
  { action: 'member.read', method: 'GET' },
  async (_req, { db, ctx, session }) => {
    const rows = await db.select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      joinedAt: organizationMembers.joinedAt,
      invitedAt: organizationMembers.invitedAt,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
    }).from(organizationMembers)
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, ctx.organizationId)))
      .orderBy(organizationMembers.role, organizationMembers.joinedAt);

    const result: MemberRow[] = rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || (r.email ?? 'Invited member'),
      email: r.email ?? null,
      phone: r.phone ?? null,
      role: r.role,
      status: r.status,
      joinedAt: fmtDateTime(r.joinedAt),
      invitedAt: fmtDateTime(r.invitedAt),
      isCurrentUser: r.userId === session.user.id,
    }));

    return NextResponse.json({ members: result });
  },
);

// -----------------------------------------------------------------------------
// POST /api/members — invite a member (member.invite).
//
// M5 status: endpoint exists to defend the authorization boundary (the authz
// matrix and M4 red-team tests require it), but full invitation flow (email
// delivery, token minting, onboarding) is NOT YET IMPLEMENTED. Until that
// ships, the handler performs authorization, validates input, and returns a
// 501 Not Implemented rather than fabricating success.
// -----------------------------------------------------------------------------
const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['SCHOOL_ADMIN','FINANCE_OFFICER','STAFF']),
});

export const POST = withAuthorizedRoute(
  { action: 'member.invite', method: 'POST', bodySchema: InviteBody },
  async (_req, { db, body }) => {
    const { email } = body as { email: string; role: 'SCHOOL_ADMIN'|'FINANCE_OFFICER'|'STAFF' };
    // Precondition: look up the user by email. If they do not exist, return 404
    // (this is the documented behaviour the M4 authz tests pin). If they do,
    // we have not built the rest of the invite flow yet, so return 501 rather
    // than silently pretending an invitation was sent.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!existing[0]) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No user with that email exists.' } },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Member invitation flow is not yet available.' } },
      { status: 501 },
    );
  },
);

export { ROLE_LABEL };
