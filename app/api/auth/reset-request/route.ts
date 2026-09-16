import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestPasswordReset, AuthError, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

const bodySchema = z.object({ email: z.string().email().max(255) });

/**
 * Request a password reset. We NEVER reveal whether the email exists.
 * The token is returned in the response body ONLY for the M3 test harness.
 * In production this path should send the token via email via a queued job;
 * M4 will wire email delivery.
 */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid email' } }, { status: 400 });
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const result = await requestPasswordReset(parsed.data.email, { ip, userAgent });
    // Never leak existence; return same shape always. The token is returned
    // ONLY for local/dev test — production MUST NOT do this. In production,
    // replace this with: { ok: true } and queue email.
    const devToken = process.env.NODE_ENV !== 'production' ? result.token : undefined;
    return NextResponse.json({ ok: true, token: devToken ?? null });
  } catch (e: any) {
    if (e instanceof AuthError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error('reset-request error', e?.code, e?.message, e?.stack);
    return NextResponse.json({ error: { code: 'INTERNAL', message: String(e?.message ?? e) } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
