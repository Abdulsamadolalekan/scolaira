/**
 * POST /api/opening-balances/[id]/post — put an approved carry-in into the ledger.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ONE OPERATION IN PHASE 2 THAT WRITES MONEY. EVERY GUARD IS HERE.
 * ════════════════════════════════════════════════════════════════════════════
 *   What it does, in one transaction: create a DRAFT invoice on the PRIOR term the
 *   balance was recorded against, add ONE ad-hoc line for the carried-in amount,
 *   issue it through the normal status machine, and mark the register row POSTED
 *   with the invoice it became. Those are the same three repository calls the term
 *   billing run makes, so invoice numbering, `total_kobo`, the state machine and
 *   the allocation rules behave exactly as they do for any other invoice. This
 *   route writes no `paid_kobo`, no allocation, no receipt and no payment.
 *
 *   What it refuses, and why each refusal is not a preference:
 *
 *     not APPROVED          → an unreviewed figure must not become a debt.
 *     not HISTORICAL_BALANCE→ credits and unverified figures have no honest place
 *                             in the ledger (see 0052 for the constraint that
 *                             makes this a database rule); a current-term amount
 *                             belongs to term billing, and minting it here would
 *                             charge the child twice the moment billing runs.
 *     no term recorded      → without a past term the buckets cannot tell this
 *                             apart from this-term billing.
 *     term is the active one→ `auth_invoice_scope_buckets` classifies
 *                             `term_id = active term` as CURRENT_TERM *before*
 *                             looking at dates, so a back-dated invoice on the
 *                             active term is reported as this term's billing.
 *     as-at not before the
 *     active term begins    → same reason, from the other side.
 *
 *   The last two are enforced AGAIN by the database (`trg_opening_balance_transition`
 *   re-reads the invoice, its term and the active term), and a second posted
 *   carry-in for the same child on the same term is refused by a partial unique
 *   index. If any of those raise, the invoice insert rolls back with them: there is
 *   no state where the register claims to be posted and the ledger disagrees.
 *
 * REPLAY
 *   `Idempotency-Key` is REQUIRED. A school on a bad connection that posts, sees a
 *   spinner, and presses again must not get two invoices. That is the whole point of
 *   this header, and the reason a UI is not allowed to call this endpoint without it.
 *
 * Authorization: `invoice.issue` — the same authority that puts any other charge on
 * a family, deliberately (no new permission that is true for exactly the same roles).
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
    memo: z.string().max(500).nullish(),
  })
  .strict();

/** Postgres' unique-violation code; the partial index that stops a double posting. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle re-throws driver errors with the Postgres error on `cause`, so the
 * SQLSTATE has to be read from either place. A unique violation is the ONE error
 * this route turns into a 409 with a sentence: it is the school telling itself it
 * is about to charge a child twice, and that deserves an explanation rather than a
 * 500.
 */
function sqlStateOf(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string }; error?: { code?: string } };
  return err?.code ?? err?.cause?.code ?? err?.error?.code;
}

export const POST = withAuthorizedRoute(
  { action: 'invoice.issue', method: 'POST', bodySchema: BodySchema.optional() },
  async (req, { db, ctx, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = BodySchema.parse(body ?? {});

    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'opening_balance.post',
          path: `/api/opening-balances/${id}/post`,
          payload: { id, ...data },
          required: true,
        });
        if (idem.replay) return idem.replay;

        const existing = await openingRepo.get(tx, ctx, id);
        assertResourceInOrg(ctx, existing, 'Opening balance');

        const result = await openingRepo.post(tx, ctx, id, { memo: data.memo ?? null });

        const payload = {
          openingBalance: {
            id: result.balance.id,
            status: result.balance.status,
            amountKobo: Number(result.balance.amountKobo),
            postedInvoiceId: result.invoiceId,
          },
          invoice: {
            id: result.invoiceId,
            number: result.invoiceNumber,
            totalKobo: result.invoiceTotalKobo,
            dueDate: result.dueDate,
            termId: result.termId,
            termName: result.termName,
            line: { id: result.lineId, amountKobo: result.lineAmountKobo },
          },
          note: `Posted to ${result.termName} as ${result.invoiceNumber}. It now appears as prior-term debt, and payments can be allocated against it like any other invoice.`,
        };
        await completeIdempotency(tx, ctx, idem.key, 201, payload);
        return NextResponse.json(payload, { status: 201 });
      });
    } catch (e: unknown) {
      if (e instanceof RepoInvariantError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      if (sqlStateOf(e) === UNIQUE_VIOLATION) {
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'This child already has a posted opening balance on that term, so this one was not posted. Check the register before recording it again — nothing has been changed.',
          409,
        );
      }
      throw e;
    }
  },
);
