/**
 * POST /api/p/[token]/submit — public teller submission for a payment link.
 *
 * The ONLY unauthenticated mutation in the product. R1 (C-3) established the
 * authority model; R3 (H-3) bounds what the surface may do:
 *
 *   1. A platform-wide submission budget is consumed BEFORE the token is even
 *      looked up (durable attempt counting, so a flood of forged tokens is
 *      bounded too).
 *   2. The link is resolved by token with NO tenant context (bearer lookup).
 *   3. The submission is recorded through `auth_public_submit_payment(token,
 *      key, …)` — the credential-gated entry point that re-resolves the link,
 *      derives the amount due itself, enforces the per-link submission bounds,
 *      and de-duplicates retries. The route never decides an amount, and a
 *      caller-supplied amount is only a claim the database refuses to accept
 *      unless it equals the authoritative amount due (SQLSTATE 22023).
 *   4. Every mutation carries a mandatory `Idempotency-Key`: a retry of the
 *      same submission returns the ORIGINAL outcome instead of creating a
 *      second PENDING row. Submissions are also de-duplicated by identity
 *      (link + bank reference), so a retry from a different device is still a
 *      replay, never a duplicate.
 *   5. Nothing the database says about its internals reaches the payer: every
 *      failure maps to a stable, non-disclosing message.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isPublicLinkUnusable,
  probePublicLinkStatus,
  withPublicScope,
  withScopedDb,
} from '@/lib/db/tenant';
import { getSql } from '@/lib/db';
import { sqlState } from '@/lib/db/pg-error';

export const runtime = 'nodejs';

const Schema = z.object({
  payerName: z.string().min(1).max(160),
  payerPhone: z.string().max(32).optional(),
  payerEmail: z.string().email().max(255).optional().or(z.literal('')),
  reference: z.string().min(1).max(128),
  /** Optional claim; the database derives the amount and refuses a mismatch. */
  amountKobo: z.number().int().positive().optional(),
});

/**
 * Platform-wide public submission budget (defence in depth, applied before
 * token resolution). Per-link bounds are enforced in the database and cannot be
 * bypassed by calling the entry point directly.
 */
const GLOBAL_BUDGET: Array<{ key: string; max: number; window: string }> = [
  { key: 'public-submit:global:minute', max: 120, window: '1 minute' },
  { key: 'public-submit:global:hour', max: 900, window: '1 hour' },
];

