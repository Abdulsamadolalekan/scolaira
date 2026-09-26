import { expect, test } from '@playwright/test';

/**
 * H-6 — the release gate.
 *
 * Before H-6 the gate was `npx wait-on /api/health`: an endpoint that returned
 * `{"status":"ok"}` with the database unreachable, the schema half-applied and
 * the auth secret unusable (measured — docs/readiness/H6_SCOPE_MAP.md). The
 * suite passed on a deployment that could not serve a single request.
 *
 * These tests are the honest gate: readiness must PROVE database connectivity,
 * migrated-schema state and a working auth configuration, and liveness must not
 * claim anything about dependencies.
 */
test.describe('H-6 release gate', () => {
  test('readiness proves the database, the migrated schema and auth configuration', async ({
    request,
  }) => {
    const res = await request.get('/api/ready', { failOnStatusCode: false });
    const body = await res.json();

    // A failing gate must be loud: report the payload when this is red.
    expect(body, `readiness payload: ${JSON.stringify(body)}`).toMatchObject({
      status: 'ready',
      probe: 'readiness',
    });
    expect(res.status()).toBe(200);

    const names = body.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(['database', 'schema', 'auth']);
    for (const check of body.checks) {
      expect(check, `${check.name} must be ok: ${JSON.stringify(check)}`).toMatchObject({
        status: 'ok',
      });
    }

    // The schema check must compare the database against THIS build.
    const schema = body.checks.find((c: { name: string }) => c.name === 'schema');
    expect(schema.detail.applied).toBe(schema.detail.expected);
    expect(schema.detail.latest).toBeTruthy();

    // A gate may be cached by a CDN or a proxy and then it is not a gate.
    expect(res.headers()['cache-control']).toContain('no-store');
  });

  test('liveness does not claim dependency health any more', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', probe: 'liveness', readiness: '/api/ready' });
    // The removed fields were the defect.
    expect(body.checks).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('not_configured');
  });

  test('the readiness payload discloses no configuration', async ({ request }) => {
    const res = await request.get('/api/ready');
    const text = await res.text();
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/scolaira_(app|owner)_pw/);
    expect(text).not.toMatch(/sc_session|password_hash|SCOLAIRA_SESSION_SECRET/);
  });

  test('readiness is reachable without a session (a gate must be probeable)', async ({
    request,
  }) => {
    const res = await request.get('/api/ready', { headers: { accept: 'application/json' } });
    expect(res.status()).toBe(200);
  });
});
