/**
 * POST /api/invitations/[token]/accept — consume an invitation.
 *
 * Authenticated but deliberately NOT tenant-scoped: the accepting user is not a
 * member of the inviting organization, and the organization is discovered from
 * the token. `acceptInvitation` is the only place that reads across that line,
 * and it is written to touch exactly the row the token hashes to. See the
 * docblock in lib/members/invitations.ts.
 *
 * There is no GET here: acceptance is a state change, so it is CSRF-protected
 * and never triggered by a link preview or a mail scanner.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSession, getRawSessionCookieValue, requireCsrf } from '@/lib/auth';
import { InvitationError, acceptInvitation } from '@/lib/members/invitations';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ token: z.string().min(1).max(256) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to accept this invitation' } },
      { status: 401 },
    );
  }

  try {
    // Raw session id (first dot-segment of the signed cookie), as every other
    // route in the codebase passes it.
    await requireCsrf(req, ((await getRawSessionCookieValue()) ?? '').split('.')[0] ?? '');
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: {
          code: (e as { code?: string })?.code ?? 'CSRF_INVALID',
          message: (e as Error)?.message ?? 'CSRF invalid',
        },
      },
      { status: 403 },
    );
  }

  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'This invitation link is not valid' } },
      { status: 404 },
    );
  }

  try {
    const accepted = await acceptInvitation(parsed.data.token, {
      userId: session.user.id,
      // Taken from the verified session, never from the request body.
      email: session.user.email,
    });
    return NextResponse.json({
      accepted: {
        organizationId: accepted.organizationId,
        organizationName: accepted.organizationName,
        role: accepted.role,
        alreadyMember: accepted.alreadyMember,
      },
    });
  } catch (e) {
    if (e instanceof InvitationError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status },
      );
    }
    console.error('invitation acceptance failed', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Internal error' } },
      { status: 500 },
    );
  }
}
