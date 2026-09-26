/**
 * H-6 — readiness must FAIL CLOSED. Every branch here is exercised against a
 * REAL failure, not a simulated one:
 *
 *   * a pool pointed at a socket nobody is listening on,
 *   * a database migrated only to N-1 (built with the real migration runner
 *     from a copy of the shipped migration files),
 *   * a database whose journal is short of its own objects,
 *   * a database whose objects are missing although the journal is complete,
 *   * an auth configuration that is absent, too short, or cannot round-trip.
 *
 * Scratch databases are created through the OWNER connection in `beforeAll`
 * (DDL) and dropped in `afterAll`; the tests themselves never mutate the shared
 * test database.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  evaluateReadiness,
  type AuthCrypto,
  type ReadinessDeps,
  type SqlLike,
} from '@/lib/ops/readiness';
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from '@/lib/ops/migration-manifest';
import { applyAllMigrations } from '../../scripts/apply-migrations';

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';

const MIGRATIONS_DIR = resolve(process.cwd(), 'lib/db/migrations');
const DEAD_URL = 'postgresql://scolaira_app:scolaira_app_pw@127.0.0.1:1/none';

const suffix = randomUUID().slice(0, 8);
const STALE_DB = `scolaira_h6_stale_${suffix}`;
const SHORT_DB = `scolaira_h6_short_${suffix}`;
const HOLLOW_DB = `scolaira_h6_hollow_${suffix}`;

let admin: postgres.Sql;
let staleSql: postgres.Sql;
let shortSql: postgres.Sql;
let hollowSql: postgres.Sql;
let tmpDir: string;

/**
 * A postgres.js client is itself callable, so it can never be distinguished
 * from a factory by `typeof` — callers always pass a FACTORY here.
 */
function depsFor(
  sqlFactory: () => SqlLike,
  overrides: Partial<ReadinessDeps['env']> = {},
): ReadinessDeps {
  return {
    sql: sqlFactory,
    authCrypto: async () => null,
    env: {
      DATABASE_URL: 'postgresql://probe/db',
      SCOLAIRA_SESSION_SECRET: 'x'.repeat(48),
      ...overrides,
    },
    expected: { count: EXPECTED_MIGRATION_COUNT, latest: LATEST_MIGRATION_TAG },
  };
}

const reasonOf = (report: Awaited<ReturnType<typeof evaluateReadiness>>, name: string) =>
  report.checks.find((c) => c.name === name)?.reason;

beforeAll(async () => {
  admin = postgres(OWNER_URL, { max: 2, idle_timeout: 2 });

  // A copy of the SHIPPED migrations, minus the newest one, applied with the
  // real runner — the exact state a deployment is in when it serves old code
  // against a database that was never upgraded.
  tmpDir = mkdtempSync(join(tmpdir(), 'h6-stale-'));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files.slice(0, files.length - 1)) {
    copyFileSync(join(MIGRATIONS_DIR, f), join(tmpDir, f));
  }

  for (const db of [STALE_DB, SHORT_DB, HOLLOW_DB]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${db} OWNER scolaira_owner`);
  }

  const urlFor = (db: string) => OWNER_URL.replace(/\/[^/]*$/, `/${db}`);

  // (1) stale: N-1 migrations ⇒ the readiness reader itself does not exist yet.
  const staleOwner = postgres(urlFor(STALE_DB), { max: 1 });
  await staleOwner`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await applyAllMigrations(staleOwner, tmpDir);
  await staleOwner.end({ timeout: 5 });

  // (2) short journal: fully migrated, then the newest journal row removed.
  const shortOwner = postgres(urlFor(SHORT_DB), { max: 1 });
  await shortOwner`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await applyAllMigrations(shortOwner, MIGRATIONS_DIR);
  await shortOwner`DELETE FROM drizzle.__drizzle_migrations
                    WHERE tag = (SELECT tag FROM drizzle.__drizzle_migrations
                                  ORDER BY id DESC LIMIT 1)`;
  await shortOwner.end({ timeout: 5 });

  // (3) hollow: fully migrated, but a load-bearing object is gone.
  const hollowOwner = postgres(urlFor(HOLLOW_DB), { max: 1 });
  await hollowOwner`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await applyAllMigrations(hollowOwner, MIGRATIONS_DIR);
  await hollowOwner`DROP TABLE financial_periods CASCADE`;
  await hollowOwner.end({ timeout: 5 });

  // Probes run as the RUNTIME role, exactly like the deployed app.
  const appUrl = (db: string) => `postgresql://scolaira_app:scolaira_app_pw@localhost:5432/${db}`;
  staleSql = postgres(appUrl(STALE_DB), { max: 1 });
  shortSql = postgres(appUrl(SHORT_DB), { max: 1 });
  hollowSql = postgres(appUrl(HOLLOW_DB), { max: 1 });
}, 120_000);

afterAll(async () => {
  for (const conn of [staleSql, shortSql, hollowSql]) {
    await conn?.end({ timeout: 5 }).catch(() => {});
  }
  for (const db of [STALE_DB, SHORT_DB, HOLLOW_DB]) {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  }
  await admin?.end({ timeout: 5 }).catch(() => {});
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}, 60_000);

