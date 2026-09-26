/**
 * POST /api/auth/select-organization
 * Body: { organizationId: uuid }
 *
 * Sets the signed active-org cookie after verifying the user is an ACTIVE
 * member of that organization. CSRF-protected. The cookie is readable by JS
 * (HttpOnly=false) so the org switcher can set it too, but the server re-
 * verifies membership on every request — the cookie is a preference, not an
 * authority source.
 *
 * Implementation note: we use the auth module's cookie-store abstraction so
 * the test harness can inject a cookie jar; we do NOT use next/headers
 * cookies() directly because that only works inside Next's render scope.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getSession, clearContext, requireCsrf, cookieStore, AuthError } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { signActiveOrgCookie, activeOrgCookieOptions } from '@/lib/auth/cookies';
import { getDb } from '@/lib/db';
import { organizationMembers } from '@/lib/db/schema';

const bodySchema = z.object({
  organizationId: z.string().uuid(),
});

export const runtime = 'nodejs';

async function rawSessionIdFromCookieHeader(req: Request): Promise<string> {
  const cookie = req.headers.get('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)sc_session=([^;]+)/);
  if (!match) return '';
  return match[1]!.split('.')[0] ?? '';
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
    }
    await requireCsrf(req, await rawSessionIdFromCookieHeader(req));

    let body: unknown;
    try { body = bodySchema.parse(await req.json().catch(() => ({}))); }
    catch {
      await clearContext();
      return NextResponse.json({ error: { code: 'BAD_REQUEST' } }, { status: 400 });
    }
    const { organizationId } = body as { organizationId: string };

    // We must verify the membership across all of the user's orgs, which
    // means we need system context (getSession() scoped us to a specific
    // tenant after resolving membership, which hides orgs outside that
    // tenant). Enter system context via SECURITY DEFINER helper then run
    // the cross-tenant membership lookup.
    const sql = getSql();
    await sql`SELECT auth_enter_system_context()`;
    const db = getDb();
    const rows = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, session.user.id),
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    await clearContext();
    if (!rows.length) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Not an active member of that organization' } },
        { status: 403 },
      );
    }

    // ONE writer for this cookie (H-4/F10): the same options helper the auth
    // module's switchOrganization() uses, so the value can never be written
    // unsigned (an unsigned sc_org is rejected by verifyActiveOrgCookie()).
    const c = await cookieStore();
    c.set({ ...activeOrgCookieOptions(signActiveOrgCookie(organizationId, session.user.id)) });
    return NextResponse.json({
      ok: true,
      activeOrganizationId: organizationId,
      role: rows[0]!.role,
    });
  } catch (e) {
    await clearContext();
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('select-org error', e);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  }
}
