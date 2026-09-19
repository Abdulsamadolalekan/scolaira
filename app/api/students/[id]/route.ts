/**
 * Student API:
 *   GET    /api/students/[id]  — financial profile (student.read)
 *   PATCH  /api/students/[id]  — update basic profile (student.update)
 *
 * Archive/Restore are separate POST endpoints below to keep intent explicit.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { invoices } from '@/lib/db/schema';

export const runtime = 'nodejs';

const PatchSchema = z.object({
  firstName: z.string().min(1).max(120).optional(),
  lastName: z.string().min(1).max(120).optional(),
  middleName: z.string().max(120).nullable().optional(),
  gender: z.enum(['M','F','OTHER']).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  admissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

async function loadProfile(db: any, ctx: any, id: string) {
  const stu = await studentRepo.get(db, ctx, id as any);
  if (!stu) return null;

  const invRows = await db.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    status: invoices.status,
    dueDate: invoices.dueDate,
    totalKobo: invoices.totalKobo,
    paidKobo: invoices.paidKobo,
  })
    .from(invoices)
    .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.studentId, id)))
    .orderBy(desc(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`));

  // Payments allocated to any of this student's invoices.
  const payRows = await db.execute(sql`
    SELECT p.id, p.payment_number, p.method, p.status, p.amount_kobo, p.reference,
           p.paid_at, p.recorded_at,
           coalesce(sum(a.amount_kobo) filter (where a.status='ACTIVE' and i.id is not null),0)::bigint AS applied_kobo
    FROM payments p
    LEFT JOIN payment_allocations a ON a.payment_id = p.id
    LEFT JOIN invoices i ON i.id = a.invoice_id AND i.student_id = ${id}::uuid AND i.organization_id = ${ctx.organizationId}
    WHERE p.organization_id = ${ctx.organizationId}
      AND p.id IN (
        SELECT DISTINCT a2.payment_id
        FROM payment_allocations a2
        JOIN invoices i2 ON i2.id = a2.invoice_id
        WHERE i2.student_id = ${id}::uuid AND i2.organization_id = ${ctx.organizationId}
      )
    GROUP BY p.id, p.payment_number, p.method, p.status, p.amount_kobo, p.reference, p.paid_at, p.recorded_at
    ORDER BY greatest(coalesce(p.paid_at, p.recorded_at), p.created_at) DESC
    LIMIT 50`);

  const invoiceList = (invRows as any[]).map(r => ({
    id: r.id, invoiceNumber: r.invoiceNumber, status: r.status,
    dueDate: r.dueDate, totalKobo: Number(r.totalKobo), paidKobo: Number(r.paidKobo),
    remainingKobo: Math.max(0, Number(r.totalKobo) - Number(r.paidKobo)),
  }));
  const paymentList = (payRows as any[]).map((r:any) => ({
    id: r.id, paymentNumber: r.payment_number, method: r.method, status: r.status,
    amountKobo: Number(r.amount_kobo), appliedKobo: Number(r.applied_kobo),
    unallocatedKobo: Math.max(0, Number(r.amount_kobo) - Number(r.applied_kobo)),
    reference: r.reference, paidAt: r.paid_at, recordedAt: r.recorded_at,
  }));
  const totalBilled = invoiceList.reduce((s,i)=>s+i.totalKobo,0);
  const totalPaid = invoiceList.reduce((s,i)=>s+i.paidKobo,0);
  return {
    student: { id: stu.id, studentId: stu.studentId, firstName: stu.firstName, lastName: stu.lastName, middleName: stu.middleName, gender: stu.gender, status: stu.status },
    invoices: invoiceList,
    payments: paymentList,
    summary: {
      totalBilledKobo: totalBilled,
      totalPaidKobo: totalPaid,
      outstandingKobo: Math.max(0, totalBilled - totalPaid),
      invoiceCount: invoiceList.length,
    },
  };
}

export const GET = withAuthorizedRoute(
  { action: 'student.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const profile = await loadProfile(db, ctx, id);
    if (!profile) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);
    return NextResponse.json(profile);
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'student.update', method: 'PATCH', bodySchema: PatchSchema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const existing = await studentRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, existing, 'Student');
    const data = PatchSchema.parse(body);
    const updated = await studentRepo.update(db, ctx, id as any, {
      ...data,
      dateOfBirth: data.dateOfBirth === null ? null : data.dateOfBirth,
      admissionDate: data.admissionDate === null ? null : data.admissionDate,
    });
    await auditRepo.record(db, ctx, {
      action: 'student.update', entityType: 'student', entityId: id as any,
      before: { firstName: existing!.firstName, lastName: existing!.lastName },
      after: { firstName: updated.firstName, lastName: updated.lastName },
      metadata: { requestId },
    });
    return NextResponse.json({ student: updated });
  },
);
