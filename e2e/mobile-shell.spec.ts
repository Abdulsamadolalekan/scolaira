/**
 * H-8 — the authenticated shell at 390x844.
 *
 * The audit's finding was that the shell had never been exercised at a phone
 * size. This spec runs the REAL authenticated shell (seeded database, real
 * session, real pages) in a 390x844 viewport and asserts two things that can be
 * measured rather than argued:
 *
 *   NO HORIZONTAL OVERFLOW — the document is never wider than the viewport. The
 *   horizontal navigation strip is a scroll container and is allowed to have
 *   content wider than itself; the PAGE is not. That distinction is asserted
 *   explicitly, so a future change that pushes the page wide fails here instead
 *   of hiding behind an `overflow-x: hidden`.
 *
 *   THE ACCOUNT CONTROL IS REACHABLE — sign-out is visible in the first screen
 *   without scrolling. It was previously at the foot of a ~500px rail, i.e.
 *   below the fold on every phone.
 *
 * The frozen H-4 contract is re-asserted at this breakpoint: exactly one
 * `form[action="/api/auth/logout"]` with its `_csrf` field and exactly one submit
 * button. The mobile band is a restyle, not a second sign-out.
 *
 * The org switcher is exercised too: with one membership the chip is inert (not
 * a menu), and with a second membership it becomes a real menu that switches
 * through the EXISTING `/api/auth/select-organization` route. The extra
 * membership is added by the fixture and removed afterwards, so the world outside
 * this spec is unchanged.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { loadSeed } from './support/seed';
import {
  closeFixtureConnection,
  discoverSupportTarget,
  setMembership,
} from './support/platform-fixture';

const OWNER_STATE = resolve(process.cwd(), 'e2e/.artifacts/state-owner.json');
const PHONE = { width: 390, height: 844 };

/*
 * `isMobile` / `hasTouch` are Chromium-only context options; using them would
 * silently exclude the non-Chromium pass from exactly the check that mobile
 * behaviour needs. The acceptance criterion is about GEOMETRY at 390x844, so the
 * spec sets the viewport and lets both engines measure the same layout.
 */
test.use({
  storageState: OWNER_STATE,
  viewport: PHONE,
});

test.afterAll(async () => {
  await closeFixtureConnection();
});

/** Measure the page width the way a user experiences it. */
async function measureOverflow(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const widest = Math.max(doc.scrollWidth, body.scrollWidth);
    // The offending elements, if any, so a failure names a cause.
    const offenders = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // Elements inside a deliberately scrollable container are not the page's
        // problem; only elements that push the PAGE wide are.
        return r.right > window.innerWidth + 1 && !el.closest('[data-scroll-container]');
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 120));
    return { viewport: window.innerWidth, widest, offenders };
  });
}

const PAGES = ['/dashboard', '/members', '/members/invite', '/invoices', '/collections'];

