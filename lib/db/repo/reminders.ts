/**
 * Reminders repository — immutable communications log for AR follow-up.
 *
 * A reminder row is written once when a bursar triggers a reminder and
 * updated only to reflect delivery lifecycle (PENDING→SENT→DELIVERED/FAILED).
 * Immutable-columns trigger trg_reminders_immutable enforces this at DB level.
 */
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../schema';
import type { UUID, TenantCtx, TenantScopedDb as Database } from './_context';
import {
  FOLLOWUP_THRESHOLDS,
  classifyReminderStaleness,
  type ReminderStaleness,
} from './staleness';
import {
  SURFACE_LIMITS,
  assertCursorKeys,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  sortKeyUs,
  type PageMeta,
} from './pagination';

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
    // PRINT is synchronously delivered in this milestone. Unsupported external
    // channels are queued as PENDING until a provider actually delivers them.
    status: input.channel === 'PRINT' ? 'SENT' : 'PENDING',
    sentAt: input.channel === 'PRINT' ? new Date() : null,
  } as any).returning();
  return rows[0]!;
}

/**
 * H-2/M-6 — the invoice's reminder history, with a declared window.
 *
 * This function used to end in a bare `.limit(20)`: a caller could not tell a
 * complete history from a truncated one. It now returns the rows AND the window
 * metadata (total from the database, keyset cursor, hasMore).
 */
export async function listForInvoice(
  db: Database,
  _ctx: TenantCtx,
  invoiceId: UUID,
  window: { limit?: number; cursor?: string | null } = {},
) {
  const surface = SURFACE_LIMITS.invoiceReminders;
  const limit = resolveLimit(surface, window.limit ?? null);
  const after = window.cursor ? decodeCursor(surface.surface, window.cursor) : null;
  const sortUs = sortKeyUs(s.reminders.createdAt);
  assertCursorKeys(after, ['bigint', 'uuid']);
  const predicates = [eq(s.reminders.invoiceId, invoiceId)] as any[];
  if (after) {
    predicates.push(
      sql`(${sortUs} < ${after[0]}::bigint
        OR (${sortUs} = ${after[0]}::bigint AND ${s.reminders.id} < ${after[1]}::uuid))`,
    );
  }
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.reminders)
    .where(and(eq(s.reminders.invoiceId, invoiceId)));
  const rows = await db.select({
    id: s.reminders.id,
    channel: s.reminders.channel,
    status: s.reminders.status,
    balanceKobo: s.reminders.balanceKobo,
    agingBucket: s.reminders.agingBucket,
    sentAt: s.reminders.sentAt,
    createdAt: s.reminders.createdAt,
    sortUs: sql<string>`${sortUs}`,
  })
  .from(s.reminders)
  .where(and(...predicates))
  .orderBy(sql`${sortUs} desc, ${s.reminders.id} desc`)
  .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = (page[page.length - 1] as any) ?? null;
  return {
    rows: page,
    limit,
    total: Number(countRows[0]?.n ?? 0),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(surface.surface, [String(last.sortUs), String(last.id)])
        : null,
  };
}

/** H-2/M-6 — a student's reminder history with the same declared window. */
export async function listForStudentPage(
  db: Database,
  ctx: TenantCtx,
  studentId: UUID,
  window: { limit?: number; cursor?: string | null } = {},
) {
  const surface = SURFACE_LIMITS.studentReminders;
  const limit = resolveLimit(surface, window.limit ?? null);
  const after = window.cursor ? decodeCursor(surface.surface, window.cursor) : null;
  const sortUs = sortKeyUs(s.reminders.createdAt);
  assertCursorKeys(after, ['bigint', 'uuid']);
  const predicates = [
    eq(s.reminders.organizationId, ctx.organizationId),
    eq(s.reminders.studentId, studentId),
  ] as any[];
  if (after) {
    predicates.push(
      sql`(${sortUs} < ${after[0]}::bigint
        OR (${sortUs} = ${after[0]}::bigint AND ${s.reminders.id} < ${after[1]}::uuid))`,
    );
  }
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.reminders)
    .where(and(...predicates.slice(0, 2)));
  const rows = await db.select({
    id: s.reminders.id,
    channel: s.reminders.channel,
    status: s.reminders.status,
    balanceKobo: s.reminders.balanceKobo,
    agingBucket: s.reminders.agingBucket,
    sentAt: s.reminders.sentAt,
    createdAt: s.reminders.createdAt,
    sortUs: sql<string>`${sortUs}`,
  })
  .from(s.reminders)
  .where(and(...predicates))
  .orderBy(sql`${sortUs} desc, ${s.reminders.id} desc`)
  .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = (page[page.length - 1] as any) ?? null;
  return {
    rows: page,
    limit,
    total: Number(countRows[0]?.n ?? 0),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(surface.surface, [String(last.sortUs), String(last.id)])
        : null,
  };
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

