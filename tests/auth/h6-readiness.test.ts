/**
 * H-6 — readiness contract against the REAL migrated database.
 *
 * Companion to `docs/readiness/H6_SCOPE_MAP.md`. The fail-closed branches (dead
 * database, stale schema, broken auth) are exercised against real broken
 * databases in `h6-readiness-faults.test.ts`; this file proves the positive
 * contract, the failure signal and that liveness can no longer be confused with
 * readiness.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateReadiness, probeReadiness, type ReadinessDeps } from '@/lib/ops/readiness';
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from '@/lib/ops/migration-manifest';
import { GET as healthGet } from '@/app/api/health/route';
import { getSql } from '@/lib/db';

/** Deps that fail on purpose, with no real database involved. */
function brokenDeps(): ReadinessDeps {
  return {
    sql: () => {
      throw new Error('unreachable in test');
    },
    authCrypto: async () => null,
    env: { DATABASE_URL: 'postgresql://probe@127.0.0.1:1/none', SCOLAIRA_SESSION_SECRET: 'short' },
    expected: { count: EXPECTED_MIGRATION_COUNT, latest: LATEST_MIGRATION_TAG },
  };
}

describe('H-6 readiness — positive contract (real database)', () => {
  it('reports ready on a database migrated to this build, naming every check', async () => {
    const report = await evaluateReadiness();
    expect(report.status).toBe('ready');
    expect(report.probe).toBe('readiness');
    expect(report.checks.map((c) => c.name)).toEqual(['database', 'schema', 'auth']);
    for (const check of report.checks) {
      expect(check.status).toBe('ok');
    }
    expect(report.checks.find((c) => c.name === 'schema')!.detail).toMatchObject({
      applied: EXPECTED_MIGRATION_COUNT,
      expected: EXPECTED_MIGRATION_COUNT,
      latest: LATEST_MIGRATION_TAG,
    });
  });

  it('discloses build identity and nothing else', async () => {
    const report = await evaluateReadiness();
    expect(report.build.version).toBeTruthy();
    expect(report.build.commit).toBeTruthy();
    const serialised = JSON.stringify(report);
    expect(serialised).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialised).not.toMatch(/scolaira_(app|owner)_pw/);
    expect(serialised).not.toContain(process.env.SCOLAIRA_SESSION_SECRET ?? '\u0000');
  });

  it('stays quiet when ready and signals when not', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await probeReadiness();
      expect(spy).not.toHaveBeenCalled();

      const report = await probeReadiness(brokenDeps());
      expect(report.status).toBe('unavailable');
      expect(spy).toHaveBeenCalledTimes(1);

      const line = String(spy.mock.calls[0]![0]);
      expect(line).toContain('readiness_failed');
      expect(line).toContain('database:database_unreachable');
      expect(line).toContain('auth:auth_unconfigured');
      expect(line).toContain(`"expectedMigrations":${EXPECTED_MIGRATION_COUNT}`);
      // The signal must not carry the configuration it is reporting on.
      expect(line).not.toMatch(/postgres(ql)?:\/\//i);
      expect(line).not.toContain('short');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('H-6 liveness — the false green is gone', () => {
  it('does not claim any dependency state', async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.probe).toBe('liveness');
    expect(body.readiness).toBe('/api/ready');
    // The removed fields ARE the defect: they asserted dependency health the
    // handler never checked.
    expect(body.checks).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('not_configured');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('stays live when the database is unreachable — and says where truth lives', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://probe@127.0.0.1:1/none';
    try {
      const res = await healthGet();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.probe).toBe('liveness');
      expect(body.readiness).toBe('/api/ready');
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

describe('H-6 readiness route — HTTP status mapping fails closed', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/ops/readiness');
  });

  it('returns 200 + ready when every check passes', async () => {
    const { GET } = await import('@/app/api/ready/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('returns 503 + unavailable when any required check fails', async () => {
    vi.doMock('@/lib/ops/readiness', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/ops/readiness')>('@/lib/ops/readiness');
      return {
        ...actual,
        probeReadiness: async () => ({
          status: 'unavailable' as const,
          probe: 'readiness' as const,
          build: { version: 'test', commit: 'test', environment: 'test' },
          timestamp: new Date().toISOString(),
          checks: [
            { name: 'database' as const, status: 'fail' as const, reason: 'database_unreachable' },
            { name: 'schema' as const, status: 'fail' as const, reason: 'database_unreachable' },
            { name: 'auth' as const, status: 'ok' as const },
          ],
        }),
      };
    });
    const { GET } = await import('@/app/api/ready/route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.checks.filter((c: { status: string }) => c.status === 'fail')).toHaveLength(2);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('a mocked-away database still cannot produce a ready response', async () => {
    // Guard against a future edit that makes a missing dependency look "ok".
    const report = await evaluateReadiness(brokenDeps());
    expect(report.checks.find((c) => c.name === 'schema')!.status).toBe('fail');
    expect(report.checks.find((c) => c.name === 'schema')!.reason).toBe('database_unreachable');
    expect(getSql).toBeTruthy();
  });
});
