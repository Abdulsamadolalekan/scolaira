import { expect, test } from '@playwright/test';

/**
 * Smoke tests for SCOLAIRA M0 (Project Skeleton).
 *
 * These tests verify that the Next.js application boots, serves valid HTTP
 * responses, and contains expected content. Deeper React component / client
 * interaction tests will be added in M1+ when real UI exists.
 */
test('/api/health returns ok payload', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  const body = (await res.json()) as {
    status: string;
    version: string;
    commit: string;
    timestamp: string;
    checks: Record<string, unknown>;
  };
  expect(body.status).toBe('ok');
  expect(body.version).toBeDefined();
  expect(body.commit).toBeDefined();
  expect(body.timestamp).toBeDefined();
  expect(body.checks.database).toBe('not_configured');
});

test('root page returns 200 and contains SCOLAIRA copy (SSR)', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  const html = await response!.text();
  expect(html).toContain('SCOLAIRA');
  expect(html).toContain('Financial Operating System');
  expect(html).toContain('Every term, fully funded');
  await page.waitForLoadState('load');
});

test('root page responds with security headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(res.headers()['strict-transport-security']).toContain('max-age=');
});

test('unknown routes return 404 page', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-real-path');
  expect(response?.status()).toBe(404);
  const html = await response!.text();
  expect(html).toContain('Page not found');
});
