/**
 * GET /api/students/[id] — student financial profile.
 *
 * Returns the student record plus their invoices (with balance) and
 * payment history (allocated to this student's invoices) ordered most-
 * recent first. RLS + org-membership enforced by withAuthorizedRoute +
 * assertResourceInOrg.
 */
import { NextResponse } from 'next/server';
import { eq, and, desc, sql } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import { invoices } from '@/lib/db/schema';
import type { UUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'student.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const studentId = id as UUID;
    const s = await studentRepo.get(db, ctx, studentId);
    assertResourceInOrg(ctx, s, 'Student');

    // Invoices for this student.
    const invRows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        termId: invoices.termId,
        dueDate: invoices.dueDate,
        issueDate: invoices.issueDate,
        totalKobo: invoices.totalKobo,
        paidKobo: invoices.paidKobo,
      })
      .from(invoices)
      .where(and(eq(invoices.studentId, studentId), eq(invoices.organizationId, ctx.organizationId)))
      .orderBy(desc(invoices.createdAt));

    // Payment allocations touching this student's invoices (active and reversed).
    const payRows = await db.execute(sql`
      SELECT p.id, p.payment_number AS "paymentNumber", p.method, p.status,
             p.amount_kobo AS "amountKobo", p.unallocated_kobo AS "unallocatedKobo",
             p.reference, p.paid_at AS "paidAt", p.recorded_at AS "recordedAt",
             COALESCE(SUM(CASE WHEN pa.status='ACTIVE' AND i.student_id = ${studentId} THEN pa.amount_kobo ELSE 0 END),0)::bigint AS "appliedKobo",
             BOOL_OR(pa.id IS NOT NULL AND pa.status='REVERSED') AS has_reversal
        FROM payments p
        LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
        LEFT JOIN invoices i ON i.id = pa.invoice_id
       WHERE p.organization_id = ${ctx.organizationId}
         AND EXISTS (
           SELECT 1 FROM payment_allocations pa2
             JOIN invoices i2 ON i2.id = pa2.invoice_id
            WHERE pa2.payment_id = p.id AND i2.student_id = ${studentId}
         )
      GROUP BY p.id
      ORDER BY COALESCE(p.paid_at, p.created_at) DESC
      LIMIT 200
    `) as Array<Record<string,unknown>>;

    const totalBilled = invRows.reduce((a, i) => a + Number(i.totalKobo), 0);
    const totalPaid = invRows.reduce((a, i) => a + Number(i.paidKobo), 0);

    return NextResponse.json({
      student: {
        id: s!.id,
        studentId: s!.studentId,
        firstName: s!.firstName,
        lastName: s!.lastName,
        middleName: s!.middleName,
        gender: s!.gender,
        status: s!.status,
      },
      invoices: invRows.map(r => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        dueDate: r.dueDate,
        issueDate: r.issueDate,
        totalKobo: Number(r.totalKobo),
        paidKobo: Number(r.paidKobo),
        remainingKobo: Math.max(0, Number(r.totalKobo) - Number(r.paidKobo)),
      })),
      payments: payRows.map(r => ({
        id: r.id,
        paymentNumber: r.paymentNumber,
        method: r.method,
        status: r.status,
        amountKobo: Number(r.amountKobo),
        unallocatedKobo: Number(r.unallocatedKobo ?? 0),
        reference: r.reference,
        paidAt: r.paidAt,
        recordedAt: r.recordedAt,
        appliedKobo: Number(r.appliedKobo ?? 0),
      })),
      summary: {
        totalBilledKobo: totalBilled,
        totalPaidKobo: totalPaid,
        outstandingKobo: Math.max(0, totalBilled - totalPaid),
        invoiceCount: invRows.length,
      },
    });
  },
);
