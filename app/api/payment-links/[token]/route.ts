/**
 * PATCH /api/payment-links/[token] — revoke a payment link.
 *
 * Revocation is by public token (not by internal id) because operators copy the
 * link from the list UI which displays the public token. Revocation is
 * idempotent (revoking an already-revoked/expired link is a no-op success).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as linkRepo from '@/lib/db/repo/payment-links';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { paymentLinks } from '@/lib/db/schema';

export const runtime = 'nodejs';

const Schema = z.object({ reason: z.string().max(300).optional() }).optional();

async function resolve(params: unknown): Promise<{ token: string }> {
  const p = await (params as { params: Promise<{ token: string }> }).params;
  return p;
}

export const PATCH = withAuthorizedRoute(
  { action: 'payment_link.revoke', method: 'PATCH', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { token } = await resolve(params);
    const data = Schema.parse(body ?? {});
    // Locate the link in this tenant by token (token is unique across all orgs
    // but RLS + org filter guarantee we only see our own).
    const rows = await db
      .select({ id: paymentLinks.id, status: paymentLinks.status })
      .from(paymentLinks)
      .where(and(eq(paymentLinks.organizationId, ctx.organizationId), eq(paymentLinks.token, token)))
      .limit(1);
    if (!rows[0]) {
      throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Payment link not found.', 404);
    }
    let updated;
    if (rows[0].status === 'REVOKED') {
      updated = rows[0]; // idempotent
    } else {
      updated = await linkRepo.revoke(db, ctx, rows[0].id as any);
      await auditRepo.record(db, ctx, {
        action: 'payment_link.revoke', entityType: 'payment_link', entityId: updated.id,
        after: { status: updated.status, token },
        metadata: { requestId, reason: data?.reason ?? null },
      });
    }
    return NextResponse.json({ link: { id: updated.id, token, status: updated.status } });
  },
);
