/**
 * Reminders repository — immutable communications log for AR follow-up.
 *
 * A reminder row is written once when a bursar triggers a reminder and
 * updated only to reflect delivery lifecycle (PENDING→SENT→DELIVERED/FAILED).
 * Immutable-columns trigger trg_reminders_immutable enforces this at DB level.
 */
import { and, eq, desc, sql } from 'drizzle-orm';
import * as s from '../schema';
import type { UUID, TenantCtx, TenantScopedDb as Database } from './_context';

export type AgingBucket = 'CURRENT' | 'DUE_SOON' | 'OVERDUE_30' | 'OVERDUE_60' | 'OVERDUE_90' | 'SEVERE';

export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'CURRENT';
  if (daysOverdue <= 7) return 'DUE_SOON';
  if (daysOverdue <= 30) return 'OVERDUE_30';
  if (daysOverdue <= 60) return 'OVERDUE_60';
  if (daysOverdue <= 90) return 'OVERDUE_90';
  return 'SEVERE';
}

export interface ReminderInput {
  invoiceId?: UUID | null;
  studentId?: UUID | null;
  guardianId?: UUID | null;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PRINT' | 'IN_APP';
  balanceKobo: number;
  agingDays: number;
  agingBucket: AgingBucket;
  subject?: string | null;
  body: string;
}

export async function create(
  db: Database,
  ctx: TenantCtx,
  input: ReminderInput,
) {
  const rows = await db.insert(s.reminders).values({
    organizationId: ctx.organizationId,
    invoiceId: input.invoiceId ?? null,
    studentId: input.studentId ?? null,
    guardianId: input.guardianId ?? null,
    channel: input.channel,
    balanceKobo: input.balanceKobo,
    agingDays: input.agingDays,
    agingBucket: input.agingBucket,
    subject: input.subject ?? null,
    body: input.body,
    createdBy: ctx.userId,
    // PRINT is synchronously delivered; async channels will later start as PENDING.
    status: 'SENT',
    sentAt: input.channel === 'PRINT' ? new Date() : null,
  } as any).returning();
  return rows[0]!;
}

export async function listForInvoice(db: Database, _ctx: TenantCtx, invoiceId: UUID) {
  return db.select({
    id: s.reminders.id,
    channel: s.reminders.channel,
    status: s.reminders.status,
    balanceKobo: s.reminders.balanceKobo,
    agingBucket: s.reminders.agingBucket,
    sentAt: s.reminders.sentAt,
    createdAt: s.reminders.createdAt,
  })
  .from(s.reminders)
  .where(and(eq(s.reminders.invoiceId, invoiceId)))
  .orderBy(desc(s.reminders.createdAt))
  .limit(20);
}

export async function listForStudent(_db: Database, _ctx: TenantCtx, _studentId: UUID): Promise<any[]> {
  // Intentionally minimal for M7: we use SQL below for the recent list.
  return [];
}

export async function hasBeenRemindedSince(
  db: Database,
  _ctx: TenantCtx,
  invoiceId: UUID | null,
  studentId: UUID | null,
  cooldownHours: number,
) {
  if (!invoiceId && !studentId) return false;
  const conds: any[] = [];
  if (invoiceId) conds.push(sql`invoice_id = ${invoiceId}::uuid`);
  else if (studentId) conds.push(sql`student_id = ${studentId}::uuid and invoice_id is null`);
  const rows = await db.execute(sql`
    select count(*)::int as n from reminders
     where organization_id = current_setting('app.organization_id')::uuid
       and ${sql.join(conds, sql` and `)}
       and created_at > now() - (${cooldownHours}::text || ' hours')::interval`);
  return Number((rows as any)[0]?.n ?? 0) > 0;
}

export interface DebtorRow {
  studentId: string;
  studentIdCode: string;
  studentName: string;
  className: string | null;
  primaryGuardianName: string | null;
  primaryGuardianPhone: string | null;
  outstandingKobo: number;
  overdueKobo: number;
  oldestOverdueDays: number;
  oldestDueDate: string | null;
  openInvoiceCount: number;
  lastReminderAt: string | null;
  agingBucket: AgingBucket;
}

/**
 * Aging debtors workbench: one row per ACTIVE student with outstanding balance,
 * ranked by oldest overdue date then amount. Uses raw SQL because drizzle's
 * correlated-aggregate / lateral ergonomics get unwieldy here; financial math
 * is the same trigger-maintained columns used by the dashboard.
 */
