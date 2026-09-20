/**
 * GET /api/dashboard/summary — Command Center KPIs.
 *
 * Serves the institutional Command Center:
 *   - term-aware greeting
 *   - kobo-precise aggregates for the CURRENT TERM (billed / collected /
 *     outstanding / overdue). Pending-payment counts and active-student
 *     counts remain org-wide because they are operational totals, not
 *     term-figures.
 *   - unreconciled payments count
 *   - attention list (overdue balances, pending bank transfers, unsent drafts)
 *   - merged activity feed (payments + invoices, current-term first)
 *
 * Financial figures derive from the trigger-maintained columns
 * (invoices.total_kobo/paid_kobo, payments.unallocated_kobo) and from
 * ACTIVE allocations against current-term invoices. There is no dashboard
 * ledger and no client-side math.
 *
 * All numbers are aggregated from rows the current tenant can already see via
 * RLS; this endpoint does not bypass, extend, or elevate permissions.
 */
import { NextResponse } from 'next/server';
import { and, eq, gt, inArray, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import { invoices, payments, students, users, paymentAllocations, reminders } from '@/lib/db/schema';

export type Summary = {
  termLabel: string;
  greetingName: string | null;
  kpis: {
    billedKobo: number;
    collectedKobo: number;
    outstandingKobo: number;
    overdueKobo: number;
    unreconciledPayments: number;
    activeStudents: number;
    collectionRateBps: number;
  };
  attention: Array<{
    id: string;
    kind: 'overdue_invoice' | 'pending_payment' | 'draft_invoice' | 'stale_followup' | 'aging_summary' | 'term_not_billed';
    severity: 'danger' | 'warning' | 'info';
    title: string;
    meta: string;
    href?: string;
  }>;
  activity: Array<{
    id: string;
    kind: 'payment_confirmed' | 'invoice_issued';
    at: string;
    title: string;
    meta: string;
  }>;
};

const fmt = (k: number) =>
  '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const GET = withAuthorizedRoute(
  { action: 'dashboard.read', method: 'GET' },
  async (_req, { db, ctx, session }) => {
    const orgId = ctx.organizationId;

    // Resolve the current term. If none is configured, KPIs fall back to zero
    // for term figures (we do NOT silently fall back to all-time because that
    // would mislead the proprietor).
    const currentTerm = await termRepo.getCurrent(db, ctx);
    const termId = currentTerm?.id ?? null;
    const termLabel = currentTerm
      ? `${currentTerm.name} · Current term`
      : 'No current term configured';

    // Term-scoped invoice predicates.
    const inTerm = termId ? eq(invoices.termId, termId as any) : sql`false`;
    const inTermAndIssued = termId
      ? and(eq(invoices.termId, termId as any), inArray(invoices.status, ['ISSUED','PARTIALLY_PAID','PAID']))
      : sql`false`;

    // ---------- Term-scoped KPIs ----------
    const [[invAgg], [pendAgg], [stuAgg], [collectedAgg], [draftAgg]] = await Promise.all([
      db.select({
        billed:        sql<number>`coalesce(sum(${invoices.totalKobo}),0)`,
        outstanding:   sql<number>`coalesce(sum(case when ${invoices.status} in ('ISSUED','PARTIALLY_PAID') then ${invoices.totalKobo} - ${invoices.paidKobo} else 0 end),0)`,
        overdue:       sql<number>`coalesce(sum(case when ${invoices.status} in ('ISSUED','PARTIALLY_PAID') and ${invoices.dueDate} is not null and ${invoices.dueDate} < current_date then ${invoices.totalKobo} - ${invoices.paidKobo} else 0 end),0)`,
      }).from(invoices).where(and(eq(invoices.organizationId, orgId), inTermAndIssued)),
      db.select({ count: sql<number>`count(*)` })
        .from(payments).where(and(eq(payments.organizationId, orgId), eq(payments.status, 'PENDING'))),
      db.select({ count: sql<number>`count(*)` })
        .from(students).where(and(eq(students.organizationId, orgId), eq(students.status, 'ACTIVE'))),
      // Collected against current-term invoices: sum ACTIVE allocations whose
      // invoice belongs to the current term, where the payment is CONFIRMED.
      // This is the most accurate definition: it correctly handles payments
      // that partially cover multiple terms (only the current-term slice is
      // counted) and excludes unallocated credit sitting on payments.
      termId
        ? db.select({ collected: sql<number>`coalesce(sum(${paymentAllocations.amountKobo}),0)` })
            .from(paymentAllocations)
            .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
            .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
            .where(and(
              eq(invoices.organizationId, orgId),
              eq(invoices.termId, termId as any),
              eq(paymentAllocations.status, 'ACTIVE'),
              eq(payments.status, 'CONFIRMED'),
            ))
        : Promise.resolve([{ collected: 0 }] as any),
      db.select({ count: sql<number>`coalesce(sum(case when ${invoices.status}='DRAFT' then 1 else 0 end),0)` })
        .from(invoices).where(and(eq(invoices.organizationId, orgId), inTerm)),
    ]);

    const inv = invAgg!; const pay = collectedAgg!; const pen = pendAgg!; const stu = stuAgg!; const dr = draftAgg!;
    const billed        = Number(inv.billed) || 0;
    const collected     = Number(pay.collected) || 0;
    const outstanding   = Number(inv.outstanding) || 0;
    const overdue       = Number(inv.overdue) || 0;
    const unreconciled  = Number(pen.count) || 0;
    const activeStudents = Number(stu.count) || 0;
    const drafts        = Number(dr.count) || 0;
    const collectionRateBps = billed > 0 ? Math.round((collected * 10000) / billed) : 0;

    // ---------- Attention: top 3 overdue invoices (by outstanding balance, current term) ----------
    const overdueBal = sql<number>`${invoices.totalKobo} - ${invoices.paidKobo}`;
    const overdueWhere = termId
      ? and(
          eq(invoices.organizationId, orgId),
          eq(invoices.termId, termId as any),
          inArray(invoices.status, ['ISSUED','PARTIALLY_PAID']),
          sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
          gt(overdueBal, 0),
        )
      : sql`false`;
    const topOverdue = termId
      ? await db.select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          studentName: sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as('student_name'),
          dueDate: invoices.dueDate,
          balance: overdueBal.as('balance'),
        })
          .from(invoices)
          .leftJoin(students, eq(students.id, invoices.studentId))
          .where(overdueWhere)
          .orderBy(desc(overdueBal))
          .limit(3)
      : [] as any[];

    // ---------- Attention: aging summary — severe debtors and stale follow-up ----------
    const [[severeAgg], [overdueAgg]] = await Promise.all([
      db.select({
        severeCount: sql<number>`count(distinct ${students.id})`,
        severeKobo: sql<number>`coalesce(sum(${invoices.totalKobo} - ${invoices.paidKobo}),0)`,
        noReminderCount: sql<number>`count(distinct case when ${reminders.id} is null then ${students.id} end)`,
      }).from(invoices)
        .leftJoin(students, eq(students.id, invoices.studentId))
        .leftJoin(reminders, and(
          eq(reminders.studentId, invoices.studentId),
          sql`${reminders.createdAt} > current_timestamp - interval '14 days'`,
        ))
        .where(and(
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, ['ISSUED','PARTIALLY_PAID']),
          sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date - interval '90 days'`,
          gt(overdueBal, 0),
        )),
      db.select({
        overdueCount: sql<number>`count(distinct ${students.id}) filter (where ${invoices.dueDate} < current_date)`,
        staleCount: sql<number>`count(distinct case when ${reminders.id} is null or ${reminders.createdAt} < current_timestamp - interval '7 days' then ${students.id} end) filter (where ${invoices.dueDate} < current_date)`,
      }).from(invoices)
        .leftJoin(students, eq(students.id, invoices.studentId))
        .leftJoin(reminders, and(
          eq(reminders.studentId, invoices.studentId),
          sql`${reminders.createdAt} > current_timestamp - interval '7 days'`,
        ))
        .where(and(
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, ['ISSUED','PARTIALLY_PAID']),
          sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
          gt(overdueBal, 0),
        )),
    ]);

    // ---------- Attention: pending payments (up to 2) ----------
    const pendingPays = await db.select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      amountKobo: payments.amountKobo,
      payerName: payments.payerName,
      method: payments.method,
      reference: payments.reference,
      paidAt: payments.paidAt,
    })
      .from(payments)
      .where(and(eq(payments.organizationId, orgId), eq(payments.status, 'PENDING')))
      .orderBy(sql`coalesce(${payments.paidAt}, ${payments.createdAt}) desc`)
      .limit(2);

    // ---------- Activity feed: latest payments + invoices, merged ----------
    const recentPayments = await db.select({
      id: payments.id,
      at: sql<string>`coalesce(${payments.paidAt}, ${payments.createdAt})`,
      amountKobo: payments.amountKobo,
      payerName: payments.payerName,
      reference: payments.reference,
      recordedBy: payments.recordedBy,
    })
      .from(payments)
      .where(and(eq(payments.organizationId, orgId), eq(payments.status, 'CONFIRMED')))
      .orderBy(sql`coalesce(${payments.paidAt}, ${payments.createdAt}) desc`)
      .limit(6);

    const recentInvoices = await db.select({
      id: invoices.id,
      at: sql<string>`${invoices.issuedAt}`,
      invoiceNumber: invoices.invoiceNumber,
      studentName: sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as('student_name'),
      totalKobo: invoices.totalKobo,
    })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .where(and(
        eq(invoices.organizationId, orgId),
        inArray(invoices.status, ['ISSUED','PARTIALLY_PAID','PAID']),
        termId ? eq(invoices.termId, termId as any) : sql`false`,
      ))
      .orderBy(desc(invoices.issuedAt))
      .limit(6);

    const actorIds = Array.from(new Set(recentPayments.map(r => r.recordedBy).filter(Boolean))) as string[];
    const actorMap = new Map<string, string>();
    if (actorIds.length) {
      const us = await db.select({ id: users.id, name: sql<string>`trim(coalesce(${users.firstName},'') || ' ' || coalesce(${users.lastName},''))`.as('actor_name') }).from(users).where(inArray(users.id, actorIds));
      us.forEach((u: any) => actorMap.set(u.id, u.name));
    }

    type PayEv = { id: string; kind: 'payment_confirmed'; at: string; amountKobo: number; payerName: string | null; reference: string | null; actor: string | null };
    type InvEv = { id: string; kind: 'invoice_issued';   at: string; invoiceNumber: string; studentName: string | null; totalKobo: number };
    const payEvents: PayEv[] = recentPayments.map((r: any) => ({
      id: r.id,
      kind: 'payment_confirmed',
      at: r.at ? new Date(r.at as unknown as Date).toISOString() : new Date(0).toISOString(),
      amountKobo: Number(r.amountKobo) || 0,
      payerName: r.payerName ?? null,
      reference: r.reference ?? null,
      actor: r.recordedBy ? (actorMap.get(r.recordedBy) ?? null) : null,
    }));
    const invEvents: InvEv[] = recentInvoices.map((r: any) => ({
      id: r.id,
      kind: 'invoice_issued',
      at: r.at ? new Date(r.at as unknown as Date).toISOString() : new Date(0).toISOString(),
      invoiceNumber: r.invoiceNumber,
      studentName: r.studentName ?? null,
      totalKobo: Number(r.totalKobo) || 0,
    }));

    const activityMerged = [...payEvents, ...invEvents]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 6);

    const activity: Summary['activity'] = activityMerged.map((ev) => {
      if (ev.kind === 'payment_confirmed') {
        const actor = ev.actor ? ` by ${ev.actor}` : '';
        const payer = ev.payerName || 'a payer';
        return {
          id: ev.id,
          kind: 'payment_confirmed',
          at: ev.at,
          title: `Payment of ${fmt(ev.amountKobo)} confirmed from ${payer}${actor}`,
          meta: ev.reference ? `Reference: ${ev.reference}` : 'Allocated to invoices',
        };
      }
      return {
        id: ev.id,
        kind: 'invoice_issued',
        at: ev.at,
        title: `Invoice ${ev.invoiceNumber} issued to ${ev.studentName || 'a student'}`,
        meta: `Amount: ${fmt(ev.totalKobo)}`,
      };
    });

    // ---------- Attention list (order: danger first, then warning, then info) ----------
    const attention: Summary['attention'] = [];

    const severe = severeAgg as { severeCount: number; severeKobo: number; noReminderCount: number } | undefined;
    const overdue_ = overdueAgg as { overdueCount: number; staleCount: number } | undefined;
    const severeCount = Number(severe?.severeCount ?? 0);
    const severeKobo = Number(severe?.severeKobo ?? 0);
    const noReminderCount = Number(severe?.noReminderCount ?? 0);
    const overdueCount = Number(overdue_?.overdueCount ?? 0);
    const staleCount = Number(overdue_?.staleCount ?? 0);

    if (currentTerm && currentTerm.status === 'ACTIVE' && !currentTerm.billed) {
      attention.push({
        id: 'term-not-billed',
        kind: 'term_not_billed',
        severity: 'warning',
        title: `${currentTerm.name} has not been billed`,
        meta: 'Review the enrolled population and fee structure before chasing balances.',
        href: `/terms/${currentTerm.id}/bill`,
      });
    }

    if (severeCount > 0) {
      attention.push({
        id: 'severe-aging',
        kind: 'aging_summary',
        severity: 'danger',
        title: `${severeCount} student${severeCount===1?'':'s'} 90+ days overdue — ${fmt(severeKobo)} at risk`,
        meta: noReminderCount > 0
          ? `${noReminderCount} have not received a reminder in the last 14 days. Open Debtors to follow up.`
          : 'All severe accounts have been reminded recently; review next steps.',
        href: '/debtors',
      });
    }

    const today = new Date();
    for (const inv of topOverdue as any[]) {
      const days = inv.dueDate ? Math.max(1, Math.ceil((today.getTime() - new Date(inv.dueDate).getTime()) / 86400000)) : 1;
      attention.push({
        id: inv.id,
        kind: 'overdue_invoice',
        severity: days > 60 ? 'danger' : 'warning',
        title: `${inv.studentName || 'A student'} — ${fmt(Number(inv.balance) || 0)} past due`,
        meta: `${inv.invoiceNumber} · ${days} day${days === 1 ? '' : 's'} overdue`,
        href: `/invoices/${inv.id}`,
      });
    }

    if (staleCount > 0 && severeCount === 0) {
      attention.push({
        id: 'stale-followup',
        kind: 'stale_followup',
        severity: overdueCount > 5 ? 'warning' : 'info',
        title: `${staleCount} overdue student${staleCount===1?'':'s'} have not been reminded this week`,
        meta: 'A one-click printable reminder is available from Debtors.',
        href: '/debtors',
      });
    }

    for (const p of pendingPays as any[]) {
      const amt = Number(p.amountKobo) || 0;
      const method = (p.method || '').replace(/_/g, ' ').toLowerCase();
      attention.push({
        id: p.id,
        kind: 'pending_payment',
        severity: 'warning',
        title: `${method === 'bank_transfer' ? 'Bank transfer' : method || 'Payment'} pending reconciliation`,
        meta: `${fmt(amt)}${p.payerName ? ' from ' + p.payerName : ''} — ref ${p.reference || 'n/a'}`,
        href: `/payments/${p.id}`,
      });
    }

    if (drafts > 0) {
      attention.push({
        id: 'drafts',
        kind: 'draft_invoice',
        severity: 'info',
        title: `${drafts} draft invoice${drafts === 1 ? '' : 's'} not yet issued`,
        meta: 'Drafts are invisible to parents. Issue them when ready.',
        href: '/invoices?status=DRAFT',
      });
    }

    return NextResponse.json({
      termLabel,
      greetingName: (session.user as any).firstName || (session.user as any).fullName?.split(' ')[0] || null,
      kpis: {
        billedKobo: billed,
        collectedKobo: collected,
        outstandingKobo: outstanding,
        overdueKobo: overdue,
        unreconciledPayments: unreconciled,
        activeStudents,
        collectionRateBps,
      },
      attention,
      activity,
    } satisfies Summary);
  },
);
