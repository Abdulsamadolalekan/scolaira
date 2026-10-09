/**
 * E2E / release-evidence seed (H-6).
 *
 * Produces ONE thing: a throwaway database that is *production-like* — created
 * from the real migration files by the real migration runner, then populated
 * through the real repository layer and the real tenant triggers (`seedTwoOrgs`
 * + `applyRichSeed`, the fixtures the integration suites use), with a known
 * login identity so a browser can walk the shipped journeys.
 *
 * It exists because the E2E suite used to run against mock preview pages with
 * no database at all: the screenshots and "smoke passed" claims evidenced
 * mockups, not the product (H-6/G7). The Playwright specs read the artefact
 * this script writes (`e2e/.artifacts/seed.json`) and FAIL if it is missing —
 * a missing seed is a red build, never a skipped journey.
 *
 * Fail-closed by construction: every step throws on failure, the database is
 * dropped and recreated rather than patched, and the script exits non-zero on
 * anything unexpected.
 *
 * Usage:
 *   npm run e2e:seed
 *
 * Environment (all optional; the defaults are local throwaway databases):
 *   E2E_DATABASE_URL            runtime role (scolaira_app) → default …/scolaira_e2e
 *   E2E_DATABASE_MIGRATION_URL  owner role  (scolaira_owner) → default …/scolaira_e2e
 *   E2E_SEED_FILE               artefact path → default e2e/.artifacts/seed.json
 *
 * NOTE: the script is run with `--conditions=react-server` (see package.json)
 * because it imports application modules marked `server-only`; that is the same
 * condition Node uses inside Next's server runtime, so the imports are the real
 * ones rather than a test stub.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import argon2 from 'argon2';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Load .env / .env.local like scripts/migrate.ts, without overriding real env. */
function loadEnvFile(file: string): void {
  try {
    const body = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}
loadEnvFile('.env');
loadEnvFile('.env.local');

const DEFAULT_DB = 'scolaira_e2e';
function urlWithDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}
function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '') || 'postgres';
}

const runtimeUrl =
  process.env.E2E_DATABASE_URL ??
  urlWithDatabase(
    process.env.DATABASE_URL ?? 'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira',
    DEFAULT_DB,
  );
const ownerUrl =
  process.env.E2E_DATABASE_MIGRATION_URL ??
  urlWithDatabase(
    process.env.DATABASE_MIGRATION_URL ??
      'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira',
    DEFAULT_DB,
  );
const seedFile = resolve(process.cwd(), process.env.E2E_SEED_FILE ?? 'e2e/.artifacts/seed.json');

const dbName = databaseNameOf(runtimeUrl);
if (databaseNameOf(ownerUrl) !== dbName) {
  throw new Error(
    'E2E_DATABASE_URL and E2E_DATABASE_MIGRATION_URL must point at the same database',
  );
}
if (dbName === 'scolaira' || dbName === 'scolaira_test') {
  throw new Error(
    `refusing to seed ${dbName}: the E2E seed drops and recreates its database and must never target a development or test database`,
  );
}

/** Journey identities. Throwaway credentials for a throwaway database. */
const OWNER = { email: 'owner@e2e.demo.school', password: 'E2E-Owner-Passw0rd!' };
const PLATFORM = { email: 'platform@e2e.demo.school', password: 'E2E-Platform-Passw0rd!' };

