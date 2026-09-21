/**
 * SCOLAIRA Next.js Middleware (Edge runtime).
 *
 * IMPORTANT (M3 §4):
 *   Middleware runs on the Edge runtime. It CANNOT open database connections
 *   and therefore CANNOT be the authoritative authentication boundary. It
 *   only performs a COARSE routing optimization: if a request targets a
 *   protected prefix and appears to lack a valid session cookie, redirect
 *   to the login page. The actual trust boundary is `getSession()` in
 *   Node.js route handlers / server actions, which validates the HMAC
 *   signature and looks up the session in Postgres.
 *
 *   If an attacker forges a cookie that passes the cheap syntax check below,
 *   they will reach the route handler which will reject them with 401. No
 *   security decision is made by middleware.
 */
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'sc_session';

/** Cheap syntax check: <43-char base64url>.<digits>.<43-char base64url sig> */
const SESSION_RE = /^[A-Za-z0-9_-]{43}\.\d+\.[A-Za-z0-9_-]{43}$/;

const PUBLIC_PATHS = new Set([
  '/login',
  '/register',
  '/reset',
  '/auth', // reset-confirm landing page (optional)
]);

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/reset-request',
  '/api/auth/reset-confirm',
  '/api/health',
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const p of PUBLIC_API_PREFIXES) if (pathname.startsWith(p)) return true;
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return true;
  // Design-system previews are mock-data-only and explicitly unavailable in production.
  if (pathname.startsWith('/preview')) return true;
  if (pathname === '/') return true;
  return false;
}

function hasSessionCookie(req: NextRequest): boolean {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) return false;
  return SESSION_RE.test(cookie);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Pass through for public paths (including static/health).
  if (isPublic(pathname)) {
    return NextResponse.next({ request });
  }

  // API routes not in the public auth set → if cookie missing/syntactically
  // invalid, return 401 rather than redirecting (API clients expect JSON).
  if (pathname.startsWith('/api/')) {
    if (!hasSessionCookie(request)) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
        { status: 401 },
      );
    }
    return NextResponse.next({ request });
  }

  // Page routes: if no session cookie, redirect to /login.
  if (!hasSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next internals, static assets.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
