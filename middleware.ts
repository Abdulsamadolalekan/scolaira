/**
 * SCOLAIRA Next.js Middleware
 *
 * M0 middleware is intentionally minimal. M3/M4 will add:
 *  - Session validation for protected routes
 *  - CSRF token enforcement for mutating requests
 *  - Tenant / organization context injection
 *  - Rate limiting for auth and public endpoints
 *
 * For M0 we only ensure basic response headers that Next.js config headers()
 * already applies — this file exists so that as we add middleware logic there
 * is a known location.
 *
 * The `matcher` below limits middleware to the routes that will eventually
 * require it, and excludes static assets / api health (which must stay fast).
 */
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // M0 passthrough. Explicit response ensures headers from next.config merge in.
  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    /*
     * Match all paths except for:
     *  - _next/static, _next/image (Next.js internals)
     *  - favicon.ico, public assets
     *  - api/health (must be fast for uptime probes)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/health).*)',
  ],
};
