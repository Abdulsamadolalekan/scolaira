import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillStable, loadSeed } from './support/seed';

/**
 * H-6 — authenticated evidence needs a REAL session, obtained the way a user
 * obtains one: through the login surface.
 *
 * The session is established ONCE per role here and stored as Playwright state,
 * which the journey projects reuse. That keeps the run honest (a real
 * `/api/auth/login` against the real database, real signed cookies) without
 * hammering the login rate limit the way per-test logins would — the limit is a
 * security control and must not be weakened to make tests convenient.
 *
 * `e2e/school-journey.spec.ts` still performs an explicit, visible login, so the
 * login page itself is covered as a journey rather than only as setup.
 */
const ARTIFACTS = resolve(process.cwd(), 'e2e/.artifacts');

setup('authenticate: school owner', async ({ page }) => {
  const seed = loadSeed();
  mkdirSync(ARTIFACTS, { recursive: true });

  await page.goto('/login');
  await fillStable(page.getByLabel('Email address'), seed.owner.email);
  await fillStable(page.getByLabel('Password', { exact: true }), seed.owner.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });

  // The session must be a real one: the shell renders the signed-in identity.
  await expect(page.getByText(seed.owner.email)).toBeVisible({ timeout: 30_000 });
  await page.context().storageState({ path: resolve(ARTIFACTS, 'state-owner.json') });
});

setup('authenticate: platform administrator', async ({ page }) => {
  const seed = loadSeed();
  mkdirSync(ARTIFACTS, { recursive: true });

  await page.goto('/login');
  await fillStable(page.getByLabel('Email address'), seed.platformAdmin.email);
  await fillStable(page.getByLabel('Password', { exact: true }), seed.platformAdmin.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });

  await expect(page.getByText(seed.platformAdmin.email)).toBeVisible({ timeout: 30_000 });
  await page.context().storageState({ path: resolve(ARTIFACTS, 'state-platform.json') });
});
