/**
 * GET  /api/members    — list members (member.read)
 * POST /api/members    — invite member (member.invite)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, Members } from '@/lib/authz';
import type { MembershipRole } from '@/lib/authz/permissions';

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: z.enum(['SCHOOL_ADMIN', 'FINANCE_OFFICER', 'STAFF']),
});

export const GET = withAuthorizedRoute(
  { action: 'member.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const members = await Members.listMembers(db, ctx);
    return NextResponse.json({ members });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'member.invite', method: 'POST', bodySchema: inviteSchema },
  async (_req, { db, ctx, body }) => {
    const { email, role } = body as { email: string; role: MembershipRole };
    const result = await Members.inviteMember(db, ctx, { email, role });
    return NextResponse.json({ member: result }, { status: 201 });
  },
);
