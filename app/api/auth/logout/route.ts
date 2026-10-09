import { NextResponse } from 'next/server';
import { logout, clearContext, requireCsrf, getRawSessionCookieValue, verifySessionCookie, AuthError } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 *
 * Revokes the presented session and clears the session/CSRF/active-org cookies.
 *
 * CSRF (H-4/F7): this is a state-changing endpoint, so it requires the same
 * double-submit token as every other unsafe method. The token is accepted from
 * the `x-csrf-token` header (fetch callers) or from a `_csrf` form field, which
 * is what the app-shell's sign-out form posts — the form keeps working without
 * JavaScript.
 *
 * A request that carries no verifiable session cookie has nothing to revoke and
 * nothing to protect: it just clears cookies.
 */
export async function POST(request: Request) {
  try {
    const parsed = verifySessionCookie(await getRawSessionCookieValue());
    if (parsed) {
      await requireCsrf(request, parsed.sessionId);
    }
    await logout();
    // If the request accepts HTML (form submit), redirect to login.
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('text/html')) {
      const url = new URL('/login', request.url);
      return NextResponse.redirect(url, 303);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('logout error', e?.code, e?.message);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
