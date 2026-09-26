import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * H-6 changed what this file means. Before it, the suite started a dev server
 * against whatever database happened to exist, walked `/preview/*` mock pages
 * and reported a green "release". Now:
 *
 *   * the server runs against a REAL, migrated, seeded database
 *     (`npm run e2e:seed` → e2e/.artifacts/seed.json, which the specs require);
 *   * two browsers run: chromium AND webkit (the audit's "at least one
 *     non-Chromium pass" — mobile-browser behaviour is where Nigerian school
 *     buyers actually live);
 *   * `/api/ready` is the deploy gate, and `e2e/readiness.spec.ts` asserts it.
 *
 * The seed database is dropped and recreated per run, so a missing seed is a
 * red build rather than a skipped journey (see e2e/support/seed.ts).
 */
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_e2e';

/**
 * The suite talks to the app over TLS by default (`scripts/e2e-https-proxy.mjs`
 * fronts the app server), because a production build marks its session and CSRF
 * cookies `Secure` and that is how the product is actually served. Over plain
 * http, WebKit correctly refuses those cookies and the whole authenticated
 * journey collapses in the non-Chromium engine — which is a fact about the test
 * environment, not the product, and must never be "fixed" by relaxing cookie
 * flags. Set PLAYWRIGHT_TEST_BASE_URL to point at a different origin (e.g. a
 * plain-http dev server) when working on the design system.
 */
export default defineConfig({
  testDir: './e2e',
  // The journeys walk real, data-backed pages. A first paint in dev mode also
  // compiles the route on demand (measured: >30s on a 2-core runner), so the
  // budget is generous; assertions below still fail fast on real breakage.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  /*
   * ONE worker, always.
   *
   * The suite starts an application server and a browser engine in the same
   * memory budget. Parallel workers on a small runner made the kernel OOM-kill
   * `next-server` mid-run, which Playwright reports as a batch of tests that
   * "did not run" — a green-looking summary over tests that never executed. That
   * is exactly the class of false evidence H-6 exists to remove, so the suite is
   * memory-bounded by construction rather than by luck: one worker, and a heap
   * cap on the server below.
   */
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'https://localhost:3443',
    // The TLS front end uses a throwaway self-signed certificate for localhost.
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /*
     * A real deployment sits behind a proxy, so every request carries the
     * client address the proxy observed; the app only trusts it because the
     * deployment declares TRUSTED_PROXY_HOPS (see lib/http/client-ip.ts, H-4).
     * Providing it here reproduces that condition, and a per-run value keeps
     * this run's rate-limit buckets separate from the previous run's — without
     * touching the limits themselves.
     */
    extraHTTPHeaders: {
      'x-forwarded-for': process.env.E2E_CLIENT_IP ?? `198.51.100.${1 + (Date.now() % 240)}`,
    },
  },
  projects: [
    // Establish the authenticated sessions ONCE (real /api/auth/login calls
    // against the seeded database) and store them as Playwright state.
    //
    // The state is NOT applied to the whole project: most specs here probe the
    // product as an ANONYMOUS caller (that is the point of h5-operational-surface
    // and parent-journey). Only the authenticated journey opts in, with
    // `test.use({ storageState })`, so no spec silently gains a session it did
    // not ask for.
    { name: 'auth-setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['auth-setup'],
    },
    // Non-Chromium pass (H-6). WebKit is the closest thing to the iOS/desktop
    // Safari an operator may use; it catches engine-specific breakage that a
    // chromium-only suite cannot.
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['auth-setup'],
    },
  ],
  webServer: [
    {
      /*
       * `E2E_SERVER_COMMAND` lets the same suite run against the built artifact
       * (`NODE_ENV=production next start`) instead of the dev server. CI does
       * exactly that, so the release evidence covers what ships — including the
       * readiness route running in production mode — and not just what compiles
       * on demand.
       */
      command: process.env.E2E_SERVER_COMMAND ?? 'npm run dev',
      url: 'http://127.0.0.1:3000/api/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        // The register endpoint keys its rate limit on the client address, and it
        // ignores x-forwarded-for unless the deployment declares how many proxies
        // it runs behind (H-4/F9). The e2e server is started directly, so we declare
        // one hop and let a spec drive its own bucket with a forwarded address.
        TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS ?? '1',
        // Cap the server's heap so it garbage-collects instead of being
        // OOM-killed by the kernel (measured: next-server at ~1GB RSS on a ~2GB
        // runner, killed mid-suite).
        NODE_OPTIONS: process.env.SERVER_NODE_OPTIONS ?? '--max-old-space-size=768',
        // The suite runs against the seeded database, and the readiness gate it
        // waits on must prove THAT database.
        DATABASE_URL: E2E_DATABASE_URL,
        // The app performs some server-side fetches against its own origin. Over
        // the TLS front end those hit the throwaway certificate, so the CA is
        // ADDED to the trust store (`NODE_EXTRA_CA_CERTS`) — certificate
        // verification stays fully on; nothing here disables it.
        NODE_EXTRA_CA_CERTS: 'e2e/.artifacts/tls/localhost-cert.pem',
      },
    },
    // TLS front end. Readiness is proxied, so the browser origin is only
    // reported ready when the app behind it is.
    {
      command: 'node scripts/e2e-https-proxy.mjs',
      url: 'https://localhost:3443/api/ready',
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
