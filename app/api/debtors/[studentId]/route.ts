/**
 * GET /api/debtors/[studentId] — detailed AR view for one student.
 *
 * Returns the student's outstanding invoices with per-line aging and recent
 * reminder history so the bursar sees at a glance what is owed, how long
 * it has been owed, and what follow-up has already happened.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { invoices, students, reminders } from '@/lib/db/schema';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'debtor.read', method: 'GET' },
  async (_req, { db, ctx }, routeParams) => {
    const { studentId } = await (routeParams as { params: Promise<{ studentId: string }> }).params;
    const stuRows = await db.select({
      id: students.id,
      studentId: students.studentId,
      firstName: students.firstName,
      middleName: students.middleName,
      lastName: students.lastName,
    }).from(students).where(and(
      eq(students.id, studentId as any),
      eq(students.organizationId, ctx.organizationId),
      eq(students.status, 'ACTIVE'),
    ));
    if (!stuRows[0]) return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    const stu = stuRows[0]!;

    const inv = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      totalKobo: invoices.totalKobo,
      paidKobo: invoices.paidKobo,
      status: invoices.status,
      daysOverdue: sql<number>`coalesce(greatest(0, current_date - ${invoices.dueDate})::int,0)`,
    })
    .from(invoices)
    .where(and(
      eq(invoices.studentId, studentId as any),
      eq(invoices.organizationId, ctx.organizationId),
      inArray(invoices.status, ['ISSUED','PARTIALLY_PAID','PAID']),
    ))
    .orderBy(invoices.dueDate);

    const rem = await db.select({
      id: reminders.id,
      channel: reminders.channel,
      status: reminders.status,
      balanceKobo: reminders.balanceKobo,
      agingBucket: reminders.agingBucket,
      sentAt: reminders.sentAt,
      createdAt: reminders.createdAt,
    })
    .from(reminders)
    .where(and(
      eq(reminders.studentId, studentId as any),
    ))
    .orderBy(desc(reminders.createdAt))
    .limit(15);

    const open = inv.filter((i: any) => i.status !== 'PAID' && Number(i.totalKobo) - Number(i.paidKobo) > 0);
    return NextResponse.json({
      student: {
        id: stu.id, studentId: stu.studentId,
        name: [stu.firstName, stu.middleName, stu.lastName].filter(Boolean).join(' '),
      },
      invoices: inv.map((i: any) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        dueDate: i.dueDate,
        totalKobo: Number(i.totalKobo),
        paidKobo: Number(i.paidKobo),
        remainingKobo: Math.max(0, Number(i.totalKobo) - Number(i.paidKobo)),
        status: i.status,
        daysOverdue: Number(i.daysOverdue),
      })),
      reminders: rem.map((r: any) => ({
        id: r.id,
        channel: r.channel,
        status: r.status,
        balanceKobo: Number(r.balanceKobo),
        agingBucket: r.agingBucket,
        sentAt: r.sentAt,
        createdAt: r.createdAt,
      })),
      summary: {
        outstandingKobo: open.reduce((s: number, i: any) => s + Math.max(0, Number(i.totalKobo) - Number(i.paidKobo)), 0),
        overdueKobo: open.reduce((s: number, i: any) => s + (i.dueDate && new Date(i.dueDate) < new Date() ? Math.max(0, Number(i.totalKobo) - Number(i.paidKobo)) : 0), 0),
        oldestOverdueDays: Math.max(0, ...open.map((i: any) => Number(i.daysOverdue) || 0)),
      },
    });
  },
);
