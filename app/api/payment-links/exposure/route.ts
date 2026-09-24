/**
 * GET /api/payment-links/exposure — which of MY links still carry a live token
 * inside stored rows, and what to do about it (H-5).
 *
 * The R3 closeout left this as an operational problem with no operator surface:
 * `auth_public_stale_token_exposure()` answers with global counts for the
 * platform, and nothing answered the school's own question — "is any link of
 * mine exposed, which one, and is it still live?". This route is that answer,
 * for the tenant, through the tenant's own session.
 *
 * What it returns never includes the token: the link id, its status, the number
 * of stored payment/audit rows that still contain the token, when they were
 * created, and the recommended action (`ROTATE` while the link is ACTIVE).
 *
 * Authorization: `payment_link.read` (same as listing links).
 */
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'payment_link.read', method: 'GET' },
  async (_req, { db }) => {
    const rows = (await db.execute(sql`
      select link_id, status, at_risk, exposed_payment_rows, exposed_audit_rows,
             first_exposed_at, last_exposed_at, recommended_action
        from auth_public_link_exposure()
    `)) as unknown as Array<Record<string, unknown>>;

    const links = (rows ?? []).map((r) => ({
      linkId: r.link_id as string,
      status: r.status as string,
      atRisk: r.at_risk === true,
      exposedPaymentRows: Number(r.exposed_payment_rows ?? 0),
      exposedAuditRows: Number(r.exposed_audit_rows ?? 0),
      firstExposedAt: r.first_exposed_at ?? null,
      lastExposedAt: r.last_exposed_at ?? null,
      recommendedAction: r.recommended_action as string,
    }));

    return NextResponse.json({
      links,
      // Operational guidance, not decoration: the remedy is rotation, and
      // rotating is owner-only because it retires a credential payers are
      // currently using.
      remedy: links.some((l) => l.recommendedAction === 'ROTATE')
        ? 'Rotate the active links listed above (POST /api/payment-links/{token}/rotate). ' +
          'Stored history is append-only and is not rewritten; rotation makes the exposed ' +
          'token authorize nothing.'
        : 'No active link of yours still carries a live token in stored rows.',
    });
  },
);
