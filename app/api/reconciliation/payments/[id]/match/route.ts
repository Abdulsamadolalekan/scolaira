import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { invoices, students } from '@/lib/db/schema';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import {
  createAcceptedCandidate,
  getOrCreateCase,
  lockPayment,
  requireEvidence,
  updateCaseState,
} from '@/lib/reconciliation';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z
  .object({
    studentId: z.string().regex(UUID_RE).optional(),
    invoiceId: z.string().regex(UUID_RE).optional(),
    basis: z.string().trim().min(1).max(2000),
  })
  .refine((value) => Boolean(value.studentId || value.invoiceId), {
    message: 'Student or invoice is required.',
  });

export const POST = withAuthorizedRoute(
  { action: 'reconciliation.review', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id))
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid payment id.' } },
        { status: 400 },
      );
    const data = body as z.infer<typeof Schema>;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'reconciliation.match',
        path: `/api/reconciliation/payments/${id}/match`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;
      const payment = await lockPayment(tx, ctx, id as any);
      if (payment.status !== 'CONFIRMED')
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'Confirm the payment before establishing its allocation target.',
          409,
        );
      if (payment.unallocatedKobo <= 0)
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'This payment has no unallocated amount to match.',
          409,
        );
      const caseRow = await getOrCreateCase(tx, ctx, payment, { kind: 'TO_MATCH' });
      if (caseRow.state === 'FLAGGED')
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'Unflag the case before matching it.', 409);
      await requireEvidence(tx, ctx, caseRow.id);

      let studentId = data.studentId as any;
      if (data.invoiceId) {
        const invoiceRows = await tx
          .select({ id: invoices.id, studentId: invoices.studentId })
          .from(invoices)
          .where(
            and(
              eq(invoices.id, data.invoiceId as any),
              eq(invoices.organizationId, ctx.organizationId),
            ),
          )
          .limit(1);
        const invoice = invoiceRows[0];
        if (!invoice) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Invoice not found.', 404);
        if (studentId && studentId !== invoice.studentId)
          throw new AuthzError(
            AuthzErrorCode.BAD_REQUEST,
            'Student does not match the invoice.',
            400,
          );
        studentId = invoice.studentId;
      } else {
        const studentRows = await tx
          .select({ id: students.id })
          .from(students)
          .where(
            and(eq(students.id, studentId as any), eq(students.organizationId, ctx.organizationId)),
          )
          .limit(1);
        if (!studentRows[0])
          throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);
      }
      const candidate = await createAcceptedCandidate(tx, ctx, {
        caseId: caseRow.id,
        studentId,
        invoiceId: data.invoiceId as any,
        basis: data.basis,
        requestId,
      });
      const updatedCase = await updateCaseState(tx, ctx, {
        caseId: caseRow.id,
        state: 'RECONCILED',
        kind: 'TO_ALLOCATE',
        reason: data.basis,
        requestId,
        auditAction: 'reconciliation.match',
        beforeExtra: { paymentStatus: payment.status },
        afterExtra: { candidateId: candidate.id, studentId, invoiceId: data.invoiceId ?? null },
      });
      const response = {
        candidate: {
          id: candidate.id,
          studentId: candidate.studentId,
          invoiceId: candidate.invoiceId,
          state: candidate.state,
        },
        reconciliation: {
          caseId: updatedCase.id,
          state: updatedCase.state,
          kind: updatedCase.kind,
        },
      };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
