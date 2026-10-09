/** GET /api/platform/orgs — organizations a platform administrator can support. */
import { NextResponse } from 'next/server';
import { withPlatformRoute } from '@/lib/platform/route';
import { listPlatformOrgs } from '@/lib/platform/support';

export const dynamic = 'force-dynamic';

export const GET = withPlatformRoute(
  { capability: 'platform.support.enter', method: 'GET', readOnly: true },
  async (_req, { session }) => {
    const orgs = await listPlatformOrgs(session.user.id);
    return NextResponse.json({ organizations: orgs });
  },
);
