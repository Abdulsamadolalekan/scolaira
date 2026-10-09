/**
 * Readiness — does THIS build, in THIS deployment, actually work (H-6)?
 *
 * `GET /api/health` answers a different question ("is the process serving?")
 * and must keep answering it without touching a dependency. Before H-6 it was
 * the only surface, and it reported `ok` while the database was unreachable,
 * the schema was half-applied and the auth secret was unusable — a deployment
 * with a broken database looked healthy (measured; see docs/readiness/H6_SCOPE_MAP.md).
 *
 * This module is the honest answer, and it FAILS CLOSED:
 *
 *   database  the runtime role can open a connection and run a query
 *             (the pool's `onconnect` guard additionally refuses a role that can
 *             bypass RLS, so "connectable" also means "connectable as the
 *             least-privileged principal");
 *   schema    the migration journal and the load-bearing objects match the
 *             migration set compiled into this build;
 *   auth      the session secret is configured and the real cookie
 *             sign/verify round-trip succeeds.
 *
 * Any required check that cannot be PROVEN good is reported as `fail` with a
 * stable reason code. There is no "unknown", no "skipped" and no partial
 * success path: a probe that cannot tell is not allowed to answer "ready".
 *
 * Disclosure: the report is unauthenticated (a deploy gate and an uptime
 * monitor have no session), so its payload is limited to build identity, check
 * names, stable reason codes and small counts. It never contains a connection
 * string, credential, secret, token, row, SQLSTATE, stack frame or driver
 * message.
 */
import { getSql } from '@/lib/db';
import { sqlState } from '@/lib/db/pg-error';
import { buildInfo, type BuildInfo } from './build-info';
import { logFailure } from './log';
// One definition of "auth is configured", shared with the boot-time line. Kept
// in its own module so the instrumentation hook never imports the database layer.
import { MIN_SESSION_SECRET_BYTES, authSecretUsable } from './auth-config-state';

export { MIN_SESSION_SECRET_BYTES, authSecretUsable };
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from './migration-manifest';

/**
 * The three facts readiness needs from the outside world.
 *
 * Production uses the defaults (the app's own pool, the app's own auth crypto,
 * the process environment, the compiled migration manifest). Tests inject
 * deliberately broken versions — a pool pointed at an unreachable server, a
 * pool bound to a stale database, a crypto module that fails its round-trip —
 * so every fail-closed branch is exercised against a REAL failure rather than
 * a simulated one. Injection is a seam at the boundary, never a bypass: the
 * checks themselves are the same code in every case.
 */
export interface ReadinessDeps {
  /** Query runner bound to the runtime role's pool. */
  sql: () => SqlLike;
  /** Loads the auth crypto module, or resolves null when auth is unusable. */
  authCrypto: () => Promise<AuthCrypto | null>;
  /** Configuration facts (never logged, never returned). */
  env: { DATABASE_URL?: string; SCOLAIRA_SESSION_SECRET?: string };
  /** The schema this build expects. */
  expected: { count: number; latest: string };
}

/** Minimal query surface the checks use (postgres.js `Sql` satisfies it). */
export interface SqlLike {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  array: (values: unknown[]) => unknown;
}

export type ReadinessCheckName = 'database' | 'schema' | 'auth';
export type ReadinessCheckStatus = 'ok' | 'fail';

export interface ReadinessCheck {
  name: ReadinessCheckName;
  status: ReadinessCheckStatus;
  /** Stable machine-readable reason when `status === 'fail'`. Never prose. */
  reason?: string;
  /** Small, non-disclosing facts (counts, tags, object names). */
  detail?: Record<string, string | number | boolean | null>;
}

export interface ReadinessReport {
  status: 'ready' | 'unavailable';
  probe: 'readiness';
  build: BuildInfo;
  timestamp: string;
  checks: ReadinessCheck[];
}

/** A required check that could not be proven good within its budget. */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * Load-bearing objects: if any is absent, the schema is not the schema this
 * build was written against, even if the journal says otherwise (manual
 * surgery, a partially applied migration, a restored dump of the wrong age).
 */
const REQUIRED_TABLES = [
  'organizations',
  'organization_members',
  'users',
  'password_credentials',
  'sessions',
  'academic_sessions',
  'terms',
  'students',
  'invoices',
  'payments',
  'payment_allocations',
  'audit_events',
  'financial_periods',
] as const;

const REQUIRED_FUNCTIONS = [
  'auth_is_tenant_authorized()',
  'auth_is_platform_admin_authorized()',
  'auth_rate_limit_hit(text,integer,interval)',
  'auth_public_submit_payment(text,text,bigint,text,text,text,text)',
  'auth_period_valuation(uuid)',
  'ops_migration_state()',
] as const;

