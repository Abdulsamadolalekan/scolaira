/**
 * POST /api/payments/:id/confirm — confirm a PENDING payment (payment.confirm).
 *
 * Idempotent: if already CONFIRMED, returns current payment (no duplicate
 * effects). Transactional. Audits the state change.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as payRepo from '@/lib/db/repo/payments';
import * as auditRepo from '@/lib/db/repo/audit-events';
import type { UUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

async function serialize(p: any) {
  return {
    id: p.id, paymentNumber: p.paymentNumber, status: p.status,
    amountKobo: Number(p.amountKobo), unallocatedKobo: Number(p.unallocatedKobo),
    paidAt: p.paidAt,
  };
}

const EmptySchema = z.object({}).optional();
export const POST = withAuthorizedRoute(
  { action: 'payment.confirm', method: 'POST', bodySchema: EmptySchema },
  async (_req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const paymentId = id as UUID;
    return db.transaction(async (tx) => {
      const existing = await payRepo.get(tx, ctx, paymentId);
      assertResourceInOrg(ctx, existing, 'Payment');
      if (existing!.status === 'CONFIRMED') {
        return NextResponse.json({ payment: await serialize(existing), idempotent: true });
      }
      if (existing!.status !== 'PENDING') {
        return NextResponse.json(
          { error: { code: 'BAD_REQUEST', message: `Cannot confirm payment in status ${existing!.status}.` } },
          { status: 400 },
        );
      }
      const confirmed = await payRepo.confirm(tx, ctx, paymentId);
      await auditRepo.record(tx, ctx, {
        action: 'payment.confirm', entityType: 'payment', entityId: confirmed.id,
        after: { status: confirmed.status, paidAt: confirmed.paidAt },
        metadata: { requestId },
      });
      return NextResponse.json({ payment: await serialize(confirmed) });
    });
  },
);