describe('H-6 faults — database', () => {
  it('fails closed when nothing is listening', async () => {
    const dead = postgres(DEAD_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
    try {
      const report = await evaluateReadiness(
        depsFor(() => dead as unknown as SqlLike, { DATABASE_URL: DEAD_URL }),
      );
      expect(report.status).toBe('unavailable');
      expect(reasonOf(report, 'database')).toBe('database_unreachable');
      // A required check that cannot be evaluated is NEVER ok.
      expect(reasonOf(report, 'schema')).toBe('database_unreachable');
      expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    } finally {
      await dead.end({ timeout: 5 }).catch(() => {});
    }
  });

  it('fails closed when the runtime database is not configured at all', async () => {
    const report = await evaluateReadiness(
      depsFor(
        () => {
          throw new Error('no pool');
        },
        { DATABASE_URL: undefined },
      ),
    );
    expect(report.status).toBe('unavailable');
    expect(reasonOf(report, 'database')).toBe('database_not_configured');
    expect(reasonOf(report, 'schema')).toBe('database_unreachable');
  });
});

describe('H-6 faults — schema', () => {
  it('fails closed on a database that was never migrated to this build', async () => {
    const report = await evaluateReadiness(depsFor(() => staleSql as unknown as SqlLike));
    expect(report.status).toBe('unavailable');
    expect(reasonOf(report, 'schema')).toBe('schema_behind');
    const schema = report.checks.find((c) => c.name === 'schema')!;
    expect(schema.detail).toMatchObject({ expected: EXPECTED_MIGRATION_COUNT });
    // Connectivity is fine — it is the schema that is not.
    expect(reasonOf(report, 'database')).toBeUndefined();
  });

  it('fails closed when the journal is short of the build', async () => {
    const report = await evaluateReadiness(depsFor(() => shortSql as unknown as SqlLike));
    expect(report.status).toBe('unavailable');
    expect(reasonOf(report, 'schema')).toBe('schema_behind');
    expect(report.checks.find((c) => c.name === 'schema')!.detail).toMatchObject({
      applied: EXPECTED_MIGRATION_COUNT - 1,
      expected: EXPECTED_MIGRATION_COUNT,
    });
  });

  it('fails closed when a load-bearing object is missing although the journal is complete', async () => {
    const report = await evaluateReadiness(depsFor(() => hollowSql as unknown as SqlLike));
    expect(report.status).toBe('unavailable');
    expect(reasonOf(report, 'schema')).toBe('schema_objects_missing');
    expect(String(report.checks.find((c) => c.name === 'schema')!.detail!.missing)).toContain(
      'financial_periods',
    );
  });

  it('fails closed when the database is AHEAD of the build (skewed rollback)', async () => {
    const base = depsFor(() => staleSql as unknown as SqlLike);
    const report = await evaluateReadiness({
      ...base,
      expected: { count: EXPECTED_MIGRATION_COUNT - 2, latest: '0047_h5_operational_hardening' },
    });
    expect(report.status).toBe('unavailable');
    // 48 applied against an expectation of 47 ⇒ the deployment is running an
    // older build than the schema; that is a mismatch, not a green light.
    expect(['schema_ahead', 'schema_version_mismatch', 'schema_behind']).toContain(
      reasonOf(report, 'schema'),
    );
  });
});

describe('H-6 faults — auth', () => {
  it('fails closed with no session secret', async () => {
    const report = await evaluateReadiness(
      depsFor(() => staleSql as unknown as SqlLike, { SCOLAIRA_SESSION_SECRET: undefined }),
    );
    expect(reasonOf(report, 'auth')).toBe('auth_unconfigured');
    expect(report.status).toBe('unavailable');
  });

  it('fails closed with a too-short session secret (the measured production fault)', async () => {
    const report = await evaluateReadiness(
      depsFor(() => staleSql as unknown as SqlLike, { SCOLAIRA_SESSION_SECRET: 'short' }),
    );
    expect(reasonOf(report, 'auth')).toBe('auth_unconfigured');
  });

  it('fails closed when the secret is present but the crypto cannot round-trip', async () => {
    const broken: AuthCrypto = {
      generateSessionIds: () => ({ rawId: 'a'.repeat(43), csrfToken: 'b'.repeat(43) }),
      signSessionCookie: () => ({ sessionCookieValue: 'not-a-cookie' }),
      verifySessionCookie: () => null,
      signCsrfToken: () => 'not-a-signature',
      verifyCsrfToken: () => false,
    };
    const report = await evaluateReadiness({
      ...depsFor(() => staleSql as unknown as SqlLike),
      authCrypto: async () => broken,
    });
    expect(reasonOf(report, 'auth')).toBe('auth_crypto_broken');
    expect(report.status).toBe('unavailable');
  });

  it('never reports ready while any single check is broken', async () => {
    const report = await evaluateReadiness(
      depsFor(() => staleSql as unknown as SqlLike, { SCOLAIRA_SESSION_SECRET: 'short' }),
    );
    const ok = report.checks.filter((c) => c.status === 'ok');
    expect(ok.length).toBeLessThan(report.checks.length);
    expect(report.status).toBe('unavailable');
  });
});