async function withTimeout<T>(
  work: Promise<T>,
  reason: string,
): Promise<T | { __timeout: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<{ __timeout: string }>((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: reason }), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeout(value: unknown): value is { __timeout: string } {
  return typeof value === 'object' && value !== null && '__timeout' in value;
}

// ---------------------- auth ----------------------

export type AuthCrypto = {
  generateSessionIds: () => { rawId: string; csrfToken: string };
  signSessionCookie: (p: { sessionId: string; expiresAt: Date; csrfToken: string }) => {
    sessionCookieValue: string;
  };
  verifySessionCookie: (value: string | undefined) => { sessionId: string; expiresAt: Date } | null;
  signCsrfToken: (csrfToken: string, sessionId: string) => string;
  verifyCsrfToken: (
    headerToken: string | null | undefined,
    cookieCsrf: string | null | undefined,
    sessionId: string,
  ) => boolean;
};

/**
 * The auth crypto module can only be imported successfully when the session
 * secret is configured (`lib/auth/config.ts` refuses to load otherwise). That
 * failure is exactly what the readiness probe must REPORT rather than
 * propagate, so the import is attempted once per process and its outcome is
 * cached.
 */
let authCryptoPromise: Promise<AuthCrypto | null> | null = null;

function loadAuthCrypto(): Promise<AuthCrypto | null> {
  if (!authCryptoPromise) {
    authCryptoPromise = import('@/lib/auth/cookies')
      .then((m) => m as unknown as AuthCrypto)
      .catch(() => null);
  }
  return authCryptoPromise;
}

function authCheck(deps: ReadinessDeps): Promise<ReadinessCheck> {
  return (async (): Promise<ReadinessCheck> => {
    const secret = deps.env.SCOLAIRA_SESSION_SECRET ?? '';
    if (secret.length < MIN_SESSION_SECRET_BYTES) {
      return {
        name: 'auth',
        status: 'fail',
        reason: 'auth_unconfigured',
        detail: { secretConfigured: false },
      };
    }
    const cryptoModule = await deps.authCrypto();
    if (!cryptoModule) {
      return { name: 'auth', status: 'fail', reason: 'auth_unconfigured' };
    }
    try {
      // Mirror exactly what a real login writes and a real request presents:
      // a 32-byte base64url session id, the same double-submit CSRF cookie and
      // the `<token>.<sig>` header. Shapes matter — a synthetic id would fail
      // the verifier's format guard and make the probe report a false alarm.
      const { rawId: sessionId, csrfToken } = cryptoModule.generateSessionIds();
      const expiresAt = new Date(Date.now() + 60_000);
      const signed = cryptoModule.signSessionCookie({ sessionId, expiresAt, csrfToken });
      const verified = cryptoModule.verifySessionCookie(signed.sessionCookieValue);
      const csrfSigned = `${csrfToken}.${cryptoModule.signCsrfToken(csrfToken, sessionId)}`;
      const csrfOk = cryptoModule.verifyCsrfToken(csrfSigned, csrfToken, sessionId);
      const sessionOk = verified?.sessionId === sessionId;

      if (!sessionOk || !csrfOk) {
        return {
          name: 'auth',
          status: 'fail',
          reason: 'auth_crypto_broken',
          detail: { sessionRoundTrip: sessionOk, csrfRoundTrip: csrfOk },
        };
      }
      return {
        name: 'auth',
        status: 'ok',
        detail: { sessionRoundTrip: true, csrfRoundTrip: true },
      };
    } catch {
      return { name: 'auth', status: 'fail', reason: 'auth_crypto_broken' };
    }
  })();
}

// ---------------------- database + schema ----------------------

function databaseCheck(deps: ReadinessDeps): Promise<ReadinessCheck> {
  return (async (): Promise<ReadinessCheck> => {
    if (!deps.env.DATABASE_URL) {
      return { name: 'database', status: 'fail', reason: 'database_not_configured' };
    }
    try {
      const sql = deps.sql();
      const result = await withTimeout(sql<{ ok: number }[]>`SELECT 1 AS ok`, 'database_timeout');
      if (isTimeout(result)) {
        return { name: 'database', status: 'fail', reason: result.__timeout };
      }
      return { name: 'database', status: 'ok', detail: { query: 'select_1' } };
    } catch {
      // Deliberately no error text: driver messages can carry the DSN.
      return { name: 'database', status: 'fail', reason: 'database_unreachable' };
    }
  })();
}

function schemaCheck(deps: ReadinessDeps, databaseOk: boolean): Promise<ReadinessCheck> {
  return (async (): Promise<ReadinessCheck> => {
    if (!databaseOk) {
      // Fail closed: the schema cannot be verified without a connection, and an
      // unverifiable required check is never "ok".
      return { name: 'schema', status: 'fail', reason: 'database_unreachable' };
    }
    try {
      const sql = deps.sql();

      // (1) journal state through the narrow SECURITY DEFINER added by 0049.
      let applied: number | null = null;
      let latest: string | null = null;
      try {
        const rows = await withTimeout(
          sql<{ state: { applied: number; latest: string | null } }[]>`
            SELECT ops_migration_state() AS state`,
          'schema_check_timeout',
        );
        if (isTimeout(rows)) {
          return { name: 'schema', status: 'fail', reason: rows.__timeout };
        }
        applied = Number(rows[0]?.state?.applied ?? 0);
        latest = rows[0]?.state?.latest ?? null;
      } catch (e) {
        // 42883 = undefined_function: this build's own migration is not
        // applied, which is a definite "schema is behind".
        const code = sqlState(e);
        return {
          name: 'schema',
          status: 'fail',
          reason: code === '42883' ? 'schema_behind' : 'schema_unverifiable',
          detail: { expected: deps.expected.count, applied },
        };
      }

      if (applied < deps.expected.count) {
        return {
          name: 'schema',
          status: 'fail',
          reason: 'schema_behind',
          detail: { applied, expected: deps.expected.count, latest },
        };
      }
      if (applied > deps.expected.count) {
        return {
          name: 'schema',
          status: 'fail',
          reason: 'schema_ahead',
          detail: { applied, expected: deps.expected.count, latest },
        };
      }
      if (latest !== deps.expected.latest) {
        return {
          name: 'schema',
          status: 'fail',
          reason: 'schema_version_mismatch',
          detail: { applied, expected: deps.expected.count, latest },
        };
      }

      // (2) the objects the journal claims to have created must actually exist.
      let missing: string[] = [];
      try {
        const rows = await withTimeout(
          sql<{ missing: string | null }[]>`
            WITH required(name) AS (
              SELECT unnest(${sql.array([...REQUIRED_TABLES])}::text[])
              UNION ALL
              SELECT unnest(${sql.array([...REQUIRED_FUNCTIONS])}::text[])
            )
            SELECT string_agg(name, ',' ORDER BY name) AS missing
              FROM required
             WHERE CASE
                     WHEN name LIKE '%()' THEN to_regprocedure(name) IS NULL
                     WHEN name LIKE '%(%' THEN to_regprocedure(name) IS NULL
                     ELSE to_regclass('public.' || name) IS NULL
                   END`,
          'schema_check_timeout',
        );
        if (isTimeout(rows)) {
          return { name: 'schema', status: 'fail', reason: rows.__timeout };
        }
        missing = (rows[0]?.missing ?? '').split(',').filter(Boolean);
      } catch {
        return { name: 'schema', status: 'fail', reason: 'schema_unverifiable' };
      }
      if (missing.length > 0) {
        return {
          name: 'schema',
          status: 'fail',
          reason: 'schema_objects_missing',
          detail: { missing: missing.join(','), count: missing.length },
        };
      }

      return {
        name: 'schema',
        status: 'ok',
        detail: { applied, expected: deps.expected.count, latest },
      };
    } catch {
      return { name: 'schema', status: 'fail', reason: 'schema_unverifiable' };
    }
  })();
}

// ---------------------- report ----------------------

/** Production wiring: the app's own pool, auth crypto, env and manifest. */
export function defaultDeps(): ReadinessDeps {
  return {
    sql: () => getSql() as unknown as SqlLike,
    authCrypto: loadAuthCrypto,
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
      SCOLAIRA_SESSION_SECRET: process.env.SCOLAIRA_SESSION_SECRET,
    },
    expected: {
      count: EXPECTED_MIGRATION_COUNT,
      latest: LATEST_MIGRATION_TAG,
    },
  };
}

