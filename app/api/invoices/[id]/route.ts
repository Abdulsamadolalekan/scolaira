/**
 * GET /api/invoices/:id — single invoice detail for the institutional view.
 *
 * Returns everything a human needs to understand the invoice at a glance:
 *   - identifying metadata (number, student, class, term, session, dates, status)
 *   - line items with description/qty/rate/amount
 *   - the money ladder in kobo: total / paid / allocated / remaining / overdue
 *   - allocations (payments applied, reversals) with actor & timestamp
 *   - activity feed (human-readable audit events scoped to this invoice)
 *
 * The server is the source of truth; the component trusts the API because
 * RLS + authorization already filter to the tenant, and the kobo values are
 * trigger-maintained (never client-computed).
 */
import { NextResponse } from 'next/server';
import { eq, and, inArray, sql, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import {
  invoices, invoiceLines, payments, paymentAllocations, reversals,
} from '@/lib/db/schema/financials';
import { students, terms, academicSessions } from '@/lib/db/schema/academic';
import { users } from '@/lib/db/schema/tenancy';
import { auditEvents } from '@/lib/db/schema/platform';
import type { UUID } from '@/lib/db/repo/_context';

const fmtDate = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d + 'T00:00:00Z') : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const fmtDateTime = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

const personName = (row: { firstName?: string | null; lastName?: string | null } | null | undefined): string => {
  if (!row) return 'SCOLAIRA';
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || 'SCOLAIRA';
};

type Allocation = {
  id: string;
  paymentId: string;
  paymentNumber: string;
  amountKobo: number;
  status: 'ACTIVE' | 'REVERSED';
  method: string;
  payerName: string | null;
  reference: string | null;
  allocatedAt: string | null;
  allocatedBy: string | null;
  reversedBy: string | null;
  reversedAt: string | null;
  note: string | null;
};

export type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
  memo: string | null;

  student: { id: string; studentId: string; name: string };
  term: { id: string; name: string | null } | null;
  session: { id: string; name: string | null } | null;

  issueDate: string | null;
  dueDate: string | null;
  daysOverdue: number;
  isDue: boolean;

  totalKobo: number;
  paidKobo: number;
  remainingKobo: number;
  overdueKobo: number;

  voidedReason: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  issuedBy: string | null;
  createdAt: string | null;

  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unitRateKobo: number | null;
    adjustmentKobo: number;
    amountKobo: number;
  }>;

  allocations: Allocation[];

  activity: Array<{
    id: string;
    at: string;
    title: string;
    actor: string;
    action: string;
  }>;
};

