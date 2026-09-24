import { NextResponse } from 'next/server';
import { z } from 'zod';
import { login, AuthError, clearContext } from '@/lib/auth';
import { clientIpFor } from '@/lib/http/client-ip';

export const runtime = 'nodejs';

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid request' } }, { status: 400 });
  }
  try {
    // H-4/F9: same server-derived identity policy as register (and the audit
    // row written by auth_record_login_attempt must not be spoofable either).
    const ip = clientIpFor(request);
    const userAgent = request.headers.get('user-agent') ?? undefined;
    await login({ ...parsed.data, ip, userAgent });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('login error', e);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
