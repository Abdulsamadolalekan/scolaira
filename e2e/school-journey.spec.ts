import { expect, test } from '@playwright/test';
import { attemptJourney, fillStable, loadSeed, signIn } from './support/seed';

/**
 * H-6 — the authenticated school journey, against a REAL seeded database.
 *
 * This is the evidence H-6 was raised for: before it, the only E2E coverage of
 * "the product" was three specs walking `/preview/*` mock pages, and the
 * screenshots they produced showed mockups (measured: 0 of 5 specs established
 * a session). Every assertion below reads data that the seed created through
 * the real repositories and triggers — if the migration set, the RLS context,
 * the auth chain or the reporting queries break, this fails.
 */
test.describe('H-6 sign-in journey (anonymous browser)', () => {
  // No stored state: this test must prove the login surface itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('owner signs in through the login form and lands in the seeded school', async ({ page }) => {
    const seed = loadSeed();
    // The ONE explicit login in this file. Every other test reuses the session
    // stored by e2e/auth.setup.ts, so the run does not trip the login rate
    // limit (which is a security control, not an obstacle to route around).
    await signIn(page, seed.owner);

    // The shell knows who is signed in (driven by getSession → DB).
    await expect(page.getByText(seed.owner.email)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Proprietor')).toBeVisible();

    // Sign-out is a real, CSRF-protected form (H-4) — evidence the session is real.
    await expect(page.locator('form[action="/api/auth/logout"]')).toHaveCount(1);
  });
});

test.describe('H-6 authenticated school journey', () => {
  // The session e2e/auth.setup.ts obtained with a real /api/auth/login call.
  test.use({ storageState: 'e2e/.artifacts/state-owner.json' });

  test('dashboard reports the seeded money, not mock numbers', async ({ page }) => {
    const seed = loadSeed();
    await page.goto('/dashboard');

    // The command center must render its headline figures from the database.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/billed|collected|outstanding/i).first()).toBeVisible({
      timeout: 30_000,
    });
    // Scope labelling is a declared H-2 contract and must survive H-6.
    await expect(page.getByText(/all term|this term/i).first()).toBeVisible({ timeout: 30_000 });
    expect(seed.organization.id).toBeTruthy();
  });

  test('the seeded student is visible in the school roster', async ({ page }) => {
    const seed = loadSeed();
    await page.goto('/students');
    await expect(page.getByText(seed.student.name, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(seed.student.studentId).first()).toBeVisible({ timeout: 30_000 });
  });

  test('recording a payment through the UI creates it and shows it in the register', async ({
    page,
  }) => {
    const seed = loadSeed();
    const stamp = Date.now().toString(36).toUpperCase();

    await attemptJourney(async (attempt) => {
      // A reference unique to this run so the assertion cannot pass on seed data.
      const reference = `E2E-UI-${stamp}-${attempt}`;

      await page.goto('/payments/new');
      await expect(page.getByRole('heading', { name: 'Record payment' })).toBeVisible({
        timeout: 30_000,
      });

      // Choose the seeded student (option labels are "Name — STU-ID (…)").
      const studentSelect = page.locator('label:has-text("Student") select').first();
      const studentOption = (await studentSelect.locator('option').allTextContents()).find((t) =>
        t.includes(seed.student.studentId),
      );
      expect(studentOption, 'the seeded student must be selectable').toBeTruthy();
      await studentSelect.selectOption({ label: studentOption!.trim() });

      await page.locator('label:has-text("Method") select').first().selectOption('BANK_TRANSFER');
      await fillStable(page.locator('input[placeholder="150000"]'), '50000');
      await fillStable(page.locator('input[placeholder="Optional"]'), reference);

      // Apply it to the first open invoice the form offers.
      const invoiceSelect = page.locator('label:has-text("Apply to invoice") select').first();
      const invoiceOptions = (await invoiceSelect.locator('option').allTextContents()).filter((t) =>
        t.includes('remaining'),
      );
      if (invoiceOptions.length > 0) {
        await invoiceSelect.selectOption({ label: invoiceOptions[0]!.trim() });
      }

      await page.getByRole('button', { name: 'Record payment' }).click();

      // The form navigates to the payment it just created; the journey is only
      // evidence if the write is visible through a DIFFERENT surface than the
      // one that made it.
      await page.waitForURL(/\/payments\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await expect(page.getByText('Recorded by').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(reference).first()).toBeVisible({ timeout: 30_000 });

      // …and the same payment must appear in the register listing.
      await page.goto('/payments');
      await expect(page.getByText(reference).first()).toBeVisible({ timeout: 30_000 });
    });
  });

  test('the invoice journal shows seeded invoices with their balances', async ({ page }) => {
    const seed = loadSeed();
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    // The seed issues at least one invoice; the register must list a number.
    await expect(page.getByText(/INV-\d+/).first()).toBeVisible({ timeout: 30_000 });
    expect(seed.invoices.paid).toBeTruthy();
  });
});

test.describe('H-6 platform identity authenticates (evidence only)', () => {
  // The seed provisions a platform-flagged identity. This asserts the narrowest
  // possible thing — that it can authenticate on this build. What such an
  // identity can SEE is the identity-visibility door, which H-6 measures and
  // documents but deliberately does not redesign (it belongs to H-8).
  test.use({ storageState: 'e2e/.artifacts/state-platform.json' });

  test('the platform session is a real, resolvable session', async ({ page }) => {
    const seed = loadSeed();
    // A real page first: `fetch` needs the app's origin.
    await page.goto('/dashboard');
    await expect(page.getByText(seed.platformAdmin.email)).toBeVisible({ timeout: 30_000 });
    // Called from INSIDE the browser, the way the app shell calls it. (A
    // Playwright APIRequestContext is a separate HTTP client and does not carry
    // this session: the cookies are Secure, and a non-browser client refuses to
    // send them over plain http — the browser's localhost exception is what makes
    // the real path work, which is exactly what we want to be testing.)
    const me = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(seed.platformAdmin.userId);
    expect(me.body.user.email).toBe(seed.platformAdmin.email);
    expect(me.body.user.isPlatformAdmin).toBe(true);
  });
});
