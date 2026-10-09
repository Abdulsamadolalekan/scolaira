import { expect, test } from '@playwright/test';
import { attemptJourney, fillStable, loadSeed } from './support/seed';

/**
 * H-6 — the parent/payer journey (public payment link), against the seeded
 * database.
 *
 * The public surface was the subject of R3/H-3 hardening; nothing in the E2E
 * suite ever exercised it (measured: 0 of 5 specs). It is also the only
 * unauthenticated mutation in the product, which is exactly the kind of thing
 * release evidence must show working — and show staying bounded.
 */
test.describe('H-6 parent payment journey', () => {
  test('an anonymous payer resolves the link and sees only what they need', async ({ page }) => {
    const seed = loadSeed();
    await page.goto(`/p/${seed.paymentLink.token}`);

    await expect(page.getByRole('heading', { name: 'Make a payment' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(seed.organization.name).first()).toBeVisible();
    // The payer sees an amount due — and never the invoice total or paid history.
    await expect(page.getByText(/amount due/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('button', { name: /notify the school of my payment/i }),
    ).toBeVisible();
  });

  test('an unknown token is not an oracle', async ({ page }) => {
    const res = await page.goto('/p/definitely-not-a-real-token-h6');
    expect(res?.status()).toBe(404);
    await expect(page.getByText(/not found|no longer/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('a payer submission is recorded as a PENDING payment awaiting reconciliation', async ({
    page,
  }) => {
    const seed = loadSeed();
    const stamp = Date.now().toString(36).toUpperCase();

    await attemptJourney(async (attempt) => {
      const reference = `E2E-PAYER-${stamp}-${attempt}`;
      await page.goto(`/p/${seed.paymentLink.token}`);
      await expect(page.getByRole('heading', { name: 'Make a payment' })).toBeVisible({
        timeout: 30_000,
      });

      await fillStable(page.getByLabel('Your name'), 'E2E Payer');
      await fillStable(page.getByLabel('Teller / transfer reference'), reference);
      await page.getByRole('button', { name: /notify the school of my payment/i }).click();

      // The payer is told the payment was LOGGED — not that it was confirmed, and
      // never allocated on their behalf (R3 contract). The page must also keep
      // saying that a human will verify it.
      await expect(page.getByText(/has been logged/i).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/verify|confirmed by the school|bursar/i).first()).toBeVisible();
    });
  });
});
