import { expect, test } from '@playwright/test';
import { loadSeed } from './support/seed';

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

/**
 * The root route's contract (fixed in Phase 0, and stated in `app/page.tsx`):
 * an ANONYMOUS visitor sees the public landing page — schools evaluate Scolaira
 * before they have an account, so `/` must not be a login wall — while a
 * signed-in visitor is redirected to `/dashboard`. Guarded surfaces stay behind
 * the session check in `app/middleware.ts`, answering 307 with the return path.
 *
 * The assertion this replaces expected `page.goto('/')` to land on
 * `/login?next=%2Fdashboard` for an anonymous visitor. That was the behaviour
 * before the public landing page existed; it was never restored by any later
 * decision, so the test was pinning the product to a superseded contract.
 */
test('the root route answers anonymously with the public landing page, and guarded routes ask to sign in', async ({
  page,
  request,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(page.url()).not.toContain('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // A visitor who is not signed in must always be offered the way in.
  await expect(page.getByRole('link', { name: /sign in/i }).first()).toBeVisible();

  // Anonymous means anonymous. The landing page may describe the product; it may
  // not hand a real school's books to whoever asks. Asserted against the seeded
  // tenant, so the check bites if the page ever starts rendering live data.
  const seed = loadSeed();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/₦\s?[\d,]+/); // no money figures
  expect(body).not.toMatch(/INV-\d{4}-\d{6}/); // no invoice numbers
  expect(body).not.toContain(seed.organization.name); // no school identity
  expect(body).not.toContain(seed.owner.email); // no person's address

  // …and the guard is still the guard: every data-bearing route refuses an
  // anonymous read and carries the return path through sign-in.
  for (const path of [
    '/dashboard',
    '/invoices',
    '/students',
    '/finance/opening-balances',
    '/reconcile',
  ]) {
    const guarded = await request.get(path, { maxRedirects: 0 });
    expect(guarded.status(), `${path} answered without a session`).toBe(307);
    const location = new URL(guarded.headers()['location'] ?? '', 'http://127.0.0.1:3000');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe(path);
  }
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
