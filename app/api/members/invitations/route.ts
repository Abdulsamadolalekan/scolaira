/**
 * POST /api/members/invitations — create (or replace) a pending invitation.
 * GET  /api/members/invitations — list this organization's invitations.
 *
 * `POST /api/members` stays exactly as it is (frozen M5): it answers 501 for a
 * known address and 404 for an unknown one, and nothing in H-8 changes that. The
 * affordance the members page offers is repaired here, at the route it already
 * points at, rather than by rewriting frozen code.
 *
 * The plaintext link is returned in the response and only there — decision D-1
 * documents manual, link-based delivery instead of email.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import {
  INVITABLE_ROLES,
  createInvitation,
  listInvitations,
  type InvitableRole,
} from '@/lib/members/invitations';

export const dynamic = 'force-dynamic';

const ROLE_VALUES = INVITABLE_ROLES as unknown as [InvitableRole, ...InvitableRole[]];

const bodySchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(ROLE_VALUES),
});

export const GET = withAuthorizedRoute(
  { action: 'member.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const invitations = await listInvitations(db, ctx);
    return NextResponse.json({ invitations });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'member.invite', method: 'POST', bodySchema },
  async (req, { db, ctx, session, body }) => {
    const { email, role } = body as { email: string; role: string };
    const created = await createInvitation(db, ctx, {
      email,
      role,
      invitedBy: session.user.id,
    });

    const origin = new URL(req.url).origin;
    return NextResponse.json(
      {
        invitation: {
          id: created.id,
          email: created.email,
          role: created.role,
          expiresAt: created.expiresAt.toISOString(),
          replacedPending: created.replacedPending,
        },
        // Shown once. The inviter copies this and delivers it themselves.
        acceptPath: created.acceptPath,
        acceptUrl: `${origin}${created.acceptPath}`,
      },
      { status: 201 },
    );
  },
);
