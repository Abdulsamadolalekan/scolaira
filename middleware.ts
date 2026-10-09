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
  // H-6: the readiness gate. A deploy gate and an uptime monitor have no
  // session; before this entry `/api/ready` did not exist AND an unauthenticated
  // caller could not tell "missing route" from "protected route" (measured:
  // 401 for a non-existent path). The payload it exposes is build identity,
  // check names, stable reason codes and small counts only.
  '/api/ready',
];

/**
 * Paths that are public BY DESIGN and must reach their route handler without a
 * session cookie.
 *
 *   /p/<token>          the parent payment page (H-3/R3: the bearer token is
 *                       the ONLY authority; the route re-validates it and the
 *                       database re-derives the organization from the link row)
 *   /api/p/<token>/...  its view + submit endpoints
 *
 * H-6 measured these as unreachable in a browser: an anonymous payer was
 * redirected to /login (307) and the page's own view call answered 401, so the
 * product's only no-auth, parent-facing journey could not be opened at all —
 * while every test passed, because the suites call the route handlers directly
 * and never traverse middleware. Allowing them here does not grant authority:
 * middleware makes no security decision (see the header), and the handlers plus
 * the public-context policies remain the boundary.
 */
const PUBLIC_PREFIXES = ['/p/', '/api/p/'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const p of PUBLIC_API_PREFIXES) if (pathname.startsWith(p)) return true;
  for (const p of PUBLIC_PREFIXES) if (pathname.startsWith(p)) return true;
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
     * Match all paths except Next internals and static assets.
     *
     * `favicon.ico` was the only icon excluded, which was harmless while the app
     * shipped no icons at all. Now that the App Router file conventions are in
     * use (`app/icon.svg`, `app/apple-icon.png`), those paths were being caught
     * by the auth redirect and answered with `307 -> /login` — so the favicon and
     * the iOS home-screen icon never loaded for the public, which is precisely
     * when they are used (browser tab on /login, link previews, home screen).
     *
     * These exclusions are static, non-tenant brand assets and carry no session
     * or user data, so bypassing the auth redirect for them grants nothing: the
     * files are served verbatim to anyone. Nothing else about the matcher changes
     * — every application route is still authenticated as before.
     *
     * `product/` was added for the same reason and after the same failure. It holds
     * the public site's product plates — captures of this build against the demo
     * dataset, published ON the marketing page by design. Without the exclusion the
     * auth redirect answered `307 -> /login` for every one of them, and `next/image`
     * reported it as `400 The requested resource isn't a valid image` because the
     * optimiser had received the login HTML instead of the file. Measured before the
     * fix: two broken images and two console errors on the public homepage, for
     * signed-out visitors only — which is everybody the page exists for.
     */
    '/((?!_next/static|_next/image|product/|favicon.ico|icon\\.svg|icon\\.png|apple-icon\\.png|apple-icon-precomposed\\.png).*)',
  ],
};
