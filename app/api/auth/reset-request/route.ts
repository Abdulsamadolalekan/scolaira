import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestPasswordReset, AuthError, clearContext } from '@/lib/auth';
import { clientIpFor } from '@/lib/http/client-ip';

export const runtime = 'nodejs';

const bodySchema = z.object({ email: z.string().trim().toLowerCase().email().max(255) });

/**
 * Request a password reset. We NEVER reveal whether the email exists.
 *
 * IMPORTANT: in production we return only { ok: true }. The reset token is
 * delivered via email (M4). For local development / preview we echo the token
 * so the flow can be completed end-to-end without email infrastructure. The
 * token echo is gated on both NODE_ENV *and* an explicit opt-in env var so a
 * misconfigured production NODE_ENV can never leak tokens.
 */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid email' } }, { status: 400 });
  try {
    // H-4/F9: the reset limiter is keyed per email, but the IP recorded on the
    // token row must still come from the declared proxy topology.
    const ip = clientIpFor(request);
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const result = await requestPasswordReset(parsed.data.email, { ip, userAgent });

    const allowDevEcho =
      process.env.NODE_ENV !== 'production' &&
      process.env.SCOLAIRA_DEV_ECHO_RESET_TOKEN === '1';
    return NextResponse.json({
      ok: true,
      token: allowDevEcho ? result.token : null,
    });
  } catch (e: any) {
    if (e instanceof AuthError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error('reset-request error', e?.code, e?.message);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
