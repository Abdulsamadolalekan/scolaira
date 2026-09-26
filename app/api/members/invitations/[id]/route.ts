/** DELETE /api/members/invitations/[id] — revoke a pending invitation. */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import { revokeInvitation } from '@/lib/members/invitations';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/** Next 15 passes `params` as a promise; awaiting it is the route's job. */
async function readParams(raw: unknown): Promise<{ id: string } | null> {
  const p = (raw as { params?: Promise<{ id: string }> })?.params;
  if (!p) return null;
  const parsed = paramsSchema.safeParse(await p);
  return parsed.success ? parsed.data : null;
}

export const DELETE = withAuthorizedRoute(
  { action: 'member.revoke', method: 'DELETE' },
  async (_req, { db, ctx }, rawParams) => {
    const parsed = await readParams(rawParams);
    if (!parsed) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid invitation id' } },
        { status: 400 },
      );
    }
    const revoked = await revokeInvitation(db, ctx, parsed.id);
    if (!revoked) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No pending invitation with that id' } },
        { status: 404 },
      );
    }
    return NextResponse.json({ revoked: true });
  },
);
