import { NextResponse } from 'next/server';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as collectionsRepo from '@/lib/db/repo/collections';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { asUUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GET = withAuthorizedRoute(
  { action: 'collections.read', method: 'GET' },
  async (_req, { db, ctx }, routeParams) => {
    const { id } = await (routeParams as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid collections case id.', 400);
    }
    const caseId = asUUID(id);
    const detail = await collectionsRepo.getCaseDetail(db, ctx, caseId);
    // H-2/M-6: the case thread declares its window instead of silently showing
    // the newest 100 events as if they were all of them.
    const audit = await auditRepo.listForEntityPage(db, ctx, 'collections_case', caseId, { limit: 100 });
    return NextResponse.json({
      ...detail,
      audit: audit.rows,
      auditPage: {
        limit: 100,
        returned: audit.rows.length,
        total: audit.total,
        hasMore: audit.hasMore,
        nextCursor: audit.nextCursor,
      },
    });
  },
);
