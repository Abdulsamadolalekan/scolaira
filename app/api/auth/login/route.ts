import { NextResponse } from 'next/server';
import { z } from 'zod';
import { login, AuthError, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

const bodySchema = z.object({
  email: z.string().email().max(255),
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
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
    const userAgent = request.headers.get('user-agent') ?? undefined;
    await login({ ...parsed.data, ip, userAgent });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('login error', e?.code, e?.message, e?.stack?.split('\n')[0]);
    return NextResponse.json({ error: { code: 'INTERNAL', message: String(e?.message ?? e) } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
