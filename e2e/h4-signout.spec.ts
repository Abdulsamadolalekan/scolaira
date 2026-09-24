import { expect, test } from '@playwright/test';

/**
 * H-4 — the sign-out form still works after logout became CSRF-protected.
 *
 * The fix accepts the double-submit token from a `_csrf` form field as well as
 * the `x-csrf-token` header, precisely so the app-shell's plain HTML form keeps
 * working without JavaScript. This spec exercises the real browser path: sign
 * up over HTTP, load the shell, press the button, and confirm the session is
 * gone afterwards (a fresh visit lands on the sign-in page).
 */
test.describe('H-4 sign-out lifecycle', () => {
  test('the no-JS sign-out form posts the CSRF field and ends the session', async ({ page, request, context }) => {
    const stamp = Date.now().toString(36);
    const email = `e2e-signout-${stamp}@example.com`;
    const password = 'Str0ng!Passw0rd-For-E2E';

    const registered = await request.post('/api/auth/register', {
      // Own bucket: the endpoint rate-limits 5 signups/hour per client address.
      headers: { 'x-forwarded-for': `198.51.100.${(Date.now() % 200) + 10}` },
      data: {
        email,
        password,
        firstName: 'Sign',
        lastName: 'Out',
        organizationName: `E2E Sign-out School ${stamp}`,
        organizationSlug: `e2e-signout-${stamp}`,
      },
    });
    expect(registered.status()).toBe(201);

    // Hand the API session to the browser: the response's Set-Cookie headers are
    // parsed explicitly rather than relying on the request context's jar, so the
    // spec tests the app, not Playwright's cookie plumbing.
    const setCookies = (registered.headersArray() ?? [])
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value.split(';')[0] ?? '')
      .filter((pair) => pair.includes('='));
    expect(setCookies.length).toBeGreaterThanOrEqual(2);
    await page.context().addCookies(
      setCookies.map((pair) => {
        const eq = pair.indexOf('=');
        return { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: 'http://127.0.0.1:3000' };
      }),
    );

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);

    // The sign-out control is a plain submit button inside a POST form that
    // carries the hidden `_csrf` field.
    const form = page.locator('form[action="/api/auth/logout"]');
    await expect(form).toHaveCount(1);
    const csrfField = form.locator('input[name="_csrf"]');
    await expect(csrfField).not.toHaveValue('');

    // The rendered field carries the same double-submit token the JS callers
    // send as a header (readable cookie by design).
    const cookieCsrf = (await page.context().cookies()).find((c) => c.name === 'sc_csrf')?.value;
    expect(cookieCsrf).toBeTruthy();
    expect(await csrfField.inputValue()).toBe(cookieCsrf);

    // Submit it the way the browser does. Assert on the request (reliable for a
    // form submit that navigates) …
    const [logoutRequest] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes('/api/auth/logout') && r.method() === 'POST',
        { timeout: 20_000 },
      ),
      form.locator('button[type="submit"]').click({ noWaitAfter: true }),
    ]);
    // … and the field was actually part of the submitted body.
    expect(logoutRequest.postData() ?? '').toContain('_csrf=');

    // The navigation response object is not reliably observable for a form
    // submit, so the effect is asserted instead: the browser's cookies were
    // cleared and the session was revoked server-side.
    await expect
      .poll(async () => page.evaluate(async () => (await fetch('/api/auth/me')).status), {
        timeout: 20_000,
      })
      .toBe(401);

    // Session is gone: a fresh page in the same context lands on sign-in.
    const afterSignOut = await context.newPage();
    await afterSignOut.goto('/dashboard');
    await expect(afterSignOut).toHaveURL(/\/login/, { timeout: 20_000 });
  });
});
