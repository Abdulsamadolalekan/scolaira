/**
 * H-8 — platform route boundary.
 *
 * Every `/api/platform/*` handler is wrapped here. The wrapper is the *only*
 * place that decides whether a platform capability runs, and the only place
 * that can be in support mode.
 *
 * ORDER OF DECISIONS (each one fails closed):
 *
 *   1. Session — 401 without one. A platform administrator is an ordinary
 *      authenticated user first; there is no "platform" login.
 *   2. CSRF — unsafe methods require the same double-submit token the tenant
 *      routes use (frozen H-4 behaviour, reused, not re-implemented).
 *   3. Capability — `canPlatform(session.user.isPlatformAdmin, capability)`.
 *      The flag comes from the database load behind `getSession()`, never from
 *      a cookie or a header, so it cannot be asserted by the client.
 *   4. Support mode — if a verified support cookie is present, the request runs
 *      only if it is BOTH declared `readOnly: true` AND carried by a safe HTTP
 *      method (GET/HEAD/OPTIONS). Everything else is refused with
 *      `SUPPORT_MODE_READ_ONLY` and the refusal is itself audited.
 *
 *      The rule is deliberately the narrowest one available, and it is a
 *      conjunction rather than a list of blessed capabilities, for a measured
 *      reason. The platform capability vocabulary is frozen (H-2) at four
 *      entries, only one of which (`platform.audit.read`) is a read by nature.
 *      The support plane's own reads use `platform.support.enter` — the
 *      capability that means "operate inside a support context", which also
 *      authorises OPENING a window. So an allow-list keyed on capability names
 *      had exactly two possible outcomes, both wrong: refuse support mode's own
 *      read plane (measured: 403 on `GET /api/platform/orgs`), or permit a
 *      future route named after a read capability even when it mutates. Both
 *      halves of the conjunction are load-bearing and each is tested with a
 *      real refusal:
 *
 *        * a POST route declared `readOnly: true` is refused (safe-method half);
 *        * a GET route NOT declared `readOnly` is refused (declaration half).
 *
 *      A new route therefore cannot inherit support-mode access by accident: it
 *      must claim to be a read, and it must still be a GET.
 *   5. Database — the handler body runs inside `withPlatformContext()`, which
 *      asks Postgres to mint the platform proof. If the database declines
 *      (`auth_is_platform_admin_authorized()` false), the call throws and the
 *      wrapper returns 403: the cookie alone conferred nothing.
 */
import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { getSession, getRawSessionCookieValue, requireCsrf, type AuthSession } from '@/lib/auth';
import { canPlatform } from '@/lib/authz';
import type { PlatformCapability } from '@/lib/authz/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/auth/config';
import { withPlatformContext } from '@/lib/db/tenant';
import type { Database } from '@/lib/db';
import {
  SUPPORT_COOKIE_NAME,
  readSupportClaim,
  recordSupportAudit,
  type SupportClaim,
} from './support';

/**
 * Safe HTTP methods. Support mode permits a route only when its method appears
 * here AND the route declares `readOnly`.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Capabilities that are reads BY NATURE, i.e. true whatever the transport. Used
 * for documentation and assertions rather than for the gate: the gate is the
 * declaration-plus-method conjunction above, which cannot be satisfied by a
 * mutation at all.
 */
export const READ_CAPABILITIES: ReadonlySet<PlatformCapability> = new Set<PlatformCapability>([
  'platform.audit.read',
]);

export interface PlatformHandlerContext {
  db: Database;
  session: AuthSession;
  /** Verified read-only claim, present only when the caller is in support mode. */
  support: SupportClaim | null;
  body: unknown;
  query: unknown;
  requestId: string;
}

export type PlatformHandler = (
  req: NextRequest,
  ctx: PlatformHandlerContext,
  params?: unknown,
) => Promise<Response>;

export interface PlatformRouteOptions {
  capability: PlatformCapability;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Defaults to CSRF for unsafe methods, exactly like the tenant wrapper. */
  csrf?: boolean;
  /**
   * The route only reads. Required for any route that must work while a support
   * window is open (together with a safe HTTP method).
   */
  readOnly?: boolean;
  /** Skip the support-mode read-only gate (used by the entry/exit endpoints). */
  allowInSupportMode?: boolean;
  bodySchema?: { parse: (v: unknown) => unknown };
  querySchema?: { parse: (v: unknown) => unknown };
}

