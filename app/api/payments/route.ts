/**
 * GET /api/payments — list payments (payment.read).
 *
 * Returns a deliberately curated projection: enough to understand the
 * register at a glance (method · payer · amount · unallocated · status ·
 * date), with allocation count, without drowning the list in line-item
 * detail. Drilling into /payments/:id gives full allocation visibility.
 */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { payments } from '@/lib/db/schema/financials';

export type PaymentRow = {
  id: string;
  paymentNumber: string;
  method: 'CASH' | 'BANK_TRANSFER' | 'POS' | 'ONLINE' | 'OTHER';
  status: 'PENDING' | 'CONFIRMED' | 'DUPLICATE_SUSPECT' | 'REVERSED' | 'REFUNDED' | 'FAILED' | 'REJECTED';
  amountKobo: number;
  allocatedKobo: number;
  unallocatedKobo: number;
  payerName: string | null;
  reference: string | null;
  paidAt: string | null;
  recordedAt: string | null;
  allocationCount: number;
  needsAttention: boolean;
};

const fmtDateTime = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

export const GET = withAuthorizedRoute(
  { action: 'payment.read', method: 'GET' },
  async (req, { db, ctx }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const where = [eq(payments.organizationId, ctx.organizationId)] as any[];
    if (status && ['PENDING','CONFIRMED','DUPLICATE_SUSPECT','REVERSED','REFUNDED','FAILED','REJECTED'].includes(status)) {
      where.push(eq(payments.status, status as any));
    }

    const rows = await db
      .select({
        id: payments.id,
        paymentNumber: payments.paymentNumber,
        method: payments.method,
        status: payments.status,
        amountKobo: payments.amountKobo,
        unallocatedKobo: payments.unallocatedKobo,
        payerName: payments.payerName,
        reference: payments.reference,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
        allocCount: sql<number>`(select count(*) from payment_allocations pa where pa.payment_id = ${payments.id} and pa.status = 'ACTIVE')`,
        allocSum: sql<number>`coalesce((select sum(pa.amount_kobo) from payment_allocations pa where pa.payment_id = ${payments.id} and pa.status = 'ACTIVE'),0)`,
      })
      .from(payments)
      .where(and(...where))
      .orderBy(sql`coalesce(${payments.paidAt}, ${payments.createdAt}) desc`)
      .limit(200);

    const result: PaymentRow[] = rows.map((r: any) => {
      const amount = Number(r.amountKobo) || 0;
      const allocated = Number(r.allocSum) || 0;
      const unalloc = Number(r.unallocatedKobo) ?? (amount - allocated);
      const needsAttention =
        r.status === 'PENDING' ||
        r.status === 'DUPLICATE_SUSPECT' ||
        r.status === 'FAILED';
      return {
        id: r.id,
        paymentNumber: r.paymentNumber,
        method: r.method,
        status: r.status,
        amountKobo: amount,
        allocatedKobo: allocated,
        unallocatedKobo: unalloc,
        payerName: r.payerName ?? null,
        reference: r.reference ?? null,
        paidAt: fmtDateTime(r.paidAt),
        recordedAt: fmtDateTime(r.createdAt),
        allocationCount: Number(r.allocCount) || 0,
        needsAttention,
      };
    });

    return NextResponse.json({ payments: result });
  },
);