/** Aging boundaries, declared once so every surface can label its own numbers. */
export const AGING_THRESHOLDS = {
  dueSoonDays: 7,
  overdue30Days: 30,
  overdue60Days: 60,
  /** The dashboard's "90+ days overdue" headline threshold. */
  severeAgingDays: 90,
  /**
   * The floor used by the debtors workbench "severe" count: the OVERDUE_90
   * bucket starts after 60 days (see `bucketFor`), so a debtor whose oldest
   * overdue date is more than 60 days old is counted as severe there.
   */
  severeBucketDays: 60,
} as const;

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
  /** H-2/M-7: the last reminder classified against the shared thresholds. */
  reminderStaleness: ReminderStaleness;
  /** Whole days since the last reminder, or null when there has never been one. */
  daysSinceReminder: number | null;
}

/**
 * Aging debtors workbench: one row per ACTIVE student with outstanding balance,
 * ranked by oldest overdue date then amount. Uses raw SQL because drizzle's
 * correlated-aggregate / lateral ergonomics get unwieldy here; financial math
 * is the same trigger-maintained columns used by the dashboard.
 */
export interface DebtorPage {
  rows: DebtorRow[];
  page: PageMeta;
}

/**
 * H-2/M-6: the workbench is paginated, and the totals it renders come from
 * source rows (`debtorTotals`) — never from the page. Before H-2 the route
 * summed the capped page and reported `debtorCount = rows.length`, so a tenant
 * with 501 debtors saw "500 debtors" and a short total for money owed.
 *
 * Ordering is `oldestOverdueDays desc, overdueKobo desc, studentId asc` — the
 * last key makes the keyset cursor total, so paging cannot repeat or skip a row.
 */
export async function listDebtorsPage(
  db: Database,
  _ctx: TenantCtx,
  options: { limit?: number | string | null; cursor?: string | null } = {},
): Promise<DebtorPage> {
  const surface = SURFACE_LIMITS.debtors;
  const limit = resolveLimit(surface, options.limit);
  const after = options.cursor ? decodeCursor(surface.surface, options.cursor) : null;
  const rows = await debtorQuery(db, limit + 1, after);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    page: {
      surface: surface.surface,
      limit,
      cap: surface.cap,
      capSource: surface.capSource,
      returned: page.length,
      total: await countDebtors(db, _ctx),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor(surface.surface, [
              last.oldestOverdueDays,
              last.overdueKobo,
              last.studentId,
            ])
          : null,
    },
  };
}

export async function listDebtors(db: Database, _ctx: TenantCtx): Promise<DebtorRow[]> {
  return (await debtorQuery(db, 500, null));
}

function mapDebtor(r: any, now: Date): DebtorRow {
  const verdict = classifyReminderStaleness(r.lastReminderAt ?? null, now);
  return {
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
    reminderStaleness: verdict.staleness,
    daysSinceReminder: verdict.daysSinceReminder,
  };
}

/**
 * The workbench query, shared by the paginated read and the legacy unpaginated
 * read. The inner CTE is exactly the pre-H-2 SQL (same joins, same rounding,
 * same "outstanding > 0" filter); H-2 adds a total ordering, a keyset predicate
 * and an explicit limit on the outside, so the *page* changes and the *numbers*
 * do not.
 */
