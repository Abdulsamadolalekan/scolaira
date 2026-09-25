/** POST /api/members/:id/reactivate  — [member.reactivate] */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute, Members, AuthzError, AuthzErrorCode } from '@/lib/authz';


async function parseId(p: any): Promise<string> {
  const resolved = await p;
  if (!/^[0-9a-f-]{36}$/i.test(resolved.id)) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid member id', 400);
  }
  return resolved.id;
}

export const POST = withAuthorizedRoute(
  { action: 'member.reactivate', method: 'POST' },
  async (_req, { db, ctx }, params: any) => {
    const id = await parseId(params.params as any);
    const result = await Members.reactivateMember(db, ctx, id);
    return NextResponse.json({ member: result });
  },
);
