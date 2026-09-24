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
import { and, eq, gt, inArray, or, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import * as scopingRepo from '@/lib/db/repo/scoping';
import * as reminderRepo from '@/lib/db/repo/reminders';
import * as aggregates from '@/lib/db/repo/aggregates';
import { FOLLOWUP_THRESHOLDS, followupThresholdsPayload } from '@/lib/db/repo/staleness';
import {
  invoices,
  payments,
  students,
  users,
  terms,
  reminders,
} from '@/lib/db/schema';

export type Summary = {
  termLabel: string;
  greetingName: string | null;
  /**
   * H-2: every payload declares the scope of the figures it carries. The
   * headline scope is the organization's own choice; the queues below are
   * all-term by definition and say so.
   */
  scope: {
    kpis: {
      scope: 'TERM' | 'ALL_TERM';
      label: string;
      isDefault: boolean;
      setting: 'invoice_scope';
      termId: string | null;
      termName: string | null;
      cutoverOn: string | null;
      asOf: string;
    };
    activeStudents: { scope: 'ALL_TERM'; label: string };
    queues: { scope: 'ALL_TERM'; label: string };
  };
  /** The exhaustive partition the headline is computed from. */
  buckets: Array<{
    key: 'CURRENT_TERM' | 'PRIOR_TERM' | 'OTHER_TERM';
    label: string;
    invoiceCount: number;
    billedKobo: number;
    collectedKobo: number;
    outstandingKobo: number;
    overdueKobo: number;
    draftCount: number;
  }>;
  /** The boundaries this response classified against (M-7). */
  thresholds: {
    staleAfterDays: number;
    unattendedAfterDays: number;
    reminderCooldownHours: number;
    severeAgingDays: number;
  };
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
    kind:
      | 'overdue_invoice'
      | 'pending_payment'
      | 'draft_invoice'
      | 'stale_followup'
      | 'aging_summary'
      | 'term_not_billed';
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

    // ---------- The declared scope (H-2) ----------
    //
    // Measured defect: the headline was term-scoped while every queue was
    // all-term, and nothing in the payload said which convention applied, so the
    // same word meant two different numbers on one screen. The scope is now
    // DECLARED (organization setting, default ALL_TERM because arrear visibility
    // is the safe default) and echoed in this response next to the figures.
    const currentTerm = await termRepo.getCurrent(db, ctx);
    const termId = currentTerm?.id ?? null;
    const cutoverOn = currentTerm?.startsOn ?? null;
    const scopeDecl = await scopingRepo.getInvoiceScopeDeclaration(db, ctx);
    const termLabel = currentTerm
      ? `${currentTerm.name} · Current term`
      : 'No current term configured';

    // ---------- One classified source for every invoice figure ----------
    //
    // `auth_invoice_scope_buckets` classifies each invoice once, in SQL, into
    // CURRENT_TERM / PRIOR_TERM / OTHER_TERM. The headline is the CURRENT bucket
    // (scope TERM) or the sum of all three (scope ALL_TERM); both come from the
    // same classified rows, so the headline can never disagree with the buckets
    // this response also carries. `sum(buckets) === headline` is the tie-back
    // the H-2 reconciliation tests assert against source rows.
    const buckets = await aggregates.invoiceBuckets(db, ctx, { id: termId, startsOn: cutoverOn });
    const headline = aggregates.headlineForScope(buckets, scopeDecl.scope);
    const allTermBuckets = aggregates.sumBuckets(buckets);

    const reconciliationWork = or(
      eq(payments.status, 'PENDING'),
      eq(payments.status, 'DUPLICATE_SUSPECT'),
      and(eq(payments.status, 'CONFIRMED'), gt(payments.unallocatedKobo, 0)),
    );

    // Queues that are all-term BY DEFINITION (arrears, aging, reconciliation)
    // keep their meaning; only the labelled invoice figures follow the scope.
    const [[pendAgg], [stuAgg]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(payments)
        .where(and(eq(payments.organizationId, orgId), reconciliationWork)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(students)
        .where(and(eq(students.organizationId, orgId), eq(students.status, 'ACTIVE'))),
    ]);

    const billed = headline.totals.billedKobo;
    const collected = headline.totals.collectedKobo;
    const outstanding = headline.totals.outstandingKobo;
    const overdue = headline.totals.overdueKobo;
    const unreconciled = Number(pendAgg?.count) || 0;
    const activeStudents = Number(stuAgg?.count) || 0;
    const drafts = scopeDecl.scope === 'TERM' ? headline.current.draftCount : allTermBuckets.draftCount;
    const collectionRateBps = billed > 0 ? Math.round((collected * 10000) / billed) : 0;

    // ---------- Attention: top 3 overdue invoices (by outstanding balance, current term) ----------
    const overdueBal = sql<number>`${invoices.totalKobo} - ${invoices.paidKobo}`;
    // The quick list follows the DECLARED scope: an all-term headline must not
    // sit next to a this-term-only arrears list (that was the measured
    // inconsistency). Each row carries its own classification label.
    const overdueWhere =
      scopeDecl.scope === 'TERM' && termId
        ? and(
            eq(invoices.organizationId, orgId),
            eq(invoices.termId, termId as any),
            inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']),
            sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
            gt(overdueBal, 0),
          )
        : and(
            eq(invoices.organizationId, orgId),
            inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']),
            sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
            gt(overdueBal, 0),
          );
    const topOverdueRows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        studentName:
          sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as(
            'student_name',
          ),
        dueDate: invoices.dueDate,
        balance: overdueBal.as('balance'),
        termName: terms.name,
        termId: invoices.termId,
      })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .leftJoin(terms, eq(terms.id, invoices.termId))
      .where(overdueWhere)
      .orderBy(desc(overdueBal))
      .limit(3);
    const topOverdue = topOverdueRows.map((r: any) => {
      const scopeClass = aggregates.classifyInvoiceScope(
        { termId: r.termId ?? null, dueDate: r.dueDate ?? null },
        { termId, cutoverOn },
      );
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        studentName: r.studentName,
        dueDate: r.dueDate,
        balance: r.balance,
        termName: r.termName ?? null,
        scopeClass,
        scopeLabel: aggregates.BUCKET_LABELS[scopeClass],
      };
    });

    // ---------- Attention: aging summary — severe debtors and stale follow-up ----------
    const [[severeAgg], [overdueAgg]] = await Promise.all([
      db
        .select({
          severeCount: sql<number>`count(distinct ${students.id})`,
          severeKobo: sql<number>`coalesce(sum(${invoices.totalKobo} - ${invoices.paidKobo}),0)`,
          noReminderCount: sql<number>`count(distinct case when ${reminders.id} is null then ${students.id} end)`,
        })
        .from(invoices)
        .leftJoin(students, eq(students.id, invoices.studentId))
        .leftJoin(
          reminders,
          and(
            eq(reminders.studentId, invoices.studentId),
            sql`${reminders.createdAt} > current_timestamp - make_interval(days => ${FOLLOWUP_THRESHOLDS.unattendedAfterDays})`,
          ),
        )
        .where(
          and(
            eq(invoices.organizationId, orgId),
            inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']),
            sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date - interval '90 days'`,
            gt(overdueBal, 0),
          ),
        ),
      db
        .select({
          overdueCount: sql<number>`count(distinct ${students.id}) filter (where ${invoices.dueDate} < current_date)`,
          staleCount: sql<number>`count(distinct case when ${reminders.id} is null or ${reminders.createdAt} < current_timestamp - interval '7 days' then ${students.id} end) filter (where ${invoices.dueDate} < current_date)`,
        })
        .from(invoices)
        .leftJoin(students, eq(students.id, invoices.studentId))
        .leftJoin(
          reminders,
          and(
            eq(reminders.studentId, invoices.studentId),
            sql`${reminders.createdAt} > current_timestamp - make_interval(days => ${FOLLOWUP_THRESHOLDS.staleAfterDays})`,
          ),
        )
        .where(
          and(
            eq(invoices.organizationId, orgId),
            inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']),
            sql`${invoices.dueDate} is not null and ${invoices.dueDate} < current_date`,
            gt(overdueBal, 0),
          ),
        ),
    ]);

    // ---------- Attention: reconciliation work (up to 2) ----------
    const reconciliationPays = await db
      .select({
        id: payments.id,
        paymentNumber: payments.paymentNumber,
        amountKobo: payments.amountKobo,
        unallocatedKobo: payments.unallocatedKobo,
        payerName: payments.payerName,
        method: payments.method,
        status: payments.status,
        reference: payments.reference,
        paidAt: payments.paidAt,
      })
      .from(payments)
      .where(and(eq(payments.organizationId, orgId), reconciliationWork))
      .orderBy(sql`coalesce(${payments.paidAt}, ${payments.createdAt}) desc`)
      .limit(2);

    // ---------- Activity feed: latest payments + invoices, merged ----------
    const recentPayments = await db
      .select({
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

    const recentInvoices = await db
      .select({
        id: invoices.id,
        at: sql<string>`${invoices.issuedAt}`,
        invoiceNumber: invoices.invoiceNumber,
        studentName:
          sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as(
            'student_name',
          ),
        totalKobo: invoices.totalKobo,
      })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .where(
        and(
          eq(invoices.organizationId, orgId),
          inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID', 'PAID']),
          termId ? eq(invoices.termId, termId as any) : sql`false`,
        ),
      )
      .orderBy(desc(invoices.issuedAt))
      .limit(6);

    const actorIds = Array.from(
      new Set(recentPayments.map((r) => r.recordedBy).filter(Boolean)),
    ) as string[];
    const actorMap = new Map<string, string>();
    if (actorIds.length) {
      const us = await db
        .select({
          id: users.id,
          name: sql<string>`trim(coalesce(${users.firstName},'') || ' ' || coalesce(${users.lastName},''))`.as(
            'actor_name',
          ),
        })
        .from(users)
        .where(inArray(users.id, actorIds));
      us.forEach((u: any) => actorMap.set(u.id, u.name));
    }

    type PayEv = {
      id: string;
      kind: 'payment_confirmed';
      at: string;
      amountKobo: number;
      payerName: string | null;
      reference: string | null;
      actor: string | null;
    };
    type InvEv = {
      id: string;
      kind: 'invoice_issued';
      at: string;
      invoiceNumber: string;
      studentName: string | null;
      totalKobo: number;
    };
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

    const severe = severeAgg as
      { severeCount: number; severeKobo: number; noReminderCount: number } | undefined;
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
        title: `${severeCount} student${severeCount === 1 ? '' : 's'} ${reminderRepo.AGING_THRESHOLDS.severeAgingDays}+ days overdue — ${fmt(severeKobo)} at risk`,
        meta:
          noReminderCount > 0
            ? `${noReminderCount} have not received a reminder in the last ${FOLLOWUP_THRESHOLDS.unattendedAfterDays} days. Open Debtors to follow up. All figures here cover every term.`
            : `All severe accounts have been reminded within ${FOLLOWUP_THRESHOLDS.unattendedAfterDays} days; review next steps. Figures cover every term.`,
        href: '/debtors',
      });
    }

    const today = new Date();
    for (const inv of topOverdue as any[]) {
      const days = inv.dueDate
        ? Math.max(1, Math.ceil((today.getTime() - new Date(inv.dueDate).getTime()) / 86400000))
        : 1;
      attention.push({
        id: inv.id,
        kind: 'overdue_invoice',
        severity: days > 60 ? 'danger' : 'warning',
        title: `${inv.studentName || 'A student'} — ${fmt(Number(inv.balance) || 0)} past due`,
        meta: `${inv.invoiceNumber} · ${days} day${days === 1 ? '' : 's'} overdue · ${inv.scopeLabel ?? ''}`.trim(),
        href: `/invoices/${inv.id}`,
      });
    }

    if (staleCount > 0 && severeCount === 0) {
      attention.push({
        id: 'stale-followup',
        kind: 'stale_followup',
        severity: overdueCount > 5 ? 'warning' : 'info',
        title: `${staleCount} overdue student${staleCount === 1 ? '' : 's'} have had no reminder in ${FOLLOWUP_THRESHOLDS.staleAfterDays} days`,
        meta: 'A one-click printable reminder is available from Debtors. Figures cover every term.',
        href: '/debtors',
      });
    }

    for (const p of reconciliationPays as any[]) {
      const amt = Number(p.amountKobo) || 0;
      const method = (p.method || '').replace(/_/g, ' ').toLowerCase();
      const title =
        p.status === 'DUPLICATE_SUSPECT'
          ? 'Duplicate-suspect payment needs review'
          : p.status === 'CONFIRMED'
            ? `${method === 'bank_transfer' ? 'Bank transfer' : method || 'Payment'} needs matching`
            : `${method === 'bank_transfer' ? 'Bank transfer' : method || 'Payment'} pending confirmation`;
      const meta =
        p.status === 'CONFIRMED'
          ? `${fmt(Number(p.unallocatedKobo) || amt)} still unallocated${p.payerName ? ' from ' + p.payerName : ''} — ref ${p.reference || 'n/a'}`
          : `${fmt(amt)}${p.payerName ? ' from ' + p.payerName : ''} — ref ${p.reference || 'n/a'}`;
      attention.push({
        id: p.id,
        kind: 'pending_payment',
        severity: 'warning',
        title,
        meta,
        href: '/reconcile',
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
      greetingName:
        (session.user as any).firstName || (session.user as any).fullName?.split(' ')[0] || null,
      kpis: {
        billedKobo: billed,
        collectedKobo: collected,
        outstandingKobo: outstanding,
        overdueKobo: overdue,
        unreconciledPayments: unreconciled,
        activeStudents,
        collectionRateBps,
      },
      scope: {
        kpis: {
          scope: scopeDecl.scope,
          label: scopeDecl.label,
          isDefault: scopeDecl.isDefault,
          setting: scopeDecl.setting,
          termId: scopeDecl.termId,
          termName: scopeDecl.termName,
          cutoverOn: scopeDecl.cutoverOn,
          asOf: scopeDecl.asOf,
        },
        activeStudents: {
          scope: 'ALL_TERM',
          label: 'Active students — every term',
        },
        queues: {
          scope: 'ALL_TERM',
          label: 'Arrears, aging and reconciliation cover every term',
        },
      },
      buckets: buckets.map((b) => ({
        key: b.bucket,
        label: aggregates.BUCKET_LABELS[b.bucket],
        invoiceCount: b.invoiceCount,
        billedKobo: b.billedKobo,
        collectedKobo: b.collectedKobo,
        outstandingKobo: b.outstandingKobo,
        overdueKobo: b.overdueKobo,
        draftCount: b.draftCount,
      })),
      thresholds: {
        ...followupThresholdsPayload(),
        severeAgingDays: reminderRepo.AGING_THRESHOLDS.severeAgingDays,
      },
      attention,
      activity,
    } satisfies Summary);
  },
);
