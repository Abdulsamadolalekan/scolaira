/**
 * GET /api/health — LIVENESS (H-6).
 *
 * "Is this process serving?" and nothing else. It deliberately does not touch
 * the database or the auth configuration: a liveness probe that fails when a
 * dependency fails turns a dependency outage into a restart loop, and one that
 * reports on dependencies it never checked is a false green.
 *
 * That second failure mode is what H-6 closed. This endpoint used to return
 * `status: "ok"` together with `checks: { database: "not_configured", auth:
 * "not_configured" }` — a claim about two dependencies it never looked at. It
 * was measured reporting `ok` with the database unreachable, with a 47-of-49
 * schema, and with an unusable session secret, which is how a deployment with
 * a broken database came to look healthy (docs/readiness/H6_SCOPE_MAP.md).
 *
 * The dependency claims are gone. Readiness lives at `GET /api/ready`, which
 * proves database connectivity, migrated-schema state and auth configuration,
 * and fails closed with `503`:
 *
 *   200 { status: "ok",      probe: "liveness",  readiness: "/api/ready" }
 *   503 { status: "unavailable", probe: "readiness", ... }   ← the deploy gate
 */
import { NextResponse } from 'next/server';
import { buildInfo } from '@/lib/ops/build-info';

export const dynamic = 'force-dynamic';

export async function GET() {
  const body = {
    status: 'ok' as const,
    probe: 'liveness' as const,
    /** Where a deployment/monitor should look for real dependency checks. */
    readiness: '/api/ready',
    ...buildInfo(),
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
