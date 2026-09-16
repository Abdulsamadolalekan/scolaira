/**
 * GET /api/dashboard/summary — Command Center KPIs.
 *
 * Serves the institutional Command Center:
 *   - term-aware greeting
 *   - kobo-precise aggregates (billed / collected / outstanding / overdue)
 *   - unreconciled payments count
 *   - attention list (overdue balances, pending bank transfers, unsent drafts)
 *   - merged activity feed (payments + invoices)
 *
 * All numbers are aggregated from rows the current tenant can already see via
 * RLS; this endpoint does not bypass, extend, or elevate permissions.
 */
import { NextResponse } from 'next/server';
import { and, eq, gt, inArray, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { invoices, payments, students, users } from '@/lib/db/schema';

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
    kind: 'overdue_invoice' | 'pending_payment' | 'draft_invoice';
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

    // ---------- KPIs ----------
    const [[invAgg], [payAgg], [pendAgg], [stuAgg]] = await Promise.all([
      db.select({
        billed:        sql<number>`coalesce(sum(${invoices.totalKobo}),0)`,
        outstanding:   sql<number>`coalesce(sum(${invoices.totalKobo} - ${invoices.paidKobo}),0)`,
        overdue:       sql<number>`coalesce(sum(case when ${invoices.status} in ('ISSUED','PARTIALLY_PAID') and ${invoices.dueDate} is not null and ${invoices.dueDate} < current_date then ${invoices.totalKobo} - ${invoices.paidKobo} else 0 end),0)`,
        drafts:        sql<number>`coalesce(sum(case when ${invoices.status} = 'DRAFT' then 1 else 0 end),0)`,
      }).from(invoices).where(eq(invoices.organizationId, orgId)),
      db.select({
        collected: sql<number>`coalesce(sum(case when ${payments.status}='CONFIRMED' then ${payments.amountKobo} - coalesce(${payments.unallocatedKobo},0) else 0 end),0)`,
      }).from(payments).where(eq(payments.organizationId, orgId)),
      db.select({ count: sql<number>`count(*)` })
        .from(payments).where(and(eq(payments.organizationId, orgId), eq(payments.status, 'PENDING'))),
      db.select({ count: sql<number>`count(*)` })
        .from(students).where(and(eq(students.organizationId, orgId), eq(students.status, 'ACTIVE'))),
    ]);

    const inv = invAgg!; const pay = payAgg!; const pen = pendAgg!; const stu = stuAgg!;
    const billed        = Number(inv.billed) || 0;
    const collected     = Number(pay.collected) || 0;
    const outstanding   = Number(inv.outstanding) || 0;
    const overdue       = Number(inv.overdue) || 0;
    const unreconciled  = Number(pen.count) || 0;
    const activeStudents = Number(stu.count) || 0;
    const drafts        = Number(inv.drafts) || 0;
    const collectionRateBps = billed > 0 ? Math.round((collected * 10000) / billed) : 0;

    // ---------- Attention: top 3 overdue invoices (by outstanding balance) ----------
    const overdueBal = sql<number>`${invoices.totalKobo} - ${invoices.paidKobo}`;
    const topOverdue = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      studentName: sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as('student_name'),
      dueDate: invoices.dueDate,
      balance: overdueBal.as('balance'),
    })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .where(and(
        eq(invoices.organizationId, orgId),
        inArray(invoices.status, ['ISSUED','PARTIALLY_PAID']),
        sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
        gt(overdueBal, 0),
      ))
      .orderBy(desc(overdueBal))
      .limit(3);

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

    const today = new Date();
    for (const inv of topOverdue as any[]) {
      const days = inv.dueDate ? Math.max(1, Math.ceil((today.getTime() - new Date(inv.dueDate).getTime()) / 86400000)) : 1;
      attention.push({
        id: inv.id,
        kind: 'overdue_invoice',
        severity: 'danger',
        title: `${inv.studentName || 'A student'} — ${fmt(Number(inv.balance) || 0)} past due`,
        meta: `${inv.invoiceNumber} · ${days} day${days === 1 ? '' : 's'} overdue`,
        href: `/invoices/${inv.id}`,
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
      termLabel: 'Current term',
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
