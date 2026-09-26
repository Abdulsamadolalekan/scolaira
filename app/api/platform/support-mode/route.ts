/**
 * POST   /api/platform/support-mode — enter read-only support mode for an org.
 * DELETE /api/platform/support-mode — leave support mode.
 *
 * Both are `allowInSupportMode`: entry is the one capability that is reachable
 * while a support window is open (it replaces the current window with a newly
 * audited one), and exit must always be possible. Every other platform
 * capability is refused by `withPlatformRoute` while a window is open.
 *
 * Evidence rule: `enterSupportMode` writes `platform.support.enter` BEFORE it
 * returns a signed claim. If that write fails the call rejects and no cookie is
 * issued — a support window without an audit row cannot come into existence.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withPlatformRoute } from '@/lib/platform/route';
import {
  SUPPORT_COOKIE_NAME,
  enterSupportMode,
  exitSupportMode,
  readSupportClaim,
  supportCookieOptions,
} from '@/lib/platform/support';
import { assertNotOwnTenant } from '@/lib/platform/support';
import { cookieStore } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export const POST = withPlatformRoute(
  { capability: 'platform.support.enter', method: 'POST', bodySchema, allowInSupportMode: true },
  async (_req: NextRequest, { session, body }) => {
    const { organizationId, reason } = body as { organizationId: string; reason?: string };

    // A platform administrator who is also a member of the target organization
    // does not need support mode for it; the tenant routes already work.
    if (!(await assertNotOwnTenant(session.user.id, organizationId))) {
      return NextResponse.json(
        {
          error: {
            code: 'ALREADY_MEMBER',
            message: 'You are a member of this organization; support mode is not required',
          },
        },
        { status: 409 },
      );
    }

    const entry = await enterSupportMode(session.user.id, organizationId, { reason });
    if (!entry) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Organization not found' } },
        { status: 404 },
      );
    }

    const store = await cookieStore();
    // The auth cookie-store abstraction takes an options object (same shape the
    // session and active-org writers use).
    store.set({
      name: SUPPORT_COOKIE_NAME,
      value: entry.signedValue,
      ...supportCookieOptions(entry.expiresAt),
    } as never);

    return NextResponse.json({
      support: {
        organizationId: entry.organizationId,
        organizationName: entry.organization.name,
        expiresAt: entry.expiresAt.toISOString(),
        mode: 'READ_ONLY',
        nonce: entry.nonce,
      },
    });
  },
);

export const DELETE = withPlatformRoute(
  { capability: 'platform.support.enter', method: 'DELETE', allowInSupportMode: true },
  async (_req: NextRequest, { session }) => {
    const claim = await readSupportClaim(session.user.id);
    const store = await cookieStore();
    store.delete(SUPPORT_COOKIE_NAME);
    if (!claim) {
      return NextResponse.json({ support: null, note: 'No support window was open' });
    }
    await exitSupportMode(session.user.id, claim);
    return NextResponse.json({ support: null });
  },
);
