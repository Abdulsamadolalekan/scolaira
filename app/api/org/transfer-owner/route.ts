/** POST /api/org/transfer-owner — [org.owner.transfer] */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, Members } from '@/lib/authz';

const schema = z.object({
  targetMemberId: z.string().uuid(),
});

export const POST = withAuthorizedRoute(
  { action: 'org.owner.transfer', method: 'POST', bodySchema: schema },
  async (_req, { db, ctx, body }) => {
    const { targetMemberId } = body as { targetMemberId: string };
    const result = await Members.transferOwnership(db, ctx, { targetMemberId });
    return NextResponse.json({ ok: true, ...result });
  },
);
