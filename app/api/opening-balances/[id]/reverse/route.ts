/**
 * POST /api/opening-balances/[id]/reverse — take a posted carry-in back out.
 *
 * Nothing is deleted. The register row moves from POSTED to REVERSED with the
 * reason attached, and the invoice it created goes through `invoices.voidInvoice`
 * — the same door the invoices surface uses, under the same rules, writing
 * `voided_at`, `voided_reason` and `voided_by` on the invoice. Two records, one
 * transaction, and a trail that shows the mistake instead of hiding it.
 *
 * If money has already been allocated to that carry-in invoice, the ledger refuses
 * to void it and this endpoint says so: the payment is reversed first, through the
 * payments surface. There is exactly one door that can move `paid_kobo`, and an
 * opening-balance correction is not it.
 *
 * A reversal is deliberately NOT available for a row that was only approved or
 * still draft — those are refused by sending them back with a reason on
 * `POST /api/opening-balances/[id]/review`. `REJECTED` and `REVERSED` are terminal,
 * and the amount and category of a reviewed row are frozen (0052), so correcting a
 * reviewed figure always means recording a new one.
 *
 * Authorization: `invoice.void`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode, assertResourceInOrg } from '@/lib/authz';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import * as openingRepo from '@/lib/db/repo/opening-balances';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const BodySchema = z
  .object({
    reason: z.string().trim().min(3, 'Say why this carry-in is being reversed.').max(500),
  })
  .strict();

export const POST = withAuthorizedRoute(
  // `.optional()` so a body-less request is answered by the guard below with the
  // actual requirement, not by the wrapper's generic "Invalid request".
  { action: 'invoice.void', method: 'POST', bodySchema: BodySchema.optional() },
  async (req, { db, ctx, body }, params) => {
    if (body === undefined) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        'A reversal needs a reason on the record. Send a JSON body: {"reason": "…"}.',
        400,
      );
    }
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = BodySchema.parse(body);

    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'opening_balance.reverse',
          path: `/api/opening-balances/${id}/reverse`,
          payload: data,
        });
        if (idem.replay) return idem.replay;

        const existing = await openingRepo.get(tx, ctx, id);
        assertResourceInOrg(ctx, existing, 'Opening balance');

        const updated = await openingRepo.reverse(tx, ctx, id, data.reason);
        const payload = {
          openingBalance: {
            id: updated.id,
            status: updated.status,
            reversalReason: updated.reversalReason,
          },
          note: 'Reversed. The invoice it created is void, the register keeps both records, and the amount is no longer owed.',
        };
        await completeIdempotency(tx, ctx, idem.key, 200, payload);
        return NextResponse.json(payload);
      });
    } catch (e) {
      if (e instanceof RepoInvariantError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }
  },
);
