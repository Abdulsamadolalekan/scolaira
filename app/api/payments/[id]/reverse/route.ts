/**
 * POST /api/payments/:id/reverse — reverse/refund/correct a payment (payment.reverse).
 *
 * Reversals:
 *  - are append-only (no UPDATE/DELETE per DB triggers)
 *  - consume allocations oldest-first up to `amountKobo`
 *  - decrement invoice.paid_kobo and recompute invoice status
 *  - flip payment to REVERSED if fully reversed
 *
 * Idempotent on (reference) — if a reversal with same reference exists,
 * returns it rather than double-reversing.
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
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const paymentId = id as UUID;
    const data = Schema.parse(body);

    return db.transaction(async (tx) => {
      const payment = await payRepo.get(tx, ctx, paymentId);
      assertResourceInOrg(ctx, payment, 'Payment');
      if (payment!.status === 'PENDING' || payment!.status === 'FAILED' || payment!.status === 'REJECTED') {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST,
          `Cannot reverse a ${payment!.status} payment.`, 400);
      }

      // Idempotency by reference.
      if (data.reference) {
        const existing = await tx.select().from(reversals).where(and(
          eq(reversals.paymentId, paymentId),
          eq(reversals.reference, data.reference),
        )).limit(1);
        if (existing[0]) {
          const resp = NextResponse.json({ reversal: existing[0], idempotent: true });
          resp.headers.set('Idempotent-Replayed', 'true');
          return resp;
        }
      }

      try {
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
        return NextResponse.json({
          reversal: {
            id: rev.id, reversalNumber: rev.reversalNumber, type: rev.type,
            amountKobo: Number(rev.amountKobo), reason: rev.reason, reference: rev.reference,
            reversedAt: rev.reversedAt,
          },
          payment: { id: after!.id, status: after!.status, unallocatedKobo: Number(after!.unallocatedKobo) },
        }, { status: 201 });
      } catch (e) {
        if (e instanceof RepoInvariantError) {
          throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
        }
        throw e;
      }
    });
  },
);
