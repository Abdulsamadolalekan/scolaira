import { NextResponse } from 'next/server';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

export const POST = withAuthorizedRoute(
  { action: 'student.restore', method: 'POST', bodySchema: undefined },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'student.restore', path: `/api/students/${id}/restore`, payload: { id },
      });
      if (idem.replay) return idem.replay;
      const existing = await studentRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Student');
      const updated = await studentRepo.restore(tx, ctx, id as any);
      await auditRepo.record(tx, ctx, {
        action: 'student.restore', entityType: 'student', entityId: id as any,
        before: { status: existing!.status }, after: { status: updated.status },
        metadata: { requestId },
      });
      const response = { student: updated, enrollmentRestored: false };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