function error(code: string, message: string, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

/** Consumes the platform budget. Returns a response to send when it is spent. */
async function budgetExceeded(): Promise<NextResponse | null> {
  const sql = getSql();
  let retryAfter = 0;
  for (const window of GLOBAL_BUDGET) {
    const rows = (await sql`
      select allowed, retry_after_seconds
        from auth_rate_limit_hit(${window.key}, ${window.max}, ${window.window}::interval)
    `) as unknown as Array<{ allowed: boolean; retry_after_seconds: number }>;
    const row = rows[0];
    if (row && !row.allowed) {
      retryAfter = Math.max(retryAfter, Number(row.retry_after_seconds) || 0);
    }
  }
  if (retryAfter <= 0) return null;
  return error(
    'TOO_MANY_REQUESTS',
    'The payment service is receiving too many submissions right now. Please try again in a few minutes.',
    429,
    { 'Retry-After': String(retryAfter) },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // (0) Platform-wide budget, consumed before any bearer is examined.
  try {
    const limited = await budgetExceeded();
    if (limited) return limited;
  } catch (e) {
    // A rate-limit service failure must not open the surface: fail closed.
    console.error('[public-submit] rate limiter unavailable', e);
    return error('SERVICE_UNAVAILABLE', 'The payment service is temporarily unavailable.', 503);
  }

  const idempotencyKey = (req.headers.get('idempotency-key') ?? '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128 || /\s/.test(idempotencyKey)) {
    return error(
      'IDEMPOTENCY_KEY_REQUIRED',
      'This submission is missing its submission key. Reload the page and try again.',
      400,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error('BAD_REQUEST', 'Invalid JSON.', 400);
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return error('BAD_REQUEST', 'Please check the information you entered and try again.', 400);
  }
  const data = parsed.data;

  // (1) Bearer resolution with no tenant context.
  const link = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
    const rows = await sql<any[]>`
      select organization_id, id, status, invoice_id, amount_kobo
        from auth_resolve_public_link(${token})`;
    return rows[0] ?? null;
  });

  if (!link) {
    const status = await probePublicLinkStatus(token);
    if (status === 'EXPIRED') {
      return error('GONE', 'This payment link has expired.', 410);
    }
    // REVOKED maps to 404 to minimize information disclosure.
    return error('NOT_FOUND', 'This payment link is no longer available.', 404);
  }

  try {
    // (2) Credential-gated write. The amount is the caller's CLAIM (or absent);
    //     the database derives the authoritative amount and refuses a mismatch.
    return await withPublicScope(token, async (_db, sql) => {
      const rows = await sql<
        {
          payment_id: string;
          payment_number: string;
          amount_kobo: bigint;
          status: string;
          replayed: boolean;
        }[]
      >`
        select payment_id, payment_number, amount_kobo, status, replayed
          from auth_public_submit_payment(
                 ${token}, ${idempotencyKey}, ${data.amountKobo ?? null}::bigint,
                 ${data.reference.trim()}, ${data.payerName.trim()},
                 ${data.payerPhone?.trim() || null}, ${data.payerEmail?.trim() || null})`;
      const pay = rows[0];
      if (!pay) {
        return error('BAD_REQUEST', 'Could not record payment.', 400);
      }
      const payload = {
        payment: {
          paymentNumber: pay.payment_number,
          amountKobo: Number(pay.amount_kobo),
          status: pay.status,
        },
      };
      // A retry returns the original outcome byte-for-byte; only the status
      // code and the replay header differ, so the payer can tell the two apart
      // while every field stays identical.
      return pay.replayed
        ? NextResponse.json(payload, { status: 200, headers: { 'Idempotent-Replayed': 'true' } })
        : NextResponse.json(payload, { status: 201 });
    });
  } catch (e: unknown) {
    if (isPublicLinkUnusable(e) || sqlState(e) === '28000') {
      return error('NOT_FOUND', 'This payment link is no longer available.', 404);
    }
    switch (sqlState(e)) {
      case '23505':
        // R2/H-7: one live payment per (organization, reference) for every
        // non-CASH method. Report a stable conflict without revealing whether
        // the reference belongs to another submission on this link.
        return error(
          'CONFLICT',
          'A payment with this reference has already been recorded. Check the reference or contact the school office.',
          409,
        );
      case '22023':
        // Amount binding: the claim disagrees with the amount due.
        return error(
          'AMOUNT_MISMATCH',
          'The amount submitted does not match the amount due on this payment link. Reload the page and try again.',
          409,
        );
      case '53400':
        // Per-link submission bound.
        return error(
          'TOO_MANY_REQUESTS',
          'This payment link has received too many submissions. Please try again later or contact the school office.',
          429,
        );
      case '40001':
        return error('CONFLICT', 'Your submission could not be completed. Please try again.', 409);
      case '23000':
        // The submission key was reused for a different submission. Replaying
        // the first outcome would silently discard a real claim, so refuse.
        return error(
          'IDEMPOTENCY_KEY_REUSED',
          'This submission was already recorded for a different payment reference. Reload the page and try again.',
          409,
        );
      case '23514':
      case '22P02':
        return error('BAD_REQUEST', 'Please check the information you entered and try again.', 400);
      default:
        // Never echo database text. Details stay in the server log.
        console.error('[public-submit] unexpected failure', { token: undefined, error: e });
        return error('INTERNAL', 'Could not record payment. Please try again.', 500);
    }
  }
}
