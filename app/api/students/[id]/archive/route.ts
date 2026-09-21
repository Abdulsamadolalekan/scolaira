import { NextResponse } from 'next/server';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { classEnrollments, invoices, terms } from '@/lib/db/schema';

export const runtime = 'nodejs';
const Schema = z.object({ reason: z.string().max(500).optional() });

export const POST = withAuthorizedRoute(
  { action: 'student.archive', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = Schema.parse(body ?? {});
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'student.archive', path: `/api/students/${id}/archive`, payload: { id, ...data },
      });
      if (idem.replay) return idem.replay;
      const existing = await studentRepo.get(tx, ctx, id as any);
      assertResourceInOrg(ctx, existing, 'Student');

      const open = await tx.select({ id: invoices.id })
        .from(invoices)
        .where(and(
          eq(invoices.organizationId, ctx.organizationId),
          eq(invoices.studentId, id),
          inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']),
        ))
        .limit(1);
      if (open.length > 0) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          'Cannot archive a student with outstanding invoices. Settle or void invoices first.', 409);
      }

      // Close active enrollments in open terms before the student status change.
      // Closed-term history is immutable and is intentionally not rewritten.
      const active = await tx.select({ id: classEnrollments.id, enrolledOn: classEnrollments.enrolledOn })
        .from(classEnrollments)
        .innerJoin(terms, eq(terms.id, classEnrollments.termId))
        .where(and(
          eq(classEnrollments.organizationId, ctx.organizationId),
          eq(classEnrollments.studentId, id),
          isNull(classEnrollments.leftOn),
          ne(terms.status, 'CLOSED'),
        ));
      if (active.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        for (const enrollment of active) {
          const leftOn = sqlDateMax(today, enrollment.enrolledOn);
          const rows = await tx.update(classEnrollments)
            .set({ leftOn: leftOn as any })
            .where(and(eq(classEnrollments.organizationId, ctx.organizationId), eq(classEnrollments.id, enrollment.id)))
            .returning({ id: classEnrollments.id, termId: classEnrollments.termId, leftOn: classEnrollments.leftOn });
          const closed = rows[0];
          if (closed) {
            await auditRepo.record(tx, ctx, {
              action: 'enrollment.leave', entityType: 'class_enrollment', entityId: closed.id,
              before: { leftOn: null }, after: { leftOn: closed.leftOn },
              reason: data.reason, metadata: { requestId, termId: closed.termId, automaticStudentArchive: true },
            });
          }
        }
      }
      const row = await studentRepo.archive(tx, ctx, id as any, data.reason);
      await auditRepo.record(tx, ctx, {
        action: 'student.archive', entityType: 'student', entityId: id as any,
        before: { status: existing!.status },
        after: { status: row.status, closedEnrollmentCount: active.length },
        metadata: { requestId, reason: data.reason ?? null },
      });
      const response = { student: row };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);

function sqlDateMax(today: string, enrolledOn: string): string {
  return today < enrolledOn ? enrolledOn : today;
}