export const GET = withAuthorizedRoute(
  { action: 'invoice.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const invoiceId = id as UUID;

    // ---------- Invoice + student/term/session/actor ----------
    const invRows = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      memo: invoices.memo,
      studentId: invoices.studentId,
      termId: invoices.termId,
      sessionId: invoices.sessionId,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalKobo: invoices.totalKobo,
      paidKobo: invoices.paidKobo,
      voidedReason: invoices.voidedReason,
      voidedAt: invoices.voidedAt,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
      studentCode: students.studentId,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
      voidedById: invoices.voidedBy,
      createdById: invoices.createdBy,
    })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
      .limit(1);
    const inv = invRows[0];
    if (!inv) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Invoice not found' } }, { status: 404 });
    }

    let term: InvoiceDetail['term'] = null;
    let session: InvoiceDetail['session'] = null;
    if (inv.termId) {
      const t = await db.select({ id: terms.id, name: terms.name }).from(terms)
        .where(and(eq(terms.id, inv.termId), eq(terms.organizationId, ctx.organizationId))).limit(1);
      if (t[0]) term = { id: t[0].id, name: t[0].name };
    }
    if (inv.sessionId) {
      const s = await db.select({ id: academicSessions.id, name: academicSessions.name }).from(academicSessions)
        .where(and(eq(academicSessions.id, inv.sessionId), eq(academicSessions.organizationId, ctx.organizationId))).limit(1);
      if (s[0]) session = { id: s[0].id, name: s[0].name };
    }

    // ---------- Lines ----------
    const lines = await db.select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitRateKobo: invoiceLines.unitRateKobo,
      adjustmentKobo: invoiceLines.adjustmentKobo,
      amountKobo: invoiceLines.amountKobo,
    }).from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(invoiceLines.createdAt);

    // ---------- Allocations (with payment + allocator + reverser) ----------
    const allocRows = await db.select({
      id: paymentAllocations.id,
      paymentId: paymentAllocations.paymentId,
      amountKobo: paymentAllocations.amountKobo,
      status: paymentAllocations.status,
      allocatedAt: paymentAllocations.allocatedAt,
      note: paymentAllocations.note,
      createdById: paymentAllocations.createdBy,
      reversalId: paymentAllocations.reversalId,
      // payment side
      payNum: payments.paymentNumber,
      payMethod: payments.method,
      payPayerName: payments.payerName,
      payReference: payments.reference,
    }).from(paymentAllocations)
      .leftJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(eq(paymentAllocations.invoiceId, invoiceId))
      .orderBy(desc(paymentAllocations.allocatedAt));

    // Resolve actor names for allocators.
    const allocatorIds = Array.from(new Set(allocRows.map(r => r.createdById).filter(Boolean))) as string[];
    const actorMap = new Map<string, string>();
    if (allocatorIds.length) {
      const us = await db.select({
        id: users.id, fn: users.firstName, ln: users.lastName,
      }).from(users).where(inArray(users.id, allocatorIds));
      us.forEach(u => actorMap.set(u.id, personName({ firstName: u.fn, lastName: u.ln })));
    }

    // If any allocation is reversed, look up the reversal to pull reversed_by/at.
    // (Reversals FK is set after allocation creation. Schema has a reversalId col.)
    const reversedByMap = new Map<string, { by: string | null; at: string | null }>();
    const reversalIds = allocRows.map(r => r.reversalId).filter(Boolean) as string[];
    if (reversalIds.length) {
      const revs = await db.select({
        id: reversals.id,
        reversedBy: reversals.reversedBy,
        reversedAt: reversals.reversedAt,
      }).from(reversals).where(inArray(reversals.id, reversalIds));
      const revUserIds = Array.from(new Set(revs.map(r => r.reversedBy).filter(Boolean))) as string[];
      const revUserMap = new Map<string, string>();
      if (revUserIds.length) {
        const us = await db.select({ id: users.id, fn: users.firstName, ln: users.lastName }).from(users).where(inArray(users.id, revUserIds));
        us.forEach(u => revUserMap.set(u.id, personName({ firstName: u.fn, lastName: u.ln })));
      }
      revs.forEach(r => reversedByMap.set(r.id, {
        by: r.reversedBy ? revUserMap.get(r.reversedBy) ?? null : null,
        at: r.reversedAt ? new Date(r.reversedAt).toISOString() : null,
      }));
    }

    const allocations: Allocation[] = allocRows.map(r => {
      const rev = r.reversalId ? reversedByMap.get(r.reversalId) : undefined;
      return {
        id: r.id,
        paymentId: r.paymentId,
        paymentNumber: r.payNum ?? '—',
        amountKobo: Number(r.amountKobo) || 0,
        status: r.status,
        method: r.payMethod ?? 'OTHER',
        payerName: r.payPayerName ?? null,
        reference: r.payReference ?? null,
        allocatedAt: r.allocatedAt ? new Date(r.allocatedAt).toISOString() : null,
        allocatedBy: r.createdById ? actorMap.get(r.createdById) ?? null : null,
        reversedBy: rev?.by ?? null,
        reversedAt: rev?.at ?? null,
        note: r.note ?? null,
      };
    });

    // ---------- Activity feed (audit events for this invoice + derived events) ----------
    const audit = await db.select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorLabel: auditEvents.actorLabel,
      actorFirstName: sql<string | null>`(select first_name from users where id = ${auditEvents.actorUserId})`,
      actorLastName:  sql<string | null>`(select last_name  from users where id = ${auditEvents.actorUserId})`,
      createdAt: auditEvents.createdAt,
      metadata: auditEvents.metadata,
    }).from(auditEvents)
      .where(and(
        eq(auditEvents.entityId as any, invoiceId),
        eq(auditEvents.entityType, 'invoice'),
      ))
      .orderBy(desc(auditEvents.createdAt))
      .limit(20);

    // Build a derived, human timeline from allocations + status (always accurate).
    const derived: InvoiceDetail['activity'] = [];
    for (const a of allocations) {
      if (a.status === 'ACTIVE') {
        derived.push({
          id: `alloc:${a.id}`,
          at: a.allocatedAt ?? new Date(0).toISOString(),
          actor: a.allocatedBy || 'SCOLAIRA',
          action: 'payment.allocated',
          title: `${fmtKobo(a.amountKobo)} allocated from ${a.paymentNumber} (${formatMethod(a.method)})${a.payerName ? ' by ' + a.payerName : ''}${a.allocatedBy ? ' — recorded by ' + a.allocatedBy : ''}`,
        });
      } else if (a.status === 'REVERSED') {
        derived.push({
          id: `rev:${a.id}`,
          at: a.reversedAt ?? new Date(0).toISOString(),
          actor: a.reversedBy || 'SCOLAIRA',
          action: 'allocation.reversed',
          title: `${fmtKobo(a.amountKobo)} allocation from ${a.paymentNumber} reversed${a.reversedBy ? ' by ' + a.reversedBy : ''}`,
        });
      }
    }
    if (inv.issuedAt) {
      derived.push({
        id: 'issued',
        at: new Date(inv.issuedAt).toISOString(),
        actor: (inv.createdById ? await resolveName(db, inv.createdById, personName) : null) || 'SCOLAIRA',
        action: 'invoice.issued',
        title: `Invoice ${inv.invoiceNumber} issued`,
      });
    }
    // Add audit events that don't duplicate derived events.
    for (const ev of audit) {
      const actor = (ev.actorLabel)
        || personName({ firstName: ev.actorFirstName, lastName: ev.actorLastName });
      const at = ev.createdAt ? new Date(ev.createdAt).toISOString() : new Date(0).toISOString();
      derived.push({
        id: ev.id,
        at,
        actor,
        action: ev.action,
        title: auditSentence(ev.action, inv.invoiceNumber, (ev.metadata as any) ?? {}, actor),
      });
    }
    derived.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // ---------- Money ladder ----------
    const total = Number(inv.totalKobo) || 0;
    const paid  = Number(inv.paidKobo) || 0;
    const remaining = Math.max(0, total - paid);
    const today = new Date();
    let overdueAmt = 0;
    let daysOverdue = 0;
    let isDue = false;
    if (inv.dueDate && (inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID') && remaining > 0) {
      const due = new Date(inv.dueDate + 'T00:00:00Z');
      const diffMs = today.getTime() - due.getTime();
      daysOverdue = Math.max(0, Math.ceil(diffMs / 86400000));
      isDue = diffMs >= 0;
      overdueAmt = isDue ? remaining : 0;
    }

    let voidedByName: string | null = null;
    if (inv.voidedById) voidedByName = await resolveName(db, inv.voidedById, personName);

    let issuedByName: string | null = null;
    if (inv.createdById) issuedByName = await resolveName(db, inv.createdById, personName);

    return NextResponse.json({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      memo: inv.memo ?? null,
      student: { id: inv.studentId, studentId: inv.studentCode || '', name: personName({ firstName: inv.studentFirstName, lastName: inv.studentLastName }) },
      term, session,
      issueDate: fmtDate(inv.issueDate),
      dueDate: fmtDate(inv.dueDate),
      daysOverdue, isDue,
      totalKobo: total, paidKobo: paid, remainingKobo: remaining, overdueKobo: overdueAmt,
      voidedReason: inv.voidedReason ?? null,
      voidedAt: fmtDateTime(inv.voidedAt),
      voidedBy: voidedByName,
      issuedBy: issuedByName,
      createdAt: fmtDateTime(inv.createdAt),
      lines: lines.map(l => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unitRateKobo: l.unitRateKobo != null ? Number(l.unitRateKobo) : null,
        adjustmentKobo: Number(l.adjustmentKobo) || 0,
        amountKobo: Number(l.amountKobo) || 0,
      })),
      allocations,
      activity: derived.slice(0, 25),
    } satisfies InvoiceDetail);
  },
);

function fmtKobo(k: number) {
  return '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatMethod(m: string) {
  return m.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function resolveName(
  db: any,
  userId: string,
  nameOf: (u: { firstName?: string | null; lastName?: string | null }) => string,
): Promise<string | null> {
  const rows = await db.select({ fn: users.firstName, ln: users.lastName }).from(users).where(eq(users.id, userId)).limit(1);
  const r = rows[0] as { fn: string | null; ln: string | null } | undefined;
  return r ? nameOf({ firstName: r.fn, lastName: r.ln }) : null;
}

function auditSentence(action: string, invoiceNumber: string, _meta: any, actor: string): string {
  switch (action) {
    case 'invoice.voided': return `Invoice ${invoiceNumber} voided by ${actor}`;
    case 'invoice.created': return `Draft invoice ${invoiceNumber} created by ${actor}`;
    case 'invoice.issued': return `Invoice ${invoiceNumber} issued by ${actor}`;
    default: return `${action.replace(/\./g, ' ')} — ${actor}`;
  }
}
