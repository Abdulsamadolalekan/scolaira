import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for SCOLAIRA E2E tests.
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Mobile Safari/Chrome added once we have screens to test on mobile (M1+).
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // The register endpoint keys its rate limit on the client address, and it
    // ignores x-forwarded-for unless the deployment declares how many proxies
    // it runs behind (H-4/F9). The e2e server is started directly, so we declare
    // one hop and let a spec drive its own bucket with a forwarded address.
    env: { TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS ?? '1' },
  },
});
