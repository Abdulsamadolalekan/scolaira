/**
 * POST /api/opening-balances/[id]/review — approve or reject a carried-in figure.
 *
 * This is the second pair of eyes, or the honest record that there was not one.
 *
 *   * Approval does NOT change any money. It changes what the next step is
 *     allowed to do: an APPROVED historical balance can be posted; a DRAFT one
 *     cannot. That split is what makes "someone checked this" a fact in the row
 *     rather than a vibe.
 *   * `reviewed_by` is the acting user, always, and `self_reviewed` is derived by
 *     the database from `reviewed_by = created_by`. A one-person school is not
 *     locked out of its own opening balances — no rule anywhere in this schema
 *     requires a second person for waivers, reversals or period closes either —
 *     but the row says who did both, and the surface says it out loud.
 *   * Rejection requires a reason. An APPROVED row may be rejected (the reviewer
 *     changed their mind before posting), but never silently.
 *
 * Authorization: `invoice.issue`. Reviewing a financial figure is the same
 * authority as issuing an invoice, and reusing the boundary is the point — a
 * role that can put a charge on a family can decide whether a carry-in is real.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode, assertResourceInOrg } from '@/lib/authz';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import * as openingRepo from '@/lib/db/repo/opening-balances';

export const runtime = 'nodejs';

const BodySchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().max(500).nullish(),
  })
  .strict();

export const POST = withAuthorizedRoute(
  // `.optional()` so that a request with no JSON body at all reaches the guard
  // below and gets a sentence, instead of the wrapper's generic "Invalid request".
  { action: 'invoice.issue', method: 'POST', bodySchema: BodySchema.optional() },
  async (_req, { db, ctx, body }, params) => {
    if (body === undefined) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        'Say what to do with this figure. Send a JSON body: {"decision": "APPROVE"} or {"decision": "REJECT", "note": "…"}.',
        400,
      );
    }
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = BodySchema.parse(body);

    try {
      return await db.transaction(async (tx) => {
        const existing = await openingRepo.get(tx, ctx, id);
        assertResourceInOrg(ctx, existing, 'Opening balance');

        const updated = await openingRepo.review(tx, ctx, id, data.decision, data.note ?? null);
        return NextResponse.json({
          openingBalance: {
            id: updated.id,
            status: updated.status,
            reviewedBy: updated.reviewedBy,
            reviewNote: updated.reviewNote,
            selfReviewed: updated.selfReviewed,
          },
          note:
            updated.status === 'APPROVED'
              ? 'Approved. It can now be posted to the past term it belongs to.'
              : 'Rejected. The figure stays on the record with the reason.',
        });
      });
    } catch (e) {
      if (e instanceof RepoInvariantError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }
  },
);
