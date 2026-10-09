/**
 * GET /api/receipts/[id] — receipt of record.
 *
 * Returns the receipt plus the information needed to render a printable
 * receipt: payment, organization, allocations with invoice+student.
 */
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as receiptRepo from '@/lib/db/repo/receipts';
import { payments, paymentAllocations, invoices, students, organizations } from '@/lib/db/schema';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'receipt.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const r = await receiptRepo.get(db, ctx, id as any);
    assertResourceInOrg(ctx, r, 'Receipt');

    // R2/H-7: the receipt's own frozen allocation snapshot is the document of
    // record. The live ACTIVE allocations are only used as a legacy fallback
    // for receipts issued before the snapshot existed.
    const snapshot = Array.isArray((r as any)?.allocationsSnapshot)
      ? ((r as any).allocationsSnapshot as Array<Record<string, unknown>>)
      : null;
    const [payRow, orgRows, allocRows] = await Promise.all([
      db.select().from(payments).where(eq(payments.id, r!.paymentId)).limit(1),
      db.select({ name: organizations.name, address: organizations.address, phone: organizations.phone })
        .from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1),
      db.select({
        id: paymentAllocations.id,
        amountKobo: paymentAllocations.amountKobo,
        invoiceNumber: invoices.invoiceNumber,
        studentFirstName: students.firstName,
        studentLastName: students.lastName,
      })
        .from(paymentAllocations)
        .leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .leftJoin(students, eq(students.id, invoices.studentId))
        .where(and(
          eq(paymentAllocations.paymentId, r!.paymentId),
          eq(paymentAllocations.status, 'ACTIVE'),
        )),
    ]);
    const org = orgRows[0] ?? { name: 'SCOLAIRA', address: null, phone: null };

    return NextResponse.json({
      receipt: {
        id: r!.id,
        receiptNumber: r!.receiptNumber,
        status: r!.status,
        amountKobo: Number(r!.amountKobo),
        issuedAt: r!.issuedAt,
        voidedReason: r!.voidedReason,
        paymentId: r!.paymentId,
      },
      payment: payRow[0] ? {
        paymentNumber: payRow[0].paymentNumber,
        method: payRow[0].method,
        reference: payRow[0].reference,
        paidAt: payRow[0].paidAt,
        recordedAt: (payRow[0] as any).createdAt,
        payerName: payRow[0].payerName,
        notes: payRow[0].notes,
        amountKobo: Number(payRow[0].amountKobo),
        unallocatedKobo: Number(payRow[0].unallocatedKobo ?? 0),
      } : null,
      linesSource: snapshot ? ('SNAPSHOT' as const) : ('CURRENT_ALLOCATIONS' as const),
      allocations: snapshot
        ? snapshot.map((line: any) => ({
            invoiceNumber: line.invoiceNumber ?? null,
            studentName: line.studentName ?? '—',
            amountKobo: Number(line.amountKobo),
          }))
        : allocRows.map((a: any) => ({
            invoiceNumber: a.invoiceNumber,
            studentName: [a.studentFirstName, a.studentLastName].filter(Boolean).join(' ').trim() || '—',
            amountKobo: Number(a.amountKobo),
          })),
      organization: { name: org.name, address: org.address, phone: org.phone },
    });
  },
);
