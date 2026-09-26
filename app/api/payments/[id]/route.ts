/**
 * GET /api/payments/:id — payment detail (payment.read).
 *
 * The view of a single payment mirrors the institution's responsibility when
 * money arrives: who paid, how much, by what method, against which invoices,
 * how much is still unallocated (sitting in suspense), and whether anything
 * was reversed.
 *
 * Derived values use trigger-maintained columns (amount_kobo, unallocated_kobo)
 * and ACTIVE allocations only. Never client-computed.
 */
import { NextResponse } from 'next/server';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { payments, paymentAllocations, invoices, reversals } from '@/lib/db/schema/financials';
import { students } from '@/lib/db/schema/academic';
import { users } from '@/lib/db/schema/tenancy';
import type { UUID } from '@/lib/db/repo/_context';

const fmtDateTime = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const nameOf = (r: { firstName?: string | null; lastName?: string | null } | null | undefined): string => {
  if (!r) return 'SCOLAIRA';
  return [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || 'SCOLAIRA';
};

export type PaymentDetail = {
  id: string;
  paymentNumber: string;
  method: 'CASH' | 'BANK_TRANSFER' | 'POS' | 'ONLINE' | 'OTHER';
  status: 'PENDING' | 'CONFIRMED' | 'DUPLICATE_SUSPECT' | 'REVERSED' | 'REFUNDED' | 'FAILED' | 'REJECTED';
  amountKobo: number;
  allocatedKobo: number;
  unallocatedKobo: number;
  payerName: string | null;
  payerPhone: string | null;
  payerEmail: string | null;
  reference: string | null;
  notes: string | null;
  paidAt: string | null;
  recordedAt: string | null;
  recordedBy: string | null;

  allocations: Array<{
    id: string;
    invoiceId: string;
    invoiceNumber: string;
    studentName: string;
    amountKobo: number;
    status: 'ACTIVE' | 'REVERSED';
    allocatedAt: string | null;
    allocatedBy: string | null;
    reversedBy: string | null;
    reversedAt: string | null;
    note: string | null;
  }>;

  reversal: {
    id: string;
    reversalNumber: string;
    type: string;
    amountKobo: number;
    reason: string;
    reference: string | null;
    reversedAt: string | null;
    reversedBy: string | null;
  } | null;

  activity: Array<{
    id: string;
    at: string;
    actor: string;
    action: string;
    title: string;
  }>;
};

export const GET = withAuthorizedRoute(
  { action: 'payment.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const paymentId = id as UUID;

    const payRows = await db.select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      method: payments.method,
      status: payments.status,
      amountKobo: payments.amountKobo,
      unallocatedKobo: payments.unallocatedKobo,
      payerName: payments.payerName,
      payerPhone: payments.payerPhone,
      payerEmail: payments.payerEmail,
      reference: payments.reference,
      notes: payments.notes,
      paidAt: payments.paidAt,
      recordedAt: payments.createdAt,
      recordedById: payments.recordedBy,
    }).from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.organizationId, ctx.organizationId)))
      .limit(1);
    const pay = payRows[0];
    if (!pay) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } }, { status: 404 });
    }

    // Allocations + invoice + student
    const allocs = await db.select({
      id: paymentAllocations.id,
      invoiceId: paymentAllocations.invoiceId,
      amountKobo: paymentAllocations.amountKobo,
      status: paymentAllocations.status,
      allocatedAt: paymentAllocations.allocatedAt,
      note: paymentAllocations.note,
      createdById: paymentAllocations.createdBy,
      reversalId: paymentAllocations.reversalId,
      invNum: invoices.invoiceNumber,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
    }).from(paymentAllocations)
      .leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .leftJoin(students, eq(students.id, invoices.studentId))
      .where(eq(paymentAllocations.paymentId, paymentId))
      .orderBy(desc(paymentAllocations.allocatedAt));

      // Resolve actor names.
      const userIds = Array.from(new Set([pay.recordedById, ...allocs.map(a => a.createdById)].filter(Boolean))) as string[];
      const reversalIds = allocs.map(a => a.reversalId).filter(Boolean) as string[];
      const userMap = await resolveNames(db, userIds);
      const reversalMap = new Map<string, { by: string | null; at: string | null }>();
      let paymentReversal: PaymentDetail['reversal'] = null;
      if (reversalIds.length) {
        const revs = await db.select({
          id: reversals.id, reversedBy: reversals.reversedBy, reversedAt: reversals.reversedAt,
        }).from(reversals).where(inArray(reversals.id, reversalIds));
        const revUserIds = Array.from(new Set(revs.map(r => r.reversedBy).filter(Boolean))) as string[];
        const revUserMap = await resolveNames(db, revUserIds);
        for (const r of revs) {
          reversalMap.set(r.id, {
            by: r.reversedBy ? revUserMap.get(r.reversedBy) ?? null : null,
            at: r.reversedAt ? new Date(r.reversedAt).toISOString() : null,
          });
        }
      }
      // If the payment itself is REVERSED/REFUNDED, pull the payment-level reversal.
      if (pay.status === 'REVERSED' || pay.status === 'REFUNDED') {
        const pr = await db.select({
          id: reversals.id, reversalNumber: reversals.reversalNumber, type: reversals.type,
          amountKobo: reversals.amountKobo, reason: reversals.reason, reference: reversals.reference,
          reversedAt: reversals.reversedAt, reversedById: reversals.reversedBy,
        }).from(reversals)
          .where(and(eq(reversals.paymentId, paymentId)))
          .orderBy(desc(reversals.reversedAt)).limit(1);
        if (pr[0]) {
          const revUserMap = await resolveNames(db, pr[0].reversedById ? [pr[0].reversedById] : []);
          paymentReversal = {
            id: pr[0].id,
            reversalNumber: pr[0].reversalNumber,
            type: pr[0].type,
            amountKobo: Number(pr[0].amountKobo) || 0,
            reason: pr[0].reason,
            reference: pr[0].reference ?? null,
            reversedAt: fmtDateTime(pr[0].reversedAt),
            reversedBy: pr[0].reversedById ? revUserMap.get(pr[0].reversedById) ?? null : null,
          };
        }
      }

    const allocatedTotal = allocs
      .filter(a => a.status === 'ACTIVE')
      .reduce((sum, a) => sum + (Number(a.amountKobo) || 0), 0);

    const allocations: PaymentDetail['allocations'] = allocs.map(a => {
      const rev = a.reversalId ? reversalMap.get(a.reversalId) : undefined;
      return {
        id: a.id,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invNum ?? '—',
        studentName: nameOf({ firstName: a.studentFirstName, lastName: a.studentLastName }),
        amountKobo: Number(a.amountKobo) || 0,
        status: a.status,
        allocatedAt: a.allocatedAt ? new Date(a.allocatedAt).toISOString() : null,
        allocatedBy: a.createdById ? userMap.get(a.createdById) ?? null : null,
        reversedBy: rev?.by ?? null,
        reversedAt: rev?.at ?? null,
        note: a.note ?? null,
      };
    });

    // Build human timeline.
    const activity: PaymentDetail['activity'] = [];
    if (pay.paidAt || pay.status === 'CONFIRMED') {
      activity.push({
        id: 'received',
        at: (pay.paidAt ? new Date(pay.paidAt) : (pay.recordedAt ? new Date(pay.recordedAt) : new Date(0))).toISOString(),
        actor: pay.recordedById ? userMap.get(pay.recordedById) ?? 'SCOLAIRA' : 'SCOLAIRA',
        action: 'payment.received',
        title: `${fmtKobo(Number(pay.amountKobo) || 0)} ${pay.status === 'PENDING' ? 'logged as pending' : 'received'} via ${formatMethod(pay.method)}${pay.payerName ? ' from ' + pay.payerName : ''}`,
      });
    } else if (pay.recordedAt) {
      activity.push({
        id: 'recorded',
        at: new Date(pay.recordedAt).toISOString(),
        actor: pay.recordedById ? userMap.get(pay.recordedById) ?? 'SCOLAIRA' : 'SCOLAIRA',
        action: 'payment.recorded',
        title: `Payment ${pay.paymentNumber} recorded${pay.payerName ? ' for ' + pay.payerName : ''}`,
      });
    }
    for (const a of allocations) {
      if (a.status === 'ACTIVE') {
        activity.push({
          id: `alloc:${a.id}`,
          at: a.allocatedAt ?? new Date(0).toISOString(),
          actor: a.allocatedBy || 'SCOLAIRA',
          action: 'payment.allocated',
          title: `${fmtKobo(a.amountKobo)} allocated to ${a.invoiceNumber} (${a.studentName})`,
        });
      } else {
        activity.push({
          id: `rev:${a.id}`,
          at: a.reversedAt ?? new Date(0).toISOString(),
          actor: a.reversedBy || 'SCOLAIRA',
          action: 'allocation.reversed',
          title: `${fmtKobo(a.amountKobo)} allocation to ${a.invoiceNumber} reversed${a.reversedBy ? ' by ' + a.reversedBy : ''}`,
        });
      }
    }
    if (paymentReversal) {
      activity.push({
        id: `payrev:${paymentReversal.id}`,
        at: paymentReversal.reversedAt ? new Date(paymentReversal.reversedAt).toISOString() : new Date(0).toISOString(),
        actor: paymentReversal.reversedBy || 'SCOLAIRA',
        action: 'payment.reversed',
        title: `Payment reversed (${paymentReversal.reversalNumber}) — ${paymentReversal.reason}`,
      });
    }
    activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return NextResponse.json({
      id: pay.id,
      paymentNumber: pay.paymentNumber,
      method: pay.method,
      status: pay.status,
      amountKobo: Number(pay.amountKobo) || 0,
      allocatedKobo: allocatedTotal,
      unallocatedKobo: Number(pay.unallocatedKobo) ?? Math.max(0, (Number(pay.amountKobo) || 0) - allocatedTotal),
      payerName: pay.payerName ?? null,
      payerPhone: pay.payerPhone ?? null,
      payerEmail: pay.payerEmail ?? null,
      reference: pay.reference ?? null,
      notes: pay.notes ?? null,
      paidAt: fmtDateTime(pay.paidAt),
      recordedAt: fmtDateTime(pay.recordedAt),
      recordedBy: pay.recordedById ? userMap.get(pay.recordedById) ?? null : null,
      allocations, reversal: paymentReversal, activity,
    } satisfies PaymentDetail);
  },
);

async function resolveNames(db: any, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const us = await db.select({ id: users.id, fn: users.firstName, ln: users.lastName })
    .from(users).where(inArray(users.id, ids));
  us.forEach((u: any) => m.set(u.id, nameOf({ firstName: u.fn, lastName: u.ln })));
  return m;
}

function fmtKobo(k: number) {
  return '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatMethod(m: string) { return m.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
