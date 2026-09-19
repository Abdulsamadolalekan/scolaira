/**
 * POST /api/debtors/[studentId]/remind — record and issue a payment reminder.
 *
 * Body: { channel: 'PRINT'|'SMS'|'EMAIL'|'WHATSAPP', invoiceId?: string,
 *         includeAll?: boolean }
 *
 * M7 implements PRINT synchronously — the API returns a printable reminder
 * payload ready for the browser's print dialog. SMS/EMAIL/WHATSAPP are
 * accepted (status=PENDING, no external delivery yet) so the data model
 * and audit trail are ready when those channels are wired up.
 *
 * Invariants:
 *   - Requester must have reminder.send (OWNER/SCHOOL_ADMIN/FINANCE_OFFICER).
 *   - Target student must be in the requester's org and ACTIVE.
 *   - There must be an outstanding balance for the scoped invoice or for
 *     the student.
 *   - A cooldown (4 hours) prevents accidental double-sends.
 *   - Reminder body is generated server-side from template.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { students } from '@/lib/db/schema';
import * as reminderRepo from '@/lib/db/repo/reminders';

export const runtime = 'nodejs';

const BodySchema = z.object({
  channel: z.enum(['PRINT', 'SMS', 'EMAIL', 'WHATSAPP']),
  invoiceId: z.string().uuid().optional(),
  includeAll: z.boolean().optional().default(false),
});

function formatMoney(k: number) {
  return '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderBody(opts: {
  orgName: string;
  studentName: string;
  invoices: Array<{invoiceNumber: string; dueDate: string | null; remainingKobo: number; daysOverdue: number}>;
  totalKobo: number;
}): { subject: string; body: string } {
  const lines = opts.invoices.map(i => {
    const due = i.dueDate ? new Date(i.dueDate).toLocaleDateString('en-NG') : '—';
    const overdue = i.daysOverdue > 0 ? ` (${i.daysOverdue} days overdue)` : '';
    return `  • ${i.invoiceNumber} due ${due}: ${formatMoney(i.remainingKobo)}${overdue}`;
  }).join('\n');
  const subject = `Reminder: Outstanding balance of ${formatMoney(opts.totalKobo)} on your account`;
  const body =
`Dear Parent/Guardian,

This is a friendly reminder from ${opts.orgName} that there is an outstanding balance on ${opts.studentName}'s account:

${lines}

Total outstanding: ${formatMoney(opts.totalKobo)}

Please settle this balance at your earliest convenience. If you have already made payment, kindly disregard this message or contact the bursary to confirm allocation.

Thank you,
${opts.orgName} Bursary`;
  return { subject, body };
}

export const POST = withAuthorizedRoute(
  { action: 'reminder.send', method: 'POST', bodySchema: BodySchema },
  async (_req, { db, ctx, body, session }, routeParams) => {
    const { channel, invoiceId, includeAll } = body as z.infer<typeof BodySchema>;
    const { studentId } = await (routeParams as { params: Promise<{ studentId: string }> }).params;

    const stuRows = await db.select({
      id: students.id, studentId: students.studentId,
      firstName: students.firstName, middleName: students.middleName, lastName: students.lastName,
    }).from(students).where(and(
      eq(students.id, studentId as any),
      eq(students.organizationId, ctx.organizationId),
      eq(students.status, 'ACTIVE'),
    ));
    if (!stuRows[0]) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Student not found.' } }, { status: 404 });
    const stu = stuRows[0]!;
    const studentName = [stu.firstName, stu.middleName, stu.lastName].filter(Boolean).join(' ');

    const orgRows: any[] = await db.execute(sql`select name from organizations where id = ${ctx.organizationId}::uuid limit 1`);
    const orgName: string = orgRows[0]?.name ?? 'the school';

    const invs: any[] = await db.execute(sql`
      select id, invoice_number, due_date, total_kobo, paid_kobo,
             coalesce(greatest(0, current_date - due_date)::int,0) as days_overdue
        from invoices
       where organization_id = ${ctx.organizationId}::uuid
         and student_id = ${studentId}::uuid
         and status in ('ISSUED','PARTIALLY_PAID')`);

    const open = invs.map((r: any) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      dueDate: r.due_date ? new Date(r.due_date).toISOString().slice(0,10) : null,
      totalKobo: Number(r.total_kobo),
      paidKobo: Number(r.paid_kobo),
      remainingKobo: Math.max(0, Number(r.total_kobo) - Number(r.paid_kobo)),
      daysOverdue: Number(r.days_overdue),
    })).filter((r) => r.remainingKobo > 0);

    let targets = open;
    if (invoiceId && !includeAll) {
      targets = open.filter(r => r.id === invoiceId);
      if (targets.length === 0) {
        return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'That invoice has no outstanding balance.' } }, { status: 400 });
      }
    }
    if (targets.length === 0) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'No outstanding balance to remind about.' } }, { status: 400 });
    }

    const total = targets.reduce((s, i) => s + i.remainingKobo, 0);
    const maxDays = Math.max(0, ...targets.map(i => i.daysOverdue));

    const cooled = await reminderRepo.hasBeenRemindedSince(db, ctx, invoiceId && !includeAll ? invoiceId : null, studentId, 4);
    if (cooled) {
      return NextResponse.json({ error: { code: 'TOO_EARLY', message: 'A reminder was already sent for this balance within the last 4 hours.' } }, { status: 429 });
    }

    const { subject, body: msgBody } = renderBody({ orgName, studentName, invoices: targets, totalKobo: total });

    const created: any[] = [];
    if (includeAll || !invoiceId) {
      created.push(await reminderRepo.create(db, ctx, {
        studentId,
        channel,
        balanceKobo: total,
        agingDays: maxDays,
        agingBucket: reminderRepo.bucketFor(maxDays),
        subject, body: msgBody,
      }));
    } else {
      for (const inv of targets) {
        created.push(await reminderRepo.create(db, ctx, {
          invoiceId: inv.id, studentId,
          channel,
          balanceKobo: inv.remainingKobo,
          agingDays: inv.daysOverdue,
          agingBucket: reminderRepo.bucketFor(inv.daysOverdue),
          subject, body: msgBody,
        }));
      }
    }

    return NextResponse.json({
      ok: true,
      channel,
      status: channel === 'PRINT' ? 'SENT' : 'PENDING',
      reminders: created.map((r: any) => ({ id: r.id, status: r.status })),
      document: {
        orgName, studentName, subject, body: msgBody,
        invoices: targets,
        totalKobo: total,
        generatedAt: new Date().toISOString(),
        generatedBy: session.user.id,
      },
    }, { status: 201 });
  },
);