/**
 * Evaluate readiness. Never throws: a probe that throws is a probe that cannot
 * report, and an unreportable readiness state must still be a FAILED readiness
 * state, not an error page.
 */
export async function evaluateReadiness(
  deps: ReadinessDeps = defaultDeps(),
): Promise<ReadinessReport> {
  let checks: ReadinessCheck[];
  try {
    const database = await databaseCheck(deps);
    const [schema, auth] = await Promise.all([
      schemaCheck(deps, database.status === 'ok'),
      authCheck(deps),
    ]);
    checks = [database, schema, auth];
  } catch {
    checks = [
      { name: 'database', status: 'fail', reason: 'probe_failed' },
      { name: 'schema', status: 'fail', reason: 'probe_failed' },
      { name: 'auth', status: 'fail', reason: 'probe_failed' },
    ];
  }
  const ready = checks.every((c) => c.status === 'ok');
  return {
    status: ready ? 'ready' : 'unavailable',
    probe: 'readiness',
    build: buildInfo(),
    timestamp: new Date().toISOString(),
    checks,
  };
}

/**
 * Evaluate readiness AND emit the failure signal.
 *
 * Both the HTTP probe and any operational caller go through here so the log
 * line and the HTTP status can never disagree about the same evaluation.
 */
export async function probeReadiness(
  deps: ReadinessDeps = defaultDeps(),
): Promise<ReadinessReport> {
  const report = await evaluateReadiness(deps);
  if (report.status !== 'ready') {
    logFailure('readiness_failed', {
      commit: report.build.commit,
      version: report.build.version,
      environment: report.build.environment,
      failed: report.checks
        .filter((c) => c.status === 'fail')
        .map((c) => `${c.name}:${c.reason ?? 'unknown'}`)
        .join(','),
      expectedMigrations: EXPECTED_MIGRATION_COUNT,
    });
  }
  return report;
}