export async function listDebtors(db: Database, _ctx: TenantCtx): Promise<DebtorRow[]> {
  const orgExpr = sql`current_setting('app.organization_id')::uuid`;
  const rows = await db.execute(sql`
    with primary_g as (
      select distinct on (sg.student_id)
             sg.student_id,
             (g.first_name || ' ' || g.last_name) as guardian_name,
             g.phone as guardian_phone
        from student_guardians sg
        join guardians g on g.id = sg.guardian_id
       where g.organization_id = ${orgExpr}
         and sg.is_primary = true
       order by sg.student_id, sg.created_at
    ),
    cur_class as (
      select distinct on (ce.student_id)
             ce.student_id, c.name as class_name
        from class_enrollments ce
        join classes c on c.id = ce.class_id
        join terms t on t.id = ce.term_id
       where c.organization_id = ${orgExpr}
         and ce.left_on is null
         and t.is_current = true
       order by ce.student_id, ce.enrolled_on desc
    ),
    last_rem as (
      select student_id, max(created_at) as last_at
        from reminders
       where organization_id = ${orgExpr}
       group by student_id
    )
    select s.id                          as "studentId",
           s.student_id                 as "studentIdCode",
           trim(s.first_name || ' ' || coalesce(s.middle_name,'') || ' ' || s.last_name) as "studentName",
           cc.class_name                as "className",
           pg.guardian_name             as "primaryGuardianName",
           pg.guardian_phone            as "primaryGuardianPhone",
           coalesce(sum(case when i.status in ('ISSUED','PARTIALLY_PAID')
                             then i.total_kobo - i.paid_kobo else 0 end),0)::bigint as "outstandingKobo",
           coalesce(sum(case when i.status in ('ISSUED','PARTIALLY_PAID')
                             and i.due_date is not null
                             and i.due_date < current_date
                             then i.total_kobo - i.paid_kobo else 0 end),0)::bigint as "overdueKobo",
           coalesce(max(case when i.status in ('ISSUED','PARTIALLY_PAID')
                             and i.due_date is not null
                             and i.due_date < current_date
                             then (current_date - i.due_date)::int else 0 end),0)::int as "oldestOverdueDays",
           min(case when i.status in ('ISSUED','PARTIALLY_PAID')
                         and (i.total_kobo - i.paid_kobo) > 0
                    then i.due_date end)::text     as "oldestDueDate",
           count(*) filter (where i.status in ('ISSUED','PARTIALLY_PAID'))::int as "openInvoiceCount",
           lr.last_at                   as "lastReminderAt"
      from students s
      left join invoices i
        on i.student_id = s.id
       and i.organization_id = s.organization_id
       and i.status in ('ISSUED','PARTIALLY_PAID','PAID')
      left join primary_g pg on pg.student_id = s.id
      left join cur_class cc on cc.student_id = s.id
      left join last_rem lr on lr.student_id = s.id
     where s.organization_id = ${orgExpr}
       and s.status = 'ACTIVE'
     group by s.id, s.student_id, s.first_name, s.middle_name, s.last_name,
              cc.class_name, pg.guardian_name, pg.guardian_phone, lr.last_at
    having sum(case when i.status in ('ISSUED','PARTIALLY_PAID')
                   then i.total_kobo - i.paid_kobo else 0 end) > 0
     order by "oldestOverdueDays" desc, "overdueKobo" desc
     limit 500`);
  return (rows as any[]).map((r: any) => ({
    studentId: r.studentId,
    studentIdCode: r.studentIdCode,
    studentName: r.studentName,
    className: r.className ?? null,
    primaryGuardianName: r.primaryGuardianName ?? null,
    primaryGuardianPhone: r.primaryGuardianPhone ?? null,
    outstandingKobo: Number(r.outstandingKobo),
    overdueKobo: Number(r.overdueKobo),
    oldestOverdueDays: Number(r.oldestOverdueDays),
    oldestDueDate: r.oldestDueDate ?? null,
    openInvoiceCount: Number(r.openInvoiceCount),
    lastReminderAt: r.lastReminderAt ?? null,
    agingBucket: bucketFor(Number(r.oldestOverdueDays)),
  }));
}
