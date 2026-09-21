/**
 * Central authorization boundary (M4).
 *
 * Every protected route/handler MUST go through `withAuthorizedRoute()` (for
 * HTTP API routes) or `withAuthorized()` (for server actions / internal
 * service calls). These helpers are the ONLY supported entry points to
 * tenant-scoped business logic. Direct calls to `withTenant` from route
 * handlers are prohibited by architecture (code review; a lint rule could
 * be added later).
 *
 * Flow:
 *   REQUEST
 *     → getSession()       (M3 trust gate; cookie + HMAC + DB lookup)
 *     → requireCsrf()      (for state-changing requests)
 *     → authorize(action)  (policy check against role)
 *     → setTenantContext() (GUCs set; acting_role populated; verified member)
 *     → handler(db, ctx)   (business logic — may load & re-verify resources)
 *     → clearContext()     (always, in finally)
 *
 * Adding a new endpoint:
 *   1. Define the Action in ./permissions.ts and add it to the policy for
 *      every role that legitimately needs it (least privilege).
 *   2. Add a route handler that calls `withAuthorizedRoute`.
 *   3. Add negative tests (wrong role, wrong tenant, anonymous, forged CSRF,
 *      foreign resource, etc.).
 *
 * See docs/security/AUTHORIZATION_MODEL.md for a narrative explanation.
 */
import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { getSession, requireCsrf, clearContext, type AuthSession } from '@/lib/auth';
import { withTenant, type TenantIdentity } from '@/lib/db/tenant';
import { authorize, type Action, type AuthzContext } from './permissions';
import { AuthzError, AuthzErrorCode } from './errors';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

import type { Database } from '@/lib/db';

/**
 * Strongly typed context passed to the route handler.
 *
 *  - db          — tenant-scoped Drizzle handle (already inside withTenant)
 *  - session     — M3 auth session (user, memberships, role, org)
 *  - authz       — role + platform flags for any sub-checks
 *  - ctx         — branded UUIDs for repo calls
 *  - requestId   — per-request id for idempotency/audit correlation
 *  - body/query  — Zod-parsed request data
 */
export interface HandlerContext {
  db: Database;
  session: AuthSession;
  authz: AuthzContext;
  ctx: TenantCtx;
  requestId: string;
  body: unknown;
  query: unknown;
}

/**
 * Route handler signature. The third argument is Next.js's dynamic route
 * params ({ params: Promise<{...}> } in Next 15+, or a sync object in 14).
 * We pass it through as `unknown` so individual handlers can narrow.
 */
type RouteHandler = (
  req: NextRequest,
  ctx: HandlerContext,
  params: unknown,
) => Promise<NextResponse | Response>;

interface RouteOptions {
  action: Action;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  csrf?: boolean;
  bodySchema?: ZodType<unknown, ZodTypeDef, unknown>;
  querySchema?: ZodType<unknown, ZodTypeDef, unknown>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Read and JSON-parse the body on demand; returns unknown or throws BAD_REQUEST. */
async function readJson(req: NextRequest): Promise<unknown> {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return undefined;
    const text = await req.text();
    if (!text) return undefined;
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid JSON body', 400);
  }
}

/** Generate a short per-request correlation id for audit/idempotency. */
function requestId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Execute a route handler behind the central authorization boundary.
 *
 *   - Authenticates the session (401 if missing/revoked/expired).
 *   - Enforces CSRF for unsafe methods (403 if missing/invalid).
 *   - Checks role permission for `action` (403 if denied).
 *   - Enters withTenant with the verified identity; GUCs are cleared in finally.
 *   - Parses body/query through optional Zod schemas (400 on failure).
 *   - Normalizes errors into JSON responses.
 */
