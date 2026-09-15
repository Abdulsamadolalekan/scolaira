import { expect, test } from '@playwright/test';

/**
 * Smoke tests for SCOLAIRA M1 (Design System Foundation).
 * Uses element waits rather than networkidle because Radix tooltips hold open
 * connections harmlessly.
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
  expect(body.checks.database).toBe('not_configured');
});

test('root page redirects to Command Center', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL(/\/preview\/command-center/);
  await expect(page.getByText('Good morning, Bursar')).toBeVisible({ timeout: 10000 });
});

test('Command Center renders KPIs + security headers', async ({ page }) => {
  const response = await page.goto('/preview/command-center');
  expect(response?.status()).toBe(200);
  expect(response!.headers()['x-frame-options']).toBe('DENY');
  expect(response!.headers()['x-content-type-options']).toBe('nosniff');
  await expect(page.getByText('BILLED')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Demo data', { exact: false })).toBeVisible();
});

test('Primitives showcase renders and tabs work', async ({ page }) => {
  await page.goto('/preview/primitives');
  await expect(page.getByText('Brand primitives')).toBeVisible({ timeout: 10000 });
  await page.getByRole('tab', { name: 'Buttons' }).click();
  await expect(page.getByRole('button', { name: 'Pay now' }).first()).toBeVisible();
});

test('Invoices list renders table with INV-1042', async ({ page }) => {
  await page.goto('/preview/list/invoices');
  await expect(page.getByText(/INV-1042/).first()).toBeVisible({ timeout: 10000 });
});

test('Invoice detail renders summary', async ({ page }) => {
  await page.goto('/preview/invoice/INV-1042');
  await expect(page.getByText(/Total billed/).first()).toBeVisible({ timeout: 10000 });
});

test('404 page renders for unknown routes', async ({ page }) => {
  const response = await page.goto('/does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: /Page not found/ })).toBeVisible({
    timeout: 10000,
  });
});
