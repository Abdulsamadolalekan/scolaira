/**
 * GET /api/platform/orgs/[id] — read-only view of one organization.
 *
 * The read plane of support mode. There is deliberately no POST/PATCH/DELETE
 * here: a mutation in another organization is performed by that organization's
 * own members through the tenant routes, never by a platform administrator.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withPlatformRoute } from '@/lib/platform/route';
import { loadSupportOrgDetail } from '@/lib/platform/support';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/** Next 15 passes `params` as a promise; awaiting it is the route's job. */
async function readParams(raw: unknown): Promise<{ id: string } | null> {
  const p = (raw as { params?: Promise<{ id: string }> })?.params;
  if (!p) return null;
  const parsed = paramsSchema.safeParse(await p);
  return parsed.success ? parsed.data : null;
}

export const GET = withPlatformRoute(
  { capability: 'platform.support.enter', method: 'GET', readOnly: true },
  async (_req, { session }, rawParams) => {
    const parsed = await readParams(rawParams);
    if (!parsed) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid organization id' } },
        { status: 400 },
      );
    }
    const org = await loadSupportOrgDetail(session.user.id, parsed.id);
    if (!org) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Organization not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json({ organization: org });
  },
);
