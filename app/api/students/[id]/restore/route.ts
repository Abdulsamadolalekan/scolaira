import { NextResponse } from 'next/server';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';

export const runtime = 'nodejs';

export const POST = withAuthorizedRoute(
  { action: 'student.restore', method: 'POST', bodySchema: undefined },
  async (_req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const existing = await studentRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, existing, 'Student');
    const updated = await studentRepo.restore(db, ctx, id as any);
    await auditRepo.record(db, ctx, {
      action: 'student.restore', entityType: 'student', entityId: id as any,
      after: { status: updated.status },
      metadata: { requestId },
    });
    return NextResponse.json({ student: updated });
  },
);
