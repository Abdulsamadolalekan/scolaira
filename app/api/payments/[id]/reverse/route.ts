/**
 * POST /api/payments/:id/reverse — reverse/refund/correct a payment (payment.reverse).
 *
 * Reversals:
 *  - are append-only (no UPDATE/DELETE per DB triggers)
 *  - consume allocations oldest-first up to `amountKobo`
 *  - decrement invoice.paid_kobo and recompute invoice status
 *  - flip payment to REVERSED if fully reversed
 *
 * Idempotency has two independent layers:
 *  1. `Idempotency-Key` (REQUIRED since R2) — the M9 boundary; a retry with the
 *     same key replays the original response.
 *  2. The reversal `reference` — enforced by the database since R2
 *     (`reversals_payment_reference_unique_idx`). Before R2 this was a
 *     SELECT-then-INSERT, and two concurrent requests carrying the same
 *     reference both passed the check and both inserted: measured, a 1,000,000
 *     kobo payment ended up fully reversed by two individually-valid halves of
 *     the same logical correction. The loser of the race now re-reads the
 *     committed winner and answers as an idempotent replay.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as revRepo from '@/lib/db/repo/reversals';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { eq, and } from 'drizzle-orm';
import { reversals } from '@/lib/db/schema/financials';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { sqlState, pgMessage } from '@/lib/db/pg-error';
import type { UUID } from '@/lib/db/repo/_context';
import type { Kobo } from '@/lib/money';
const asKobo = (n: number) => n as Kobo;

const Schema = z.object({
  type: z.enum(['REVERSAL','REFUND','CORRECTION']).default('REVERSAL'),
  amountKobo: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  reference: z.string().trim().max(128).optional(),
});

export const runtime = 'nodejs';

export const POST = withAuthorizedRoute(
  { action: 'payment.reverse', method: 'POST', bodySchema: Schema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const paymentId = id as UUID;
    const data = Schema.parse(body);

    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'payment.reverse',
          path: `/api/payments/${id}/reverse`,
          payload: { id, ...data },
          required: true,
        });
        if (idem.replay) return idem.replay;

        const payment = await payRepo.get(tx, ctx, paymentId);
        assertResourceInOrg(ctx, payment, 'Payment');
        if (payment!.status === 'PENDING' || payment!.status === 'FAILED' || payment!.status === 'REJECTED') {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
            `Cannot reverse a ${payment!.status} payment.`, 400);
        }

        // Reference layer: a committed reversal for this payment with the same
        // reference IS this logical correction; return it rather than acting again.
        if (data.reference) {
          const existing = await tx.select().from(reversals).where(and(
            eq(reversals.paymentId, paymentId),
            eq(reversals.reference, data.reference),
          )).limit(1);
          if (existing[0]) {
            const response = { reversal: existing[0], idempotent: true };
            await completeIdempotency(tx, ctx, idem.key, 200, response);
            const resp = NextResponse.json(response, { status: 200 });
            resp.headers.set('Idempotent-Replayed', 'true');
            return resp;
          }
        }

        const rev = await revRepo.create(tx, ctx, {
          paymentId,
          type: data.type,
          amountKobo: asKobo(data.amountKobo),
          reason: data.reason,
          reference: data.reference,
        });
        const after = await payRepo.get(tx, ctx, paymentId);
        await auditRepo.record(tx, ctx, {
          action: 'payment.reverse', entityType: 'payment', entityId: paymentId,
          after: { reversalId: rev.id, amountKobo: data.amountKobo, status: after!.status },
          reason: data.reason, metadata: { requestId, type: data.type, reference: data.reference ?? null },
        });
        const response = {
          reversal: {
            id: rev.id, reversalNumber: rev.reversalNumber, type: rev.type,
            amountKobo: Number(rev.amountKobo), reason: rev.reason, reference: rev.reference,
            reversedAt: rev.reversedAt,
          },
          payment: { id: after!.id, status: after!.status, unallocatedKobo: Number(after!.unallocatedKobo) },
        };
        await completeIdempotency(tx, ctx, idem.key, 201, response);
        return NextResponse.json(response, { status: 201 });
      });
    } catch (e: any) {
      if (sqlState(e) === '23505') {
        // Lost the (payment_id, reference) race inside the database — the winner
        // is committed by now, so answer with it instead of double-reversing.
        const winner = data.reference
          ? await db.select().from(reversals).where(and(
              eq(reversals.paymentId, paymentId),
              eq(reversals.reference, data.reference),
            )).limit(1)
          : [];
        if (winner[0]) {
          const resp = NextResponse.json({ reversal: winner[0], idempotent: true }, { status: 200 });
          resp.headers.set('Idempotent-Replayed', 'true');
          return resp;
        }
      }
      // R2/H-7: the financial triggers refuse a reversal with `RAISE EXCEPTION`
      // (P0001) — most importantly the documented M2 rule that reversals consume
      // whole allocations. Those messages are written for staff ("reverse entire
      // allocations"), so surface them as a 400 instead of an internal error.
      if (sqlState(e) === 'P0001' || sqlState(e) === '23514') {
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          pgMessage(e) ?? 'The reversal was refused by the financial controls.',
          400,
        );
      }
      if (e instanceof RepoInvariantError) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      }
      throw e;
    }
  },
);
