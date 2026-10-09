/**
 * GET    /api/members/:id  — get a member by id (member.read)
 * PATCH  /api/members/:id  — change role (member.change_role)
 * DELETE /api/members/:id  — revoke (member.revoke)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, Members, AuthzError, AuthzErrorCode } from '@/lib/authz';
import type { MembershipRole } from '@/lib/authz/permissions';

const roleSchema = z.object({
  role: z.enum(['SCHOOL_ADMIN', 'FINANCE_OFFICER', 'STAFF']),
});


async function parseId(params: any): Promise<string> {
  const p = await params;
  if (!/^[0-9a-f-]{36}$/i.test(p.id)) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid member id', 400);
  }
  return p.id;
}

export const GET = withAuthorizedRoute(
  { action: 'member.read', method: 'GET' },
  async (_req, { db, ctx }, params: any) => {
    const id = await parseId(params.params as any);
    const list = await Members.listMembers(db, ctx);
    const m = list.find((x: any) => x.id === id);
    if (!m) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, { status: 404 });
    return NextResponse.json({ member: m });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'member.change_role', method: 'PATCH', bodySchema: roleSchema },
  async (_req, { db, ctx, body }, params: any) => {
    const id = await parseId(params.params as any);
    const { role } = body as { role: MembershipRole };
    const result = await Members.changeMemberRole(db, ctx, id, role);
    return NextResponse.json({ member: result });
  },
);

export const DELETE = withAuthorizedRoute(
  { action: 'member.revoke', method: 'DELETE' },
  async (_req, { db, ctx }, params: any) => {
    const id = await parseId(params.params as any);
    await Members.revokeMember(db, ctx, id);
    return NextResponse.json({ ok: true });
  },
);