/**
 * Raw session-cookie value for the CSRF HMAC. Reads the request first (works
 * with a plain Request in tests) and falls back to the ambient cookie store,
 * mirroring the tenant wrapper's helper.
 */
async function rawSessionId(req: NextRequest): Promise<string> {
  // The CSRF HMAC is keyed on the RAW session id — the first dot-segment of the
  // signed `sc_session` cookie — not on the whole signed value. Passing the
  // signed value here verifies nothing and rejects every unsafe request.
  const fromCookie = (value: string | undefined) => value?.split('.')[0] ?? '';
  try {
    const v = req.cookies?.get?.(SESSION_COOKIE_NAME)?.value;
    if (v) return fromCookie(v);
  } catch {
    /* Request without NextRequest cookie API. */
  }
  return fromCookie(await getRawSessionCookieValue());
}

function requestId(): string {
  return `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

/** Best-effort refusal evidence: an attempted mutation in support mode is recorded. */
async function auditRefusal(
  session: AuthSession,
  support: SupportClaim,
  capability: PlatformCapability,
): Promise<void> {
  try {
    await recordSupportAudit(session.user.id, support.organizationId, 'platform.support.enter', {
      nonce: support.nonce,
      target: capability,
    });
  } catch (e) {
    // Refusal is still refused if the trail cannot be written.
    console.error('support refusal audit failed', e);
  }
}

export function withPlatformRoute(
  options: PlatformRouteOptions,
  handler: PlatformHandler,
): (req: NextRequest, params?: unknown) => Promise<Response> {
  const expectCsrf = options.csrf ?? !SAFE_METHODS.has(options.method);

  return async (req: NextRequest, paramsArg?: unknown) => {
    try {
      // 1. Authenticate.
      const session = await getSession();
      if (!session) {
        return NextResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
          { status: 401 },
        );
      }

      // 2. CSRF (same mechanism as the tenant routes).
      if (expectCsrf) {
        try {
          await requireCsrf(req, await rawSessionId(req));
        } catch (e: unknown) {
          return NextResponse.json(
            {
              error: {
                code: (e as { code?: string })?.code ?? 'CSRF_INVALID',
                message: (e as Error)?.message ?? 'CSRF invalid',
              },
            },
            { status: 403 },
          );
        }
      }

      // 3. Capability — database-loaded identity, not a client claim.
      if (!canPlatform(session.user.isPlatformAdmin, options.capability)) {
        return NextResponse.json(
          {
            error: {
              code: 'FORBIDDEN',
              message: `Not authorized to ${options.capability}`,
            },
          },
          { status: 403 },
        );
      }

      // 4. Support mode is strictly read-only: the route must be DECLARED
      //    read-only AND carried by a safe method. Both halves are required, so
      //    neither a declaration alone nor a capability name alone can let a
      //    mutation through.
      const support = await readSupportClaim(session.user.id);
      const permittedInSupportMode = options.readOnly === true && SAFE_METHODS.has(options.method);
      if (support && !options.allowInSupportMode && !permittedInSupportMode) {
        await auditRefusal(session, support, options.capability);
        return NextResponse.json(
          {
            error: {
              code: 'SUPPORT_MODE_READ_ONLY',
              message:
                'Support mode is read-only; this action is not available while viewing another organization',
            },
          },
          { status: 403 },
        );
      }

      // 5. Parse body/query.
      let body: unknown;
      let query: unknown;
      try {
        body = options.bodySchema ? options.bodySchema.parse(await readJson(req)) : undefined;
        if (options.querySchema) {
          const q: Record<string, string> = {};
          const searchParams = req.nextUrl?.searchParams ?? new URL(req.url).searchParams;
          searchParams.forEach((v, k) => {
            q[k] = v;
          });
          query = options.querySchema.parse(q);
        } else {
          query = undefined;
        }
      } catch (e) {
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

      // 6. Database-authorized platform context.
      const result = await withPlatformContext(session.user.id, async (db) => {
        return handler(
          req,
          { db, session, support, body, query, requestId: requestId() },
          paramsArg,
        );
      });

      return result as Response;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // The database refused to mint platform context: the caller is not a
      // platform administrator, whatever the session object said.
      if (code === '28000' || code === '42501') {
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: 'Platform context refused' } },
          { status: 403 },
        );
      }
      console.error('platform route error', e);
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: 'Internal error' } },
        { status: 500 },
      );
    }
  };
}

export { SUPPORT_COOKIE_NAME };
