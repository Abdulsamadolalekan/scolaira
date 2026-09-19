import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { invoices } from '@/lib/db/schema';

export const runtime = 'nodejs';

const Schema = z.object({ reason: z.string().max(500).optional() });

export const POST = withAuthorizedRoute(
  { action: 'student.archive', method: 'POST', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = Schema.parse(body ?? {});
    const existing = await studentRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, existing, 'Student');

    // Guard: cannot archive a student with open invoices (balance > 0). They
    // must be settled or voided first to avoid orphan balances.
    const open = await db.select({ id: invoices.id })
      .from(invoices)
      .where(and(
        eq(invoices.organizationId, ctx.organizationId),
        eq(invoices.studentId, id),
        inArray(invoices.status, ['ISSUED','PARTIALLY_PAID']),
      ))
      .limit(1);
    if (open.length > 0) {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
        'Cannot archive a student with outstanding invoices. Settle or void invoices first.', 409);
    }

    const updated = await studentRepo.archive(db, ctx, id as any, data.reason);
    await auditRepo.record(db, ctx, {
      action: 'student.archive', entityType: 'student', entityId: id as any,
      after: { status: updated.status },
      metadata: { requestId, reason: data.reason ?? null },
    });
    return NextResponse.json({ student: updated });
  },
);
