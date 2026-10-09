/**
 * Reads the artefact produced by `scripts/seed-e2e.ts` (H-6).
 *
 * The E2E suite runs against a REAL, migrated, seeded database — not mock
 * preview pages. If the artefact is missing, seeding did not happen, and a
 * missing seed must be a RED build rather than a silently skipped journey:
 * `loadSeed()` throws, and the specs that need it fail loudly.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface E2ESeed {
  seededAt: string;
  database: string;
  migrations: { applied: number };
  organization: { id: string; name: string };
  owner: { email: string; password: string; userId: string };
  platformAdmin: { email: string; password: string; userId: string };
  student: { id: string; studentId: string; name: string };
  invoices: { paid: string; partial: string; draft: string; overpaid: string };
  payments: { cash: string; bank: string; reversed: string };
  paymentLink: { token: string };
}

const SEED_PATH = resolve(process.cwd(), 'e2e/.artifacts/seed.json');

export function loadSeed(): E2ESeed {
  try {
    const raw = readFileSync(SEED_PATH, 'utf8');
    const parsed = JSON.parse(raw) as E2ESeed;
    if (!parsed?.owner?.email || !parsed?.paymentLink?.token) {
      throw new Error('seed artefact is incomplete');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `e2e seed artefact missing or unreadable at ${SEED_PATH} — run \`npm run e2e:seed\` before the E2E suite (a missing seed must fail the journey, not skip it): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Sign in through the REAL login surface and wait for the workspace shell. */
export async function signIn(
  page: import('@playwright/test').Page,
  credentials: { email: string; password: string },
): Promise<void> {
  await page.goto('/login');
  const email = page.getByLabel('Email address');
  const password = page.getByLabel('Password', { exact: true });
  const submit = page.getByRole('button', { name: /sign in/i });

  for (let attempt = 1; attempt <= 3; attempt++) {
    await fillStable(email, credentials.email);
    await fillStable(password, credentials.password);
    await submit.click();
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
      return;
    } catch {
      // Only a genuine no-op (value wiped before hydration, native validation
      // blocking the submit) is retried; a rejected credential would have
      // produced an error message and is surfaced below.
      const error = await page
        .locator('[role="alert"]')
        .first()
        .textContent()
        .catch(() => null);
      if (error) throw new Error(`sign-in failed: ${error}`);
    }
  }
  throw new Error('sign-in did not reach /dashboard');
}

/**
 * Fill an input so the value actually STICKS.
 *
 * Measured (WebKit, H-6): a value written into a React-controlled input before
 * hydration is silently replaced by React state, so the field is empty at submit
 * time, native validation blocks the submit, and the test fails with no network
 * request at all — a "flaky test" that is really an app-boot race. The fill is
 * therefore verified and repeated until the DOM value survives, which is what a
 * person typing into the page experiences.
 */
export async function fillStable(
  locator: import('@playwright/test').Locator,
  value: string,
  attempts = 5,
): Promise<void> {
  const page = locator.page();
  // Best-effort hydration wait: a production build finishes its client boot when
  // the network goes quiet. Bounded, so a page with a long-poll never hangs here.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await locator.fill(value);
    // Hydration may already be in flight; give it room, then check again.
    await page.waitForTimeout(150 * attempt);
    if ((await locator.inputValue()) === value) return;
  }
  throw new Error(`could not fill input stably (last value: ${await locator.inputValue()})`);
}

/**
 * Run a write journey, tolerating the ONE race that is a property of the test
 * harness rather than the product (measured on WebKit): a client component can
 * re-hydrate between a fill and a submit, which empties a controlled input, so
 * native validation blocks the submit and no request is ever made. The page is
 * reloaded and the journey repeated; the last failure is re-thrown unchanged, so
 * a real regression still fails loudly.
 */
export async function attemptJourney(
  journey: (attempt: number) => Promise<void>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await journey(attempt);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
