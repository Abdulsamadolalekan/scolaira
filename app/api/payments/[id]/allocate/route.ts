/**
 * POST /api/payments/:id/allocate — allocate a CONFIRMED payment against one or
 * more invoices (payment.allocate). Transactional across allocations so a
 * partial/multi-invoice allocation either fully succeeds or fully rolls back.
 *
 * Validates per-allocation:
 *  - invoice exists in tenant
 *  - invoice is ISSUED/PARTIALLY_PAID (not DRAFT/VOID/PAID when amount > remaining)
 *  - amount <= payment.unallocated_kobo
 *  - sum(amount) <= payment.unallocated_kobo
 *
 * Triggers enforce the actual balance invariant; this handler pre-flights so
 * error messages are clear, and lets the DB triggers serve as hard guarantee.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as invRepo from '@/lib/db/repo/invoices';
import * as allocRepo from '@/lib/db/repo/payment-allocations';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { sqlState, pgMessage } from '@/lib/db/pg-error';
import type { UUID } from '@/lib/db/repo/_context';
import type { Kobo } from '@/lib/money';
const asKobo = (n: number) => n as Kobo;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Schema = z.object({
  allocations: z.array(z.object({
    invoiceId: z.string().regex(UUID_RE),
    amountKobo: z.number().int().positive(),
    note: z.string().max(500).optional(),
  })).min(1),
});

export const runtime = 'nodejs';

export const POST = withAuthorizedRoute(
  { action: 'payment.allocate', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const paymentId = id as UUID;
    const data = Schema.parse(body);

    return db.transaction(async (tx) => {
      // R2/H-7: allocation is a financial mutation and needs the same
      // Idempotency-Key boundary as payment recording — a double-submitted
      // allocation would otherwise be applied twice whenever the payment still
      // has unallocated funds and the invoice still has outstanding balance.
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'payment.allocate',
        path: `/api/payments/${id}/allocate`,
        payload: { id, ...data },
        required: true,
      });
      if (idem.replay) return idem.replay;

      const payment = await payRepo.get(tx, ctx, paymentId);
      assertResourceInOrg(ctx, payment, 'Payment');
      if (payment!.status !== 'CONFIRMED') {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          `Can only allocate CONFIRMED payments (current status: ${payment!.status}).`, 400);
      }
      const total = data.allocations.reduce((s, a) => s + a.amountKobo, 0);
      if (total > Number(payment!.unallocatedKobo)) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          `Allocations sum to ${total} kobo but only ${Number(payment!.unallocatedKobo)} kobo is unallocated on this payment.`, 400);
      }
      // Pre-flight invoice checks.
      for (const a of data.allocations) {
        const inv = await invRepo.get(tx, ctx, a.invoiceId as UUID);
        assertResourceInOrg(ctx, inv, 'Invoice');
        if (inv!.status === 'DRAFT' || inv!.status === 'VOID') {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
            `Cannot allocate against invoice ${inv!.invoiceNumber} (status ${inv!.status}).`, 400);
        }
      }

      const out: Array<{id:string; invoiceId:string; invoiceNumber:string; amountKobo:number}> = [];
      for (const a of data.allocations) {
        try {
          const r = await allocRepo.allocate(tx, ctx, {
            paymentId, invoiceId: a.invoiceId as UUID, amountKobo: asKobo(a.amountKobo), note: a.note,
          });
          out.push({ id: r.allocation.id, invoiceId: r.invoice.id, invoiceNumber: r.invoice.invoiceNumber, amountKobo: Number(r.allocation.amountKobo) });
        } catch (e: any) {
          if (e instanceof RepoInvariantError) {
            throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
          }
          // R2/H-7: the allocation guards live in the database triggers
          // (check_violation for "exceeds unallocated/outstanding", unique
          // violation for a concurrent duplicate). Surface them as an
          // operator-readable conflict instead of an internal error — the
          // message already tells staff what to do.
          const state = sqlState(e);
          if (state === '23514' || state === '23505') {
            throw new AuthzError(
              AuthzErrorCode.CONFLICT,
              pgMessage(e) ?? 'The allocation could not be applied.',
              409,
            );
          }
          throw e;
        }
      }

      const after = await payRepo.get(tx, ctx, paymentId);
      await auditRepo.record(tx, ctx, {
        action: 'payment.allocate', entityType: 'payment', entityId: paymentId,
        after: { allocations: out, unallocatedKobo: Number(after!.unallocatedKobo), status: after!.status },
        metadata: { requestId, totalAllocated: total },
      });

      const response = { payment: { id: after!.id, status: after!.status, unallocatedKobo: Number(after!.unallocatedKobo) }, allocations: out };
      await completeIdempotency(tx, ctx, idem.key, 200, response);
      return NextResponse.json(response);
    });
  },
);
