/**
 * GET /api/debtors/[studentId] — detailed AR view for one student.
 *
 * Returns the student's outstanding invoices with per-line aging and recent
 * reminder history so the bursar sees at a glance what is owed, how long
 * it has been owed, and what follow-up has already happened.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { invoices, students } from '@/lib/db/schema';
import * as reminderRepo from '@/lib/db/repo/reminders';
import { SURFACE_LIMITS } from '@/lib/db/repo/pagination';
import { classifyReminderStaleness, followupThresholdsPayload } from '@/lib/db/repo/staleness';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export const GET = withAuthorizedRoute(
  { action: 'debtor.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, ctx, query }, routeParams) => {
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

    // H-2/M-6: this was a silent `.limit(15)`. The history now declares its
    // window and its total, and classifies each reminder against the shared
    // staleness thresholds (M-7) so the detail view and the workbench agree.
    const filters = (query ?? {}) as z.infer<typeof QuerySchema>;
    const rem = await reminderRepo.listForStudentPage(db, ctx, studentId as any, {
      limit: filters.limit ?? SURFACE_LIMITS.studentReminders.defaultLimit,
      cursor: filters.cursor ?? null,
    });
    const now = new Date();

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
      reminders: rem.rows.map((r: any) => {
        const verdict = classifyReminderStaleness(r.createdAt, now);
        return {
          id: r.id,
          channel: r.channel,
          status: r.status,
          balanceKobo: Number(r.balanceKobo),
          agingBucket: r.agingBucket,
          sentAt: r.sentAt,
          createdAt: r.createdAt,
          reminderStaleness: verdict.staleness,
          daysSinceReminder: verdict.daysSinceReminder,
        };
      }),
      remindersPage: {
        surface: SURFACE_LIMITS.studentReminders.surface,
        limit: rem.limit,
        cap: SURFACE_LIMITS.studentReminders.cap,
        returned: rem.rows.length,
        total: rem.total,
        hasMore: rem.hasMore,
        nextCursor: rem.nextCursor,
      },
      thresholds: followupThresholdsPayload(),
      scope: {
        scope: 'ALL_TERM',
        label: 'Every term — a student balance is not a term opinion',
      },
      // Computed from every invoice this student has (the list above is not
      // capped), so these three figures are source-complete by construction.
      summary: {
        outstandingKobo: open.reduce((s: number, i: any) => s + Math.max(0, Number(i.totalKobo) - Number(i.paidKobo)), 0),
        overdueKobo: open.reduce((s: number, i: any) => s + (i.dueDate && new Date(i.dueDate) < new Date() ? Math.max(0, Number(i.totalKobo) - Number(i.paidKobo)) : 0), 0),
        oldestOverdueDays: Math.max(0, ...open.map((i: any) => Number(i.daysOverdue) || 0)),
      },
    });
  },
);
