/**
 * GET /api/ready — readiness (H-6).
 *
 * Answers the question a deploy gate and an uptime monitor must ask: "is this
 * build, in this deployment, actually able to serve?" — database connectivity
 * as the least-privileged role, the migrated-schema state this build expects,
 * and a working auth configuration.
 *
 *   200 { status: "ready", ... }        every required check proven good
 *   503 { status: "unavailable", ... }  any required check failed (fail closed)
 *
 * Public by design (middleware allow-list): a monitor has no session, and a
 * gate that cannot be probed is not a gate. The payload is limited to build
 * identity, check names, stable reason codes and small counts — see
 * `lib/ops/readiness.ts` for the disclosure contract.
 *
 * `/api/health` remains the LIVENESS probe and must not be used as a deploy
 * gate: it answers "the process is serving", nothing about dependencies.
 */
import { NextResponse } from 'next/server';
import { probeReadiness } from '@/lib/ops/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const report = await probeReadiness();
  return NextResponse.json(report, {
    status: report.status === 'ready' ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
