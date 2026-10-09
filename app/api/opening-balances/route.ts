/**
 * /api/opening-balances — the money a school carries in, per student.
 *
 *   GET  — the register: every recorded figure, each category's own total, and
 *          what the ledger says is still outstanding against the posted ones.
 *   POST — record one figure (it lands as DRAFT; posting is a separate act on a
 *          separate endpoint, under a separate authority).
 *
 * AUTHORIZATION — no new permission, deliberately.
 *   Reading is `invoice.read`; recording is `invoice.create`. Those are exactly
 *   the two boundaries that already govern "may this person put a number in the
 *   financial record for this school?". Inventing `opening_balance.record` would
 *   mean a new row in the permission matrix that is true for precisely the same
 *   people, i.e. a second source of truth about who may do a thing.
 *
 * WHY THIS IS NOT THE LEDGER
 *   A recorded figure changes nothing. It cannot move a balance, create a charge
 *   or affect a receipt. It becomes financial truth only through
 *   `POST /api/opening-balances/[id]/post`, and only for the one category the
 *   ledger can represent. See `lib/db/repo/opening-balances.ts` and migration
 *   `0052_opening_balances.sql` for what is refused and why.
 *
 * DUPLICATE PROTECTION
 *   `Idempotency-Key` is optional on this endpoint but honoured: a school on a
 *   slow connection that double-clicks "Record" gets the first row back, not two
 *   rows. The hard protection against double-counting is the partial unique index
 *   on one POSTED carry-in per student per term, which no replay can defeat.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import * as openingRepo from '@/lib/db/repo/opening-balances';
import { MAX_AMOUNT_KOBO, OPENING_BALANCE_CATEGORIES } from '@/lib/db/repo/opening-balances';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RecordSchema = z
  .object({
    studentId: z.string().uuid(),
    category: z.enum(OPENING_BALANCE_CATEGORIES),
    /** Kobo, always a positive whole number. The register stores the magnitude;
     *  the sign is derived from the category by the database, never typed. */
    amountKobo: z
      .number()
      .int('Amount must be in whole kobo.')
      .positive('Enter an amount above zero.')
      .max(MAX_AMOUNT_KOBO, 'That amount is too large to be a single carry-in balance.'),
    asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
    termId: z.string().uuid().nullish(),
    // Shape only. The rule itself — a figure must name its source — lives in
    // `validateRecord`, so the sentence a school reads comes from one place and the
    // database CHECK (5..500) is the backstop, not the message.
    sourceNote: z.string().min(1, 'Say where this figure came from.').max(500),
    evidenceRef: z.string().max(160).nullish(),
  })
  .strict();

export const GET = withAuthorizedRoute(
  {
    action: 'invoice.read',
    method: 'GET',
    querySchema: z.object({ studentId: z.string().uuid().optional() }),
  },
  async (_req, { db, ctx, query }) => {
    const filter = query as { studentId?: string };
    try {
      const [rows, totals, prior, current] = await Promise.all([
        openingRepo.list(db, ctx, { studentId: filter.studentId ?? null, limit: 200 }),
        openingRepo.summary(db, ctx),
        openingRepo.priorTerms(db, ctx),
        openingRepo.currentTerm(db, ctx),
      ]);
      return NextResponse.json({
        rows,
        // The summary always describes the WHOLE register, even when the rows
        // are filtered to one student, so a surface never shows a per-student
        // figure under a label that says "this school".
        summary: totals,
        categories: OPENING_BALANCE_CATEGORIES.map((value) => ({
          value,
          label: openingRepo.OPENING_BALANCE_CATEGORY_LABELS[value],
          postable: openingRepo.categoryIsPostable(value),
        })),
        priorTerms: prior.map((t) => ({
          id: t.id,
          name: t.name,
          startsOn: String(t.startsOn),
        })),
        currentTerm: current
          ? { id: current.id, name: current.name, startsOn: String(current.startsOn) }
          : null,
      });
    } catch (e) {
      if (e instanceof RepoInvariantError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }
  },
);

export const POST = withAuthorizedRoute(
  // `z.unknown()` as the wrapper schema is deliberate: the wrapper only attaches a
  // parsed body when a bodySchema exists, but its ZodError replaces the message with
  // the generic "Invalid request". A school that typed 45,000.5 or left the source
  // out is told which field, in this endpoint's own words, because the real parse
  // happens below against `RecordSchema`.
  { action: 'invoice.create', method: 'POST', bodySchema: z.unknown() },
  async (req, { db, ctx, body }) => {
    if (body === undefined) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        'Send the figure as JSON: the child, what kind of balance it is, the amount in kobo, the date it was true as at, and where it came from.',
        400,
      );
    }
    const parsed = RecordSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        first?.message ?? 'That request could not be read.',
        400,
      );
    }
    const data = parsed.data;
    try {
      // The callback returns the Response, so a replayed request comes back as the
      // stored response — headers included — rather than being re-wrapped here.
      const response = await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'opening_balance.record',
          path: '/api/opening-balances',
          payload: data,
        });
        if (idem.replay) return idem.replay;

        const created = await openingRepo.record(tx, ctx, {
          studentId: data.studentId,
          category: data.category,
          amountKobo: data.amountKobo,
          asAt: data.asAt,
          termId: data.termId ?? null,
          sourceNote: data.sourceNote,
          evidenceRef: data.evidenceRef ?? null,
        });
        const result = {
          openingBalance: {
            id: created.id,
            status: created.status,
            category: created.category,
            amountKobo: Number(created.amountKobo),
            signedAmountKobo: Number(created.signedAmountKobo),
            asAt: String(created.asAt),
            termId: created.termId,
            sourceNote: created.sourceNote,
          },
          note:
            created.category === 'HISTORICAL_BALANCE'
              ? 'Recorded. It becomes a real invoice on the past term once it is approved.'
              : 'Recorded in the register. It stays a record, not a charge, and the register says why.',
        };
        await completeIdempotency(tx, ctx, idem.key, 201, result);
        return NextResponse.json(result, { status: 201 });
      });
      return response;
    } catch (e) {
      if (e instanceof RepoInvariantError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }
  },
);