export function withAuthorizedRoute(
  options: RouteOptions,
  handler: RouteHandler,
): (req: NextRequest, params?: unknown) => Promise<Response> {
  return async (req: NextRequest, paramsArg?: unknown) => {
    const expectCsrf = options.csrf ?? !SAFE_METHODS.has(options.method);

    try {
      // 1. Authenticate.
      const session = await getSession();
      if (!session) {
        return NextResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
          { status: 401 },
        );
      }

      // 2. CSRF.
      if (expectCsrf) {
        try {
          await requireCsrf(req, await currentRawSessionId(req));
        } catch (e: unknown) {
          await clearContext();
          return NextResponse.json(
            { error: { code: (e as { code?: string })?.code ?? 'CSRF_INVALID', message: (e as Error)?.message ?? 'CSRF invalid' } },
            { status: 403 },
          );
        }
      }

      // 3. Authorize.
      const authz: AuthzContext = {
        role: session.activeRole,
        isPlatformSupport: session.isPlatformSession,
      };
      const decision = authorize(authz, options.action);
      if (!decision.allowed) {
        await clearContext();
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: `Not authorized to ${options.action}` } },
          { status: 403 },
        );
      }

      // 4. Parse body/query.
      let body: unknown;
      let query: unknown;
      try {
        body = options.bodySchema ? options.bodySchema.parse(await readJson(req)) : undefined;
        if (options.querySchema) {
          const q: Record<string, string> = {};
          const searchParams = req.nextUrl?.searchParams ?? new URL(req.url).searchParams;
          searchParams.forEach((v, k) => { q[k] = v; });
          query = options.querySchema.parse(q);
        } else {
          query = undefined;
        }
      } catch (e) {
        await clearContext();
        if (e instanceof ZodError) {
          return NextResponse.json(
            { error: { code: 'BAD_REQUEST', message: 'Invalid request', issues: e.issues } },
            { status: 400 },
          );
        }
        return NextResponse.json(
          { error: { code: 'BAD_REQUEST', message: (e as Error)?.message ?? 'Bad request' } },
          { status: 400 },
        );
      }

      // 5. Execute inside tenant scope.
      const identity: TenantIdentity = {
        organizationId: session.activeOrganizationId,
        userId: session.user.id,
      };
      const result = await withTenant(identity, async (db, dbCtx) => {
        const hctx: HandlerContext = {
          db,
          session,
          authz,
          ctx: dbCtx,
          body,
          query,
          requestId: requestId(),
        };
        return handler(req, hctx, paramsArg);
      });

      return result as Response;
    } catch (e) {
      await clearContext();
      if (e instanceof AuthzError) {
        return NextResponse.json(
          { error: { code: e.code, message: e.message, details: e.details } },
          { status: e.status },
        );
      }
      console.error('route error', e);
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: 'Internal error' } },
        { status: 500 },
      );
    }
  };
}

/** Read the raw session id from the request cookie (for CSRF check). */
async function currentRawSessionId(req: NextRequest): Promise<string> {
  // Some test/build environments attach a Request without NextRequest's
  // extended cookies API; fall back to header parsing.
  let cookie = '';
  try {
    cookie = req.cookies?.get?.('sc_session')?.value ?? '';
  } catch {
    cookie = '';
  }
  if (!cookie) {
    const hdr = req.headers.get('cookie') ?? '';
    const m = hdr.match(/(?:^|;\s*)sc_session=([^;]+)/);
    cookie = m?.[1] ?? '';
  }
  return cookie.split('.')[0] ?? '';
}

// Re-export the resource helper for defense-in-depth org-match checks.
export function assertResourceInOrg(
  ctx: TenantCtx,
  resource: { organizationId?: UUID | null } | null | undefined,
  label: string,
): void {
  if (!resource) {
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, `${label} not found`, 404);
  }
  if (resource.organizationId && resource.organizationId !== ctx.organizationId) {
    // Return 404 (not 403) to avoid leaking existence across tenants.
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, `${label} not found`, 404);
  }
}

// Re-export useful types.
export type { Action, AuthzContext } from './permissions';
export { AuthzError, AuthzErrorCode };

// --------------------------------------------------------------------------
// Sub-services (re-exported for convenience).
// --------------------------------------------------------------------------
export * as Members from './members';
export * as Org from './organization';
export { writeAudit, auditMembershipChange, auditOwnershipTransfer } from './audit';
export { getPolicySnapshot, canPlatform } from './permissions';
