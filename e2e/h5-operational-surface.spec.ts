import { expect, test } from '@playwright/test';

/**
 * H-5 — the operational surface is not on the public internet.
 *
 * The R3 hardening closed the *payer-facing* surface; H-5 added operator
 * surfaces (rotation, exposure report, abuse signals) and an operational CLI.
 * Those are new URLs, and a new URL is a new opportunity to expose something by
 * accident. This spec asks the bluntest possible question over real HTTP, with
 * no session at all:
 *
 *   - can an anonymous caller rotate a link? (No — and the response must not
 *     tell them whether the token exists.)
 *   - can an anonymous caller read the exposure report or the abuse signals?
 *     (No — these describe a school's incidents; they are not public data.)
 *   - is the CLI reachable over HTTP? (It is not an HTTP surface at all.)
 *
 * The tokens used here do not exist, which is the point: an unauthenticated
 * caller must not learn anything either way.
 */
const UNKNOWN_TOKEN = 'h5-probe-token-that-does-not-exist';

test.describe('H-5 operational surface is closed to anonymous callers', () => {
  test('rotation cannot be performed anonymously', async ({ request }) => {
    const res = await request.post(`/api/payment-links/${UNKNOWN_TOKEN}/rotate`, {
      data: { reason: 'anonymous probe' },
      failOnStatusCode: false,
    });
    expect([401, 403]).toContain(res.status());
    const body = await res.text();
    // No oracle: the refusal must not distinguish "no such link" from
    // "not your school" from "you may not rotate".
    expect(body.toLowerCase()).not.toContain(UNKNOWN_TOKEN);
  });

  test('the exposure report is not anonymously readable', async ({ request }) => {
    const res = await request.get('/api/payment-links/exposure', { failOnStatusCode: false });
    expect([401, 403]).toContain(res.status());
  });

  test('the abuse-signal feed is not anonymously readable', async ({ request }) => {
    const res = await request.get('/api/payment-links/signals?since=24h', { failOnStatusCode: false });
    expect([401, 403]).toContain(res.status());
  });

  test('the operational CLI is not an HTTP surface', async ({ request }) => {
    // The CLI is a script an operator runs with the migration credential. It
    // must not be reachable as a URL: the script path and a plausible /ops
    // route both fall through to the auth gate, and /api/ops is a JSON 401.
    for (const path of ['/scripts/public-surface-ops.ts', '/ops']) {
      const res = await request.get(path, { failOnStatusCode: false, maxRedirects: 0 });
      // 307/302: rejected back to sign-in. 404: not a route at all. Never 200.
      expect([302, 307, 404]).toContain(res.status());
      if (res.status() !== 404) {
        expect(res.headers()['location'] ?? '').toMatch(/\/login/);
      }
      // And if a client follows the redirect, it lands on the sign-in page,
      // not on operator output.
      const followed = await request.get(path, { failOnStatusCode: false });
      expect(followed.status()).toBe(200);
      expect(await followed.text()).toMatch(/password/i);
    }
    const api = await request.get('/api/ops', { failOnStatusCode: false });
    expect(api.status()).toBe(401);
  });
});
