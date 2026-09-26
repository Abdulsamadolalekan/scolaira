/**
 * H-6 independent re-audit — the release gate's contract, checked from outside.
 *
 * The H-6 fixes are infrastructure: a readiness endpoint, a pipeline that can
 * actually fail, a runbook that matches reality, a suite that runs the product
 * instead of mock pages. Infrastructure like this regresses silently — nobody
 * notices when a CI step goes back to gating on liveness, when a doc starts
 * promising an endpoint that does not exist, or when the seeded journeys are
 * quietly deleted from the E2E suite. Every assertion here reads the artefact
 * that carries the guarantee (source, workflow, script, docs, specs) and fails
 * if the guarantee is removed. Nothing here re-tests the readiness logic itself:
 * that is `tests/auth/h6-readiness*.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GET as healthGet } from '@/app/api/health/route';
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from '@/lib/ops/migration-manifest';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('H-6 gate: liveness makes no dependency claim', () => {
  it('the liveness payload cannot be mistaken for a health check', async () => {
    const response = await healthGet();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.probe).toBe('liveness');
    expect(body.readiness).toBe('/api/ready');
    // The removed fields were the defect: a payload that said "ok" while
    // reporting the database as not configured.
    expect(body).not.toHaveProperty('checks');
    expect(JSON.stringify(body)).not.toContain('not_configured');
    expect(JSON.stringify(body)).not.toContain('degraded');
  });

  it('the liveness route source does not reach for a dependency', () => {
    const source = read('app/api/health/route.ts');
    // It may POINT at readiness; it may not *use* a dependency. Check imports and
    // environment reads rather than words: the route names `/api/ready` and its
    // comments explain the removal of the old checks block.
    expect(source).not.toMatch(/from '@\/lib\/ops\/readiness'/);
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/process\.env\.DATABASE_URL/);
    expect(source).not.toContain('evaluateReadiness');
    expect(source).toContain("'liveness'");
  });
});

describe('H-6 gate: readiness is the only dependency gate, and it is public', () => {
  it('readiness exists, is dynamic, and forbids caching', () => {
    const source = read('app/api/ready/route.ts');
    expect(source).toContain("runtime = 'nodejs'");
    expect(source).toContain("dynamic = 'force-dynamic'");
    expect(source).toContain('no-store');
    expect(source).toContain('503');
  });

  it('the middleware lets the gate be probed without a session', () => {
    const source = read('middleware.ts');
    const publicApi = /PUBLIC_API_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(publicApi).toContain('/api/health');
    expect(publicApi).toContain('/api/ready');
  });

  it('the expectation travels with the build and matches the shipped migrations', () => {
    const shipped = readdirSync(resolve(root, 'lib/db/migrations')).filter((f) =>
      f.endsWith('.sql'),
    );
    expect(EXPECTED_MIGRATION_COUNT).toBe(shipped.length);
    expect(LATEST_MIGRATION_TAG).toBe(
      shipped
        .sort()
        .at(-1)
        ?.replace(/\.sql$/, ''),
    );
  });
});

describe('H-6 gate: CI can fail on an unready deployment', () => {
  const workflow = read('.github/workflows/ci.yml');

  it('runs a real database and migrates it', () => {
    expect(workflow).toContain('services:');
    expect(workflow).toContain('image: postgres:17');
    expect(workflow).toContain('npm run db:migrate');
    expect(workflow).toContain('scripts/bootstrap-roles.sql');
  });

  it('gates on readiness, never on liveness alone', () => {
    expect(workflow).toContain('wait-on http://127.0.0.1:3000/api/ready');

    // Liveness may be waited on to learn that the process is up — but never as the
    // deploy condition. Every step that waits on /api/health must also wait on
    // /api/ready, i.e. it must be gated on readiness (the old workflow waited on
    // /api/health and nothing else).
    const steps = workflow.split(/\n\s{6}- name: /).slice(1);
    expect(steps.length).toBeGreaterThan(3);
    for (const step of steps) {
      const name = step.split('\n')[0]?.trim();
      if (!/wait-on[^\n]*\/api\/health/.test(step)) continue;
      const gatesOnReadiness = /wait-on[^\n]*\/api\/ready/.test(step);
      // …or it is the deliberate negative proof, which asserts 503 on /api/ready.
      const provesFailClosed =
        step.includes('/api/ready') && /!=\s*"503"/.test(step) && step.includes('%{http_code}');
      expect(
        gatesOnReadiness || provesFailClosed,
        `step "${name}" waits on liveness and must also gate on /api/ready (or prove it fails closed)`,
      ).toBe(true);
    }
  });

  it('proves the gate can fail before trusting it', () => {
    // A gate that has never been observed failing is not evidence.
    expect(workflow).toMatch(/Readiness must fail closed/);
    expect(workflow).toContain('"$code" != "503"');
  });

  it('seeds a production-like database and runs both engines', () => {
    expect(workflow).toContain('npm run e2e:seed');
    expect(workflow).toContain('install --with-deps chromium webkit');
    expect(workflow).toContain('--grep-invert @design-system');
    expect(workflow).toContain('E2E_SERVER_COMMAND: npm start');
  });

  it('keeps the design-system previews off the release gate', () => {
    // /preview/* is a dev-only surface: it 404s in a production build.
    expect(workflow).toContain('--grep @design-system');
  });
});

describe('H-6 gate: the evidence suite cannot be deleted quietly', () => {
  const specs = [
    'e2e/readiness.spec.ts',
    'e2e/school-journey.spec.ts',
    'e2e/parent-journey.spec.ts',
  ];

  it('keeps the four evidence specs, and they require a seed', () => {
    for (const spec of specs) {
      expect(existsSync(resolve(root, spec)), `${spec} is part of the H-6 evidence`).toBe(true);
    }
    const support = read('e2e/support/seed.ts');
    // A missing seed must fail the journey, never skip it.
    expect(support).toContain('npm run e2e:seed');
    expect(support).toMatch(/throw new Error/);
  });

  it('the seed builds a real database: real migrations, real fixtures, real identity', () => {
    const seed = read('scripts/seed-e2e.ts');
    expect(seed).toContain('applyAllMigrations');
    expect(seed).toContain('seedTwoOrgs');
    expect(seed).toContain('applyRichSeed');
    expect(seed).toContain('DROP DATABASE IF EXISTS');
    // Refuses to touch a development or test database.
    expect(seed).toContain('refusing to seed');
  });

  it('runs the built artefact, over TLS, in a non-Chromium engine too', () => {
    const config = read('playwright.config.ts');
    expect(config).toContain('E2E_SERVER_COMMAND');
    expect(config).toContain('webkit');
    expect(config).toContain('https://localhost:3443');
    expect(config).toContain('NODE_EXTRA_CA_CERTS');
    expect(existsSync(resolve(root, 'scripts/e2e-https-proxy.mjs'))).toBe(true);
  });
});

describe('H-6 gate: the runbook matches the system', () => {
  it('the documented provisioning script actually runs', () => {
    const script = read('scripts/bootstrap-roles.sql');
    // CREATE DATABASE cannot run inside a DO block; the old file did exactly
    // that and the documented command exited 2.
    const doBlocks = script.split(/DO \$\$/).slice(1);
    for (const block of doBlocks) {
      const body = block.split('$$;')[0] ?? '';
      expect(body.toUpperCase()).not.toContain('CREATE DATABASE');
    }
    // `\warning` is not a psql command. (It may be mentioned in a comment
    // explaining the defect; it must never be an executable line.)
    const executableWarning = script.split('\n').some((line) => /^\s*\\warning\b/.test(line));
    expect(executableWarning).toBe(false);
    expect(script).toContain('\\gexec');
    expect(script).toContain('\\if :{?boot_db}');
  });

  it('the docs describe the endpoints that exist', () => {
    const ops = read('docs/OPERATIONS.md');
    const deployment = read('docs/DEPLOYMENT.md');

    for (const doc of [ops, deployment]) {
      expect(doc).toContain('/api/ready');
      // No promises of surfaces that were never built.
      expect(doc).not.toContain('/api/health/ready');
      expect(doc).not.toMatch(/"status":\s*"ok"\s*\|\s*"degraded"/);
    }
    // Liveness is explicitly described as making no dependency claim.
    expect(ops).toMatch(/liveness only|no claim about/i);
    // The unimplemented vendor integration is stated as such, not implied.
    expect(deployment).toMatch(/parsed but not used/i);

    const contracts = read('docs/API_CONTRACTS.md');
    expect(contracts).toContain('/api/ready');
    expect(contracts).toContain('schema_behind');
    expect(contracts).toContain('auth_crypto_broken');
  });

  it('the operational signal is emitted, not just promised', () => {
    const readiness = read('lib/ops/readiness.ts');
    expect(readiness).toContain("logFailure('readiness_failed'");
    const instrumentation = read('instrumentation.ts');
    expect(instrumentation).toContain("logEvent('startup_configuration'");
  });

  it('the startup line cannot contradict the readiness probe about auth', () => {
    const instrumentation = read('instrumentation.ts');
    // Presence is not usability: a 9-character secret must not be reported as
    // "configured" while /api/ready refuses it (this was measured, then fixed).
    expect(instrumentation).not.toMatch(
      /authSecretConfigured:\s*Boolean\(process\.env\.SCOLAIRA_SESSION_SECRET\)/,
    );
    expect(instrumentation).toContain('authSecretUsable(');
    expect(instrumentation).toContain('./lib/ops/auth-config-state');
    // …and the boot hook must not drag the database layer into the boot bundle
    // (that failed the production build when it did).
    expect(instrumentation).not.toContain("from './lib/ops/readiness'");
    const state = read('lib/ops/auth-config-state.ts');
    expect(state).toContain('export function authSecretUsable');
    expect(state).toContain('MIN_SESSION_SECRET_BYTES');
    // One definition: the probe imports it rather than redefining it.
    const readiness = read('lib/ops/readiness.ts');
    expect(readiness).toContain("from './auth-config-state'");
    expect(readiness).not.toMatch(/export function authSecretUsable/);
  });
});
