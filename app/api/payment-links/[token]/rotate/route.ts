/**
 * POST /api/payment-links/[token]/rotate — rotate a leaked link's bearer token.
 *
 * H-5. Rotation is the operational remedy the R3 exposure report recommends
 * once a link's URL is known to have leaked (a stored row, a screenshot, a
 * forwarded message). It is NOT revocation: the link keeps its identity —
 * id, invoice/student binding, amount, expiry, and the provenance of every
 * payment already attributed to it — and only the bearer secret changes.
 *
 * Security properties this handler is responsible for:
 *   - authorization is OWNER-only (`payment_link.rotate`); a finance officer
 *     may revoke but may not silently retire a credential the school is using;
 *   - tenant isolation: the link is read and rotated through the tenant-scoped
 *     handle with an explicit organization predicate, so a token from another
 *     school resolves to nothing;
 *   - the new token is generated in-process (`nanoid`, never read back) and the
 *     old one is never echoed in the response, the audit trail or the logs;
 *   - the audit trail records identifiers and the rotation count only;
 *   - a successful rotation is recorded as a durable operational signal
 *     (`link_rotated`) so the abuse/incident view shows what happened, not just
 *     that something was refused.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
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

export const POST = withAuthorizedRoute(
  { action: 'payment_link.rotate', method: 'POST', bodySchema: Schema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { token } = await resolve(params);
    const data = Schema.parse(body ?? {});

    const rows = await db
      .select({
        id: paymentLinks.id,
        status: paymentLinks.status,
        rotationCount: paymentLinks.tokenRotationCount,
        expiresAt: paymentLinks.expiresAt,
      })
      .from(paymentLinks)
      .where(and(eq(paymentLinks.organizationId, ctx.organizationId), eq(paymentLinks.token, token)))
      .limit(1);

    const link = rows[0];
    if (!link) {
      // Same disposition as an unknown token: no oracle for "this link exists
      // in another school".
      throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Payment link not found.', 404);
    }
    if (link.status !== 'ACTIVE') {
      // The database trigger enforces this too (fail closed); refusing here
      // gives the operator a readable message instead of a 500.
      return NextResponse.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: `Only an active payment link can be rotated (this link is ${link.status}).`,
          },
        },
        { status: 400 },
      );
    }

    const newToken = nanoid(24);
    const updated = await db.transaction(async (tx) => {
      const rotated = await linkRepo.rotateToken(tx, ctx, link.id as any, newToken);
      await auditRepo.record(tx, ctx, {
        action: 'payment_link.rotate',
        entityType: 'payment_link',
        entityId: rotated.id,
        before: { rotationCount: link.rotationCount },
        after: { rotationCount: rotated.tokenRotationCount, rotatedAt: rotated.tokenRotatedAt },
        metadata: { requestId, reason: data?.reason ?? null },
      });
      // Operational signal for the abuse/incident view. Best-effort by design:
      // telemetry must never be able to fail an incident response.
      // The event carries counts and a flag only: the operator's free-text
      // reason is recorded in the AUDIT trail (privileged, reviewed) and is
      // deliberately NOT copied into operational telemetry, where it could
      // smuggle a leaked token or a payer's name into a widely-read table.
      const detail = JSON.stringify({
        rotationCount: Number(rotated.tokenRotationCount),
        reasonRecorded: Boolean(data?.reason),
      });
      await tx.execute(sql`savepoint h5_rotate_signal`);
      try {
        await tx.execute(
          sql`select auth_record_public_surface_event('link_rotated', ${rotated.id}::uuid, ${detail}::jsonb)`,
        );
        await tx.execute(sql`release savepoint h5_rotate_signal`);
      } catch (e) {
        // A failed signal must not abort the rotation it is describing.
        await tx.execute(sql`rollback to savepoint h5_rotate_signal`).catch(() => {});
        console.error('[h5] rotation signal dropped', {
          linkId: rotated.id,
          sqlstate: (e as { code?: string })?.code ?? 'unknown',
        });
      }
      return rotated;
    });

    return NextResponse.json({
      link: {
        id: updated.id,
        // The NEW token, so the operator can hand out a working URL. The old
        // one is dead from this moment and is never returned anywhere.
        token: updated.token,
        url: `/p/${updated.token}`,
        rotationCount: updated.tokenRotationCount,
        rotatedAt: updated.tokenRotatedAt,
      },
    });
  },
);
