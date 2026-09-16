import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getSession,
  changePassword,
  clearContext,
  requireCsrf,
  AuthError,
  verifySessionCookie,
  getRawSessionCookieValue,
} from '@/lib/auth';

export const runtime = 'nodejs';

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
});

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401 },
      );
    }
    const raw = await getRawSessionCookieValue();
    const parsed = verifySessionCookie(raw);
    if (parsed) await requireCsrf(request, parsed.sessionId);

    let body: unknown;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 }); }
    const v = bodySchema.safeParse(body);
    if (!v.success) {
      return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid request' } }, { status: 400 });
    }
    await changePassword(session, v.data.currentPassword, v.data.newPassword);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status },
      );
    }
    console.error('change-password error', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Internal error' } },
      { status: 500 },
    );
  } finally {
    await clearContext();
  }
}
