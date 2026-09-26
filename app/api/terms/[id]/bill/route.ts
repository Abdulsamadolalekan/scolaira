/** POST /api/terms/:id/bill — commit a controlled term billing run. */
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import * as billingRepo from '@/lib/db/repo/billing';
import * as idemRepo from '@/lib/db/repo/idempotency-keys';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BodySchema = z.object({
  overrides: z.array(z.object({
    studentId: z.string().regex(UUID_RE),
    feeAssignmentId: z.string().regex(UUID_RE),
    amountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.enum(['SCHOLARSHIP', 'SIBLING_DISCOUNT', 'STAFF_CHILD', 'EARLY_PAYMENT', 'OTHER']),
    note: z.string().trim().max(500).nullable().optional(),
  })).max(2000).default([]),
});

export const POST = withAuthorizedRoute(
  { action: 'term.bill', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id' } }, { status: 400 });
    }
    const data = body as z.infer<typeof BodySchema>;
    const idemKey = req.headers.get('idempotency-key')?.trim();
    if (idemKey && idemKey.length > 128) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Idempotency-Key must be 128 characters or fewer.' } }, { status: 400 });
    }
    const requestHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');

    try {
      return await db.transaction(async (tx) => {
        if (idemKey) {
          const existing = await idemRepo.acquire(tx, ctx, {
            key: idemKey,
            scope: 'term.bill',
            requestMethod: 'POST',
            requestPath: `/api/terms/${id}/bill`,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          if (existing) {
            if (existing.requestHash && existing.requestHash !== requestHash) {
              return NextResponse.json({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different billing request.' } }, { status: 409 });
            }
            if (existing.responseStatus && existing.responseBody) {
              const replay = NextResponse.json(existing.responseBody, { status: existing.responseStatus });
              replay.headers.set('Idempotent-Replayed', 'true');
              return replay;
            }
            return NextResponse.json({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'This billing request is already in progress.' } }, { status: 409 });
          }
        }

        const result = await billingRepo.billTerm(
          tx,
          ctx,
          id as any,
          data.overrides.map((override) => ({
            studentId: override.studentId as any,
            feeAssignmentId: override.feeAssignmentId as any,
            amountKobo: override.amountKobo,
            reason: override.reason,
            note: override.note ?? null,
          })),
          requestId,
        );
        const response = {
          bill: {
            term: result.term,
            createdInvoices: result.createdInvoices,
            createdLines: result.createdLines,
            unchanged: result.unchanged,
            totalKobo: result.totalKobo,
            waiversKobo: result.waiversKobo,
            invoiceIds: result.invoiceIds,
          },
        };
        if (idemKey) await idemRepo.complete(tx, ctx, idemKey, 200, response);
        return NextResponse.json(response, { status: 200 });
      });
    } catch (error: any) {
      if (error instanceof billingRepo.BillingError) {
        return NextResponse.json({ error: { code: error.billingCode, message: error.message, details: error.details } }, { status: error.status });
      }
      if (error?.code === '23505') {
        // The unique billing key is a database-level last line of defence. A
        // replay can safely be retried and will observe the committed line.
        return NextResponse.json({ error: { code: 'DUPLICATE_BILLING_KEY', message: 'A fee line was billed concurrently. Retry the bill operation to reconcile the committed result.' } }, { status: 409 });
      }
      throw error;
    }
  },
);