async function debtorQuery(
  db: Database,
  limit: number,
  after: Array<string | null> | null,
): Promise<DebtorRow[]> {
  const orgExpr = sql`current_setting('app.organization_id')::uuid`;
  const keyset = after
    ? sql`
        AND (
          base."oldestOverdueDays" < ${Number(after[0])}::int
          OR (base."oldestOverdueDays" = ${Number(after[0])}::int
              AND base."overdueKobo" < ${Number(after[1])}::bigint)
          OR (base."oldestOverdueDays" = ${Number(after[0])}::int
              AND base."overdueKobo" = ${Number(after[1])}::bigint
              AND base."studentId" > ${after[2]}::uuid)
        )`
    : sql``;
  const rows = (await db.execute(sql`
    with base as (
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
    )
    select * from base
     where true ${keyset}
     order by base."oldestOverdueDays" desc, base."overdueKobo" desc, base."studentId" asc
     limit ${limit}
  `)) as unknown as any[];
  const now = new Date();
  return (rows ?? []).map((r) => mapDebtor(r, now));
}

/**
 * Source-row totals for the workbench: computed by the database over EVERY
 * matching row, never by looping a page. This is what makes the headline
 * totals tie back to the invoices they summarise (H-2 ADQ), and what fixes the
 * measured defect where 501 debtors were reported as 500 with a short total.
 */
export interface DebtorTotals {
  outstandingKobo: number;
  overdueKobo: number;
  severeCount: number;
  debtorCount: number;
}

export async function debtorTotals(db: Database, _ctx: TenantCtx): Promise<DebtorTotals> {
  const orgExpr = sql`current_setting('app.organization_id')::uuid`;
  const rows = (await db.execute(sql`
    select count(*)::int                                                            as "debtorCount",
           coalesce(sum(bal.outstanding_kobo), 0)::bigint                            as "outstandingKobo",
           coalesce(sum(bal.overdue_kobo), 0)::bigint                                as "overdueKobo",
           count(*) filter (where bal.oldest_overdue_days > ${AGING_THRESHOLDS.severeBucketDays})::int as "severeCount"
      from students s
      join lateral (
        select coalesce(sum(case when i.status in ('ISSUED','PARTIALLY_PAID')
                                 then i.total_kobo - i.paid_kobo else 0 end), 0) as outstanding_kobo,
               coalesce(sum(case when i.status in ('ISSUED','PARTIALLY_PAID')
                                  and i.due_date is not null and i.due_date < current_date
                                 then i.total_kobo - i.paid_kobo else 0 end), 0) as overdue_kobo,
               coalesce(max(case when i.status in ('ISSUED','PARTIALLY_PAID')
                                  and i.due_date is not null and i.due_date < current_date
                                 then (current_date - i.due_date)::int else 0 end), 0) as oldest_overdue_days
          from invoices i
         where i.organization_id = s.organization_id
           and i.student_id = s.id
           and i.status in ('ISSUED','PARTIALLY_PAID','PAID')
      ) bal on true
     where s.organization_id = ${orgExpr}
       and s.status = 'ACTIVE'
       and bal.outstanding_kobo > 0
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows?.[0] ?? {};
  return {
    outstandingKobo: Number(r.outstandingKobo ?? 0),
    overdueKobo: Number(r.overdueKobo ?? 0),
    severeCount: Number(r.severeCount ?? 0),
    debtorCount: Number(r.debtorCount ?? 0),
  };
}

export async function countDebtors(db: Database, _ctx: TenantCtx): Promise<number> {
  return (await debtorTotals(db, _ctx)).debtorCount;
}

/** The thresholds every surface that classifies follow-up staleness must echo. */
export function debtorThresholdsPayload() {
  return {
    ...FOLLOWUP_THRESHOLDS,
    severeBucketDays: AGING_THRESHOLDS.severeBucketDays,
    severeAgingDays: AGING_THRESHOLDS.severeAgingDays,
  };
}
