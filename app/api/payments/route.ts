/**
 * /api/payments
 *   GET  — list (payment.read).
 *   POST — record a payment (payment.record). Transactional + idempotent.
 *          Creates payment (CONFIRMED by default, or PENDING if initialStatus=pending),
 *          then if allocations are supplied atomically applies them (payment.allocate)
 *          and audits the action.
 */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { payments } from '@/lib/db/schema/financials';
import * as payRepo from '@/lib/db/repo/payments';
import * as invRepo from '@/lib/db/repo/invoices';
import * as allocRepo from '@/lib/db/repo/payment-allocations';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { sqlState } from '@/lib/db/pg-error';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import type { UUID } from '@/lib/db/repo/_context';
import type { Kobo } from '@/lib/money';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asKobo = (n: number) => n as Kobo;
const AllocSchema = z.object({
  invoiceId: z.string().regex(UUID_RE),
  amountKobo: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

const CreateSchema = z.object({
  method: z.enum(['CASH','BANK_TRANSFER','POS','ONLINE','OTHER']),
  amountKobo: z.number().int().positive(),
  reference: z.string().trim().min(1).max(128).optional(),
  payerName: z.string().trim().min(1).max(160).optional(),
  payerPhone: z.string().max(32).optional(),
  payerEmail: z.string().email().max(255).optional().or(z.literal('')),
  paidAt: z.string().optional(), // ISO timestamp
  notes: z.string().max(2000).optional(),
  initialStatus: z.enum(['PENDING','CONFIRMED']).optional(),
  allocations: z.array(AllocSchema).optional().default([]),
});

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

export const POST = withAuthorizedRoute(
  { action: 'payment.record', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = CreateSchema.parse(body);

    return db.transaction(async (tx) => {
      // R2/H-7: this is a financial mutation, so the Idempotency-Key boundary is
      // REQUIRED (same contract M9 introduced for academic mutations). A retried
      // submit can no longer record a second CONFIRMED payment and allocate the
      // same invoice twice.
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'payment.record',
        path: '/api/payments',
        payload: data,
        required: true,
      });
      if (idem.replay) return idem.replay;

      // Reference duplication guard: if method != CASH and reference supplied,
      // refuse if a CONFIRMED payment already exists with same org/method/reference.
      if (data.method !== 'CASH' && data.reference) {
        const dup = await payRepo.findByReference(tx, ctx, data.method, data.reference);
        if (dup && dup.status !== 'FAILED' && dup.status !== 'REJECTED') {
          throw new AuthzError(AuthzErrorCode.CONFLICT,
            `A ${dup.status.toLowerCase()} payment with reference ${data.reference} already exists (${dup.paymentNumber}).`, 409);
        }
      }

      // Validate allocations' invoices exist in tenant and sum correctly.
      const allocTotal = (data.allocations ?? []).reduce((s, a) => s + a.amountKobo, 0);
      if (allocTotal > data.amountKobo) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          `Sum of allocations (${allocTotal}) exceeds payment amount (${data.amountKobo}).`, 400);
      }
      // Allocations only valid for CONFIRMED (default).
      const initialStatus = data.initialStatus ?? 'CONFIRMED';
      if (initialStatus === 'PENDING' && allocTotal > 0) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          'Cannot allocate against a PENDING payment; confirm it first.', 400);
      }
      for (const a of data.allocations ?? []) {
        const inv = await invRepo.get(tx, ctx, a.invoiceId as UUID);
        assertResourceInOrg(ctx, inv, 'Invoice');
        if (inv!.status === 'VOID' || inv!.status === 'DRAFT') {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
            `Cannot allocate against invoice ${inv!.invoiceNumber} (status ${inv!.status}).`, 400);
        }
      }

      const paidAt = data.paidAt ? new Date(data.paidAt) : (initialStatus === 'CONFIRMED' ? new Date() : undefined);
      const payment = await payRepo.record(tx, ctx, {
        method: data.method,
        amountKobo: asKobo(data.amountKobo),
        reference: data.reference,
        payerName: data.payerName,
        payerPhone: data.payerPhone,
        payerEmail: data.payerEmail || undefined,
        paidAt: paidAt as Date | undefined,
        notes: data.notes,
        initialStatus,
      });

      const allocationsOut: Array<{id: string; invoiceId: string; amountKobo: number}> = [];
      for (const a of data.allocations ?? []) {
        const res = await allocRepo.allocate(tx, ctx, {
          paymentId: payment.id,
          invoiceId: a.invoiceId as UUID,
          amountKobo: asKobo(a.amountKobo),
          note: a.note,
        });
        allocationsOut.push({
          id: res.allocation.id, invoiceId: res.invoice.id, amountKobo: Number(res.allocation.amountKobo),
        });
      }

      await auditRepo.record(tx, ctx, {
        action: initialStatus === 'CONFIRMED' ? 'payment.record' : 'payment.pending',
        entityType: 'payment', entityId: payment.id,
        after: { paymentNumber: payment.paymentNumber, amountKobo: payment.amountKobo, method: payment.method, allocations: allocTotal },
        metadata: { requestId, reference: data.reference ?? null },
      });

      const reRead = await payRepo.get(tx, ctx, payment.id);
      if (reRead && (reRead.status === 'PENDING' || Number(reRead.unallocatedKobo) > 0)) {
        await reconciliationRepo.ensureOpenCase(tx, ctx, {
          paymentId: reRead.id,
          kind: reRead.status === 'PENDING' ? 'TO_CONFIRM' : 'TO_MATCH',
          state: 'UNMATCHED',
          reason: 'Opened from the authoritative payment record; review evidence before deciding.',
        });
      }
      const response = {
        payment: {
          id: reRead!.id,
          paymentNumber: reRead!.paymentNumber,
          method: reRead!.method,
          status: reRead!.status,
          amountKobo: Number(reRead!.amountKobo),
          unallocatedKobo: Number(reRead!.unallocatedKobo),
          reference: reRead!.reference,
          paidAt: reRead!.paidAt,
          allocations: allocationsOut,
        },
      };

      await completeIdempotency(tx, ctx, idem.key, 201, response);
      return NextResponse.json(response, { status: 201 });
    }).catch(async (e: any) => {
      if (e instanceof RepoInvariantError) {
        return NextResponse.json({ error: { code: 'BAD_REQUEST', message: e.message } }, { status: 400 });
      }
      if (sqlState(e) === '23505') {
        // R2/H-7: the database now owns the "one live payment per reference"
        // invariant (payments_org_reference_live_unique_idx), so a concurrent
        // duplicate loses here. Report it as the conflict the application
        // already intended, naming the surviving payment when it is visible.
        const dup = data.method !== 'CASH' && data.reference
          ? await payRepo.findByReference(db as any, ctx, data.method, data.reference)
          : null;
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: dup
                ? `A ${dup.status.toLowerCase()} payment with reference ${data.reference} already exists (${dup.paymentNumber}).`
                : 'A payment with this reference already exists in this organization.',
            },
          },
          { status: 409 },
        );
      }
      throw e;
    });
  },
);
