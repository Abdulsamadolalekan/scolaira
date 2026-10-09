import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resetPassword, AuthError, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

const bodySchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(10).max(128),
});

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid request' } }, { status: 400 });
  try {
    await resetPassword(parsed.data.token, parsed.data.password);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AuthError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error('reset-confirm error', e?.code, e?.message, e?.stack?.split('\n')[0]);
    // H-4/F8: never echo internal detail to the caller — the SQLSTATE, index
    // names and stack belong in the server log only.
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
