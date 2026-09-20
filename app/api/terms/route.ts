/**
 * GET /api/terms — list terms for org (for dropdowns).
 */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await termRepo.listForOrg(db, ctx);
    return NextResponse.json({
      terms: rows.map(t => ({
        id: t.id, name: t.name, label: t.label,
        sessionId: t.sessionId,
        isCurrent: t.isCurrent, startsOn: t.startsOn, endsOn: t.endsOn, dueDate: t.dueDate,
        billed: t.billed, billedAt: t.billedAt, billedBy: t.billedBy, status: t.status,
      })),
    });
  },
);