test.describe('H-8 mobile shell at 390x844', () => {
  for (const path of PAGES) {
    test(`${path} fits the phone: no horizontal page overflow`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('header, aside').first()).toBeVisible();

      const { viewport, widest, offenders } = await measureOverflow(page);

      // The criterion is CONTAINMENT: the document is never wider than the
      // viewport. It is deliberately not `widest === viewport` — WebKit reports a
      // content width below the viewport when nothing overflows (measured: 380 on
      // all five pages), so equality would be an engine-specific accident. A page
      // that overflows still fails, by name, below.
      expect(viewport).toBe(PHONE.width);
      expect(offenders).toEqual([]);
      expect(
        widest,
        `${path} is ${widest}px wide inside a ${viewport}px viewport`,
      ).toBeLessThanOrEqual(PHONE.width);
    });
  }

  test('the account control and sign-out are visible without scrolling', async ({ page }) => {
    await page.goto('/dashboard');
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible();

    // Visible in the first screen, not merely present in the DOM.
    const box = await signOut.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(PHONE.height);

    // The frozen H-4 contract at this breakpoint: ONE form, ONE field, ONE button.
    const forms = page.locator('form[action="/api/auth/logout"]');
    await expect(forms).toHaveCount(1);
    await expect(forms.locator('input[name="_csrf"]')).toHaveCount(1);
    await expect(forms.locator('button[type="submit"]')).toHaveCount(1);
  });

  /**
   * The mobile navigation contract, as built in `components/ui/app-shell.tsx`:
   * a fixed, labelled bottom band (`nav[aria-label="Primary"]`, hidden from `md`
   * up) holding the primary destinations, plus a "More" button that opens the
   * `#app-more` "All destinations" sheet for the rest.
   *
   * The band is deliberately NOT a sideways-scrolling strip. The previous
   * version of this test asserted exactly that (`scrollWidth > clientWidth`) and
   * reached for "Members" inside the band, which is a design the shell replaced:
   * a thumb has to be able to hit every tab, so the overflow moved into the
   * sheet. The promise the test existed to protect — nothing is unreachable on a
   * phone — is asserted here instead, and more strictly: the sheet's destination
   * set must equal the desktop sidebar's, so a destination added to one and not
   * the other fails.
   */
  test('every destination is reachable from the mobile navigation band and its More sheet', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    const band = page.getByRole('navigation', { name: 'Primary' });
    await expect(band).toBeVisible();
    // The desktop sidebar is the wrong control at this width and must not be shown.
    // Read from the DOM rather than the accessibility tree: a hidden node is simply
    // absent from that tree, and `toBeHidden()` on an empty locator proves nothing.
    await expect(page.locator('nav[aria-label="Workspace"]')).toBeHidden();

    // Every tab is labelled: an icon alone is a guess.
    const bandLinks = await band
      .locator('a')
      .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
    expect(bandLinks.length).toBeGreaterThan(0);
    for (const text of bandLinks) expect(text.length).toBeGreaterThan(0);

    // Contained scroll, not page overflow: the band fits the viewport.
    const pageOverflow = () =>
      page.evaluate(() => ({
        bandScrolls: (() => {
          const el = document.querySelector('nav[aria-label="Primary"]');
          return el ? el.scrollWidth > el.clientWidth : null;
        })(),
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
    const before = await pageOverflow();
    expect(before.bandScrolls, 'the bottom band must not scroll sideways').toBe(false);
    expect(before.documentOverflow).toBeLessThanOrEqual(0);

    // The rest of the destinations live in the sheet, and the trigger declares it.
    const sheet = page.locator('#app-more');
    const more = band.getByRole('button', { name: /^more$/i });
    await expect(more).toHaveAttribute('aria-controls', 'app-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(sheet).toHaveAttribute('aria-hidden', 'true');

    await more.click();

    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet).toHaveAttribute('aria-hidden', 'false');
    await expect(sheet.getByText('All destinations')).toBeVisible();

    const sheetHrefs = await sheet
      .locator('a')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    const bandHrefs = await band
      .locator('a')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    // The sidebar is `display: none` at this width, so it is absent from the
    // accessibility tree — `getByRole` would find nothing here and the set
    // comparison below would pass vacuously. Its destinations exist in the DOM
    // at every breakpoint, which is where they have to be read from.
    const sidebarHrefs = await page
      .locator('nav[aria-label="Workspace"] a')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href')));

    // A vacuous comparison is worthless: prove all three sides are populated.
    expect(bandHrefs.length).toBeGreaterThanOrEqual(1);
    expect(sidebarHrefs.length).toBeGreaterThanOrEqual(10);
    expect(sheetHrefs.length).toBeGreaterThanOrEqual(10);

    // One tap from the band, plus the sheet, covers exactly what the desktop
    // sidebar offers — and the sheet is genuinely load-bearing.
    const reachable = new Set([...bandHrefs, ...sheetHrefs]);
    for (const href of sidebarHrefs) expect(reachable.has(href), `${href} unreachable`).toBe(true);
    expect(new Set(sheetHrefs)).toEqual(new Set(sidebarHrefs));
    expect(sheetHrefs.filter((href) => !bandHrefs.includes(href)).length).toBeGreaterThan(0);

    // Opening the sheet must not widen the page.
    expect((await pageOverflow()).documentOverflow).toBeLessThanOrEqual(0);

    // A destination the band does not show is still reachable through it.
    const members = sheet.getByRole('link', { name: /members/i });
    await expect(members).toBeVisible();
    await members.scrollIntoViewIfNeeded();
    await members.click();
    await page.waitForURL(/\/members$/);
  });

  test('the workspace chip is inert with one membership and a real menu with two', async ({
    page,
    context,
  }) => {
    const seed = loadSeed();
    await page.goto('/dashboard');

    // One organization: no menu, nothing to switch to.
    await expect(page.getByRole('button', { name: /switch workspace/i })).toHaveCount(0);
    await expect(page.getByText(seed.organization.name).first()).toBeVisible();

    const target = await discoverSupportTarget(seed.platformAdmin.email);
    await setMembership(target.organizationId, seed.owner.userId, 'add');
    try {
      await page.reload();
      const chip = page.getByRole('button', { name: /switch workspace/i });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute(
        'aria-label',
        `Switch workspace (currently ${seed.organization.name})`,
      );

      await chip.click();
      // Assert the REQUEST, not a piece of text: the menu item carries the target
      // name too, so polling for that text can pass before the POST has even
      // returned (measured — the reload then raced the cookie write).
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/select-organization')),
        page.getByRole('menuitem', { name: new RegExp(target.name, 'i') }).click(),
      ]);
      expect(response.status()).toBe(200);

      // The chip itself now reports the new workspace.
      await expect(chip).toHaveAttribute(
        'aria-label',
        `Switch workspace (currently ${target.name})`,
      );

      // ...and it survives a full reload, i.e. the signed active-org cookie took.
      await page.reload();
      await expect(chip).toHaveAttribute(
        'aria-label',
        `Switch workspace (currently ${target.name})`,
      );

      // Sign-out survived the switch (the frozen contract, after a real switch).
      await expect(page.locator('form[action="/api/auth/logout"]')).toHaveCount(1);
    } finally {
      await setMembership(target.organizationId, seed.owner.userId, 'remove');
      await context.clearCookies({ name: 'sc_org' });
    }
  });
});