const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. A fresh database, created by the owner role (never patched in place).
  // -------------------------------------------------------------------------
  const maintenanceUrl = urlWithDatabase(ownerUrl, 'postgres');
  const admin = postgres(maintenanceUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${dbName} OWNER scolaira_owner`);
    console.log(`[seed-e2e] created database ${dbName}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  // ONE connection on purpose: the fixtures set tenant context with
  // `set_tenant_context()`, which is connection-scoped. Spreading the fixture
  // work over a pool would run some inserts with no context (and the RLS
  // default-deny would refuse them) — the integration harness pins a single
  // connection for exactly this reason.
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {}, idle_timeout: 5 });
  let ids: { orgId: string; orgBId: string } | null = null;
  try {
    await owner.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await owner.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION scolaira_owner`);
    await owner.unsafe(`GRANT USAGE ON SCHEMA public TO scolaira_app`);
    await owner.unsafe(`GRANT USAGE ON SCHEMA drizzle TO scolaira_app`);

    // -----------------------------------------------------------------------
    // 2. The real migrations, through the real runner.
    //    Imported lazily so the env above is in place before the app modules
    //    (and their connection defaults) load.
    // -----------------------------------------------------------------------
    process.env.DATABASE_URL = runtimeUrl;
    process.env.DATABASE_MIGRATION_URL = ownerUrl;

    const { applyAllMigrations } = await import('./apply-migrations');
    const result = await applyAllMigrations(owner, resolve(process.cwd(), 'lib/db/migrations'));
    console.log(`[seed-e2e] migrations applied. new=${result.applied} total=${result.total}`);
    if (result.total === 0)
      throw new Error('migration runner applied nothing — refusing to seed an empty schema');

    // Grant the runtime role what the hardened migrations expect (the same
    // post-migration grants tests/global-setup-db.ts and scripts/migrate.ts make).
    await owner.unsafe(`GRANT USAGE ON SCHEMA public, drizzle TO scolaira_app`);
    await owner.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scolaira_app`,
    );
    await owner.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scolaira_app`);
    await owner.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO scolaira_app`);
    await owner.unsafe(
      `REVOKE DELETE ON reminders, audit_events, webhook_events FROM scolaira_app`,
    );

    // -----------------------------------------------------------------------
    // 3. The real fixtures: repositories + triggers, not raw row stuffing.
    // -----------------------------------------------------------------------
    const { seedTwoOrgs } = await import('../tests/support/seed');
    const { applyRichSeed } = await import('../tests/support/rich-seed');

    const base = await seedTwoOrgs(owner);
    ids = base as unknown as { orgId: string; orgBId: string };
    const rich = await applyRichSeed(owner, base);
    console.log(
      `[seed-e2e] fixtures: org ${ids.orgId}, ${rich.studentAId ? 'students' : ''} invoices=${[rich.invPaidId, rich.invPartialId].filter(Boolean).length} link=${rich.linkToken}`,
    );

    // -----------------------------------------------------------------------
    // 4. Journey identities (bootstrap context: identity rows only).
    //    `users`/`password_credentials`/`organization_members` are identity
    //    tables; the tenant trigger accepts an explicit organization_id while
    //    the platform-admin marker is set with an empty platform_admin_id
    //    (exactly the pattern seedTwoOrgs uses).
    // -----------------------------------------------------------------------
    const ownerId = randomUUID();
    const platformId = randomUUID();
    await owner`SELECT auth_enter_system_context()`;
    await owner`SELECT set_config('app.is_platform_admin','1',false), set_config('app.platform_admin_id','',false)`;
    await owner`
      INSERT INTO users (id, email, first_name, last_name, is_platform_admin)
      VALUES (${ownerId}::uuid, ${OWNER.email}, 'E2E', 'Owner', false),
             (${platformId}::uuid, ${PLATFORM.email}, 'E2E', 'Platform', true)`;
    await owner`
      INSERT INTO organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at)
      VALUES (${ids.orgId}::uuid, ${ownerId}::uuid, 'OWNER', 'ACTIVE', now(), now(), now()),
             (${ids.orgId}::uuid, ${platformId}::uuid, 'STAFF', 'ACTIVE', now(), now(), now())`;
    const paramsJson = JSON.stringify(ARGON2_OPTIONS);
    for (const who of [OWNER, PLATFORM]) {
      const hash = await argon2.hash(who.password, ARGON2_OPTIONS);
      await owner`
        INSERT INTO password_credentials (user_id, algorithm, params, password_hash, created_at, updated_at)
        VALUES (${who === OWNER ? ownerId : platformId}::uuid, 'argon2id',
                ${paramsJson}::jsonb, ${hash}, now(), now())`;
    }
    await owner`SELECT clear_app_context()`;

    // -----------------------------------------------------------------------
    // 5. The artefact the specs read. Contains throwaway credentials for a
    //    throwaway database only — never a production secret, and the file is
    //    git-ignored.
    // -----------------------------------------------------------------------
    // The suite runs over HTTPS (a production build marks its cookies Secure, and
    // that is how the product is served). Prepare the throwaway certificate here,
    // so that "prepare the run" is one command with one failure mode.
    const { TLS_DIR: tlsDir, ensureTlsCertificate } = await import('./e2e-tls-cert');
    ensureTlsCertificate();
    console.log(`[seed-e2e] TLS material ready in ${tlsDir}`);

    const artifact = {
      seededAt: new Date().toISOString(),
      database: dbName,
      migrations: { applied: result.total },
      organization: { id: ids.orgId, name: 'Demo School' },
      owner: { email: OWNER.email, password: OWNER.password, userId: ownerId },
      platformAdmin: { email: PLATFORM.email, password: PLATFORM.password, userId: platformId },
      student: { id: rich.studentAId, studentId: 'STU-A01', name: 'Adeyemi Bolarinwa' },
      invoices: {
        paid: rich.invPaidId,
        partial: rich.invPartialId,
        draft: rich.invDraftId,
        overpaid: rich.invOverpaidId,
      },
      payments: { cash: rich.payCashId, bank: rich.payBankId, reversed: rich.payReversedId },
      paymentLink: { token: rich.linkToken },
    };
    mkdirSync(dirname(seedFile), { recursive: true });
    writeFileSync(seedFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`[seed-e2e] artefact written: ${seedFile}`);
    console.log('[seed-e2e] READY');
  } finally {
    await owner.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[seed-e2e] FAILED:', error instanceof Error ? error.message : error);
  if (process.env.E2E_SEED_DEBUG === '1' && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});
