import { expect, test } from '@playwright/test';

/**
 * Liveness smoke test + design-system smoke tests.
 *
 * SCOPE NOTE (H-6): everything below that walks /preview/* exercises the M1
 * design system against MOCK data. It is not product evidence and no longer
 * pretends to be — the release evidence is the seeded, authenticated journeys in
 * school-journey.spec.ts / parent-journey.spec.ts plus the gate in
 * readiness.spec.ts. These tests are kept because the design system still has to
 * render, but nothing here may be cited as proof that the product works.
 */

test('/api/health is liveness only and claims nothing about dependencies', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status).toBe('ok');
  expect(body.probe).toBe('liveness');
  expect(body.version).toBeDefined();
  expect(body.readiness).toBe('/api/ready');
  // The old payload advertised `checks.database === 'not_configured'` while the
  // endpoint answered 200 with the database down — the H-6 defect. Dependency
  // claims now live in exactly one place, /api/ready, and are proven there.
  expect(body.checks).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('not_configured');
});

test('root page enforces authentication for the Command Center', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL(/\/login\?next=%2Fdashboard/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 10000 });
});

test(
  'Command Center renders KPIs + security headers',
  { tag: '@design-system' },
  async ({ page }) => {
    const response = await page.goto('/preview/command-center');
    expect(response?.status()).toBe(200);
    expect(response!.headers()['x-frame-options']).toBe('DENY');
    expect(response!.headers()['x-content-type-options']).toBe('nosniff');
    await expect(page.getByText('BILLED')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Demo data', { exact: false })).toBeVisible();
  },
);

test('Primitives showcase renders and tabs work', { tag: '@design-system' }, async ({ page }) => {
  await page.goto('/preview/primitives');
  await expect(page.getByText('Brand primitives')).toBeVisible({ timeout: 10000 });
  await page.getByRole('tab', { name: 'Buttons' }).click();
  await expect(page.getByRole('button', { name: 'Pay now' }).first()).toBeVisible();
});

test('Invoices list renders table with INV-1042', { tag: '@design-system' }, async ({ page }) => {
  await page.goto('/preview/list/invoices');
  await expect(page.getByText(/INV-1042/).first()).toBeVisible({ timeout: 10000 });
});

test('Invoice detail renders summary', { tag: '@design-system' }, async ({ page }) => {
  await page.goto('/preview/invoice/INV-1042');
  await expect(page.getByText(/Total billed/).first()).toBeVisible({ timeout: 10000 });
});

test('404 page renders for unknown routes', { tag: '@design-system' }, async ({ page }) => {
  const response = await page.goto('/preview/does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: /Page not found/ })).toBeVisible({
    timeout: 10000,
  });
});
