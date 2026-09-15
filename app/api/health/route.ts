/**
 * GET /api/health
 *
 * Liveness / readiness endpoint used by uptime monitors and platform checks.
 *
 * Returns a JSON payload including the current build (commit SHA via
 * NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA when deployed on Vercel), application
 * version, and downstream health. In M0 there are no downstream services to
 * check (DB/auth added in M2/M3), so the endpoint always reports "ok" when
 * the process is serving.
 *
 * Fatal internal errors in the process prevent this route from being reached
 * at all, which is the desired behavior for a basic health probe.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const commitSha = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? 'development';
  const version = process.env.npm_package_version ?? '0.0.0';
  const now = new Date().toISOString();

  const body = {
    status: 'ok' as const,
    version,
    commit: commitSha,
    timestamp: now,
    checks: {
      // M0: no DB/auth yet. M2+ will report 'ok' | 'down' per dependency.
      database: 'not_configured' as const,
      auth: 'not_configured' as const,
    },
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
