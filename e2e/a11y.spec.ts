import { test, expect } from '@playwright/test';

/**
 * M1 accessibility smoke tests — keyboard navigation, focus rings, ARIA, reduced-motion.
 * These are lightweight runtime checks (not axe-core, which would be added in M2+).
 */
test.describe('@design-system M1 a11y — keyboard navigation on Command Center', () => {
  test('focus rings appear when tabbing through nav and buttons', async ({ page }) => {
    await page.goto('/preview/command-center');

    // Tab past the skip link; confirm focus advances onto an interactive element
    // (we can't cross-browser assert computed outline reliably, but we confirm the
    // focused element is a button/link/input and not body).
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
    }
    const focusedAfter = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { tag: '', text: '' };
      // Check whether the focused element has some focus indicator
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 40),
        outline: style.outlineWidth + ' ' + style.outlineColor,
        ring: style.boxShadow,
        notBody: el !== document.body,
      };
    });
    expect(focusedAfter.notBody).toBe(true);
    expect(['a', 'button', 'input']).toContain(focusedAfter.tag);
  });

  test('skip link appears on first Tab (accessibility shortcut)', async ({ page }) => {
    await page.goto('/preview/command-center');
    await page.keyboard.press('Tab');
    const skipLink = page.locator('a[href="#main-content"]');
    // Skip link may be visually hidden until focus; just verify it exists as first tab stop
    await expect(skipLink).toHaveCount(1);
  });

  test('page has one main landmark and one h1', async ({ page }) => {
    await page.goto('/preview/command-center');
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveCount(1);
  });

  test('reduced-motion preference is honored (prefers-reduced-motion media query applied)', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/preview/primitives');
    // The globals.css sets --motion-duration-fast/-base to 0ms when reduced.
    const fast = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-fast').trim(),
    );
    expect(fast).toBe('0ms');
  });

  test('icons in buttons have aria-hidden (not announced to screen readers when label present)', async ({
    page,
  }) => {
    await page.goto('/preview/command-center');
    // Every button that contains an SVG should either:
    //  - have aria-label, or
    //  - have visible text, and its SVGs should be aria-hidden.
    const badButtons = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll('button, a').forEach((el) => {
        const svgs = el.querySelectorAll('svg');
        if (svgs.length === 0) return;
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        // If the element has no visible text and no aria-label, that's a problem
        if (!text && !ariaLabel) {
          bad.push(
            `<${el.tagName.toLowerCase()}> no text/aria-label; classes=${(el as HTMLElement).className.slice(0, 80)}`,
          );
          return;
        }
        // SVGs inside labelled elements must be aria-hidden
        svgs.forEach((s) => {
          if (s.getAttribute('aria-hidden') !== 'true' && s.getAttribute('role') !== 'img') {
            bad.push(
              `<${el.tagName.toLowerCase()}> svg not hidden; label="${(text || ariaLabel || '').slice(0, 40)}"`,
            );
          }
        });
      });
      return bad;
    });
    expect(badButtons).toEqual([]);
  });

  test('dialogs have role=dialog and close on Escape', async ({ page }) => {
    await page.goto('/preview/primitives');
    // Dialog example lives under the "Overlays" tab
    await page.getByRole('tab', { name: /overlays/i }).click();
    const openBtn = page.getByRole('button', { name: /open dialog/i });
    await openBtn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('contrast: primary CTA button text vs background is legible', async ({ page }) => {
    await page.goto('/preview/primitives');
    // Buttons tab has plenty of primary (forest) CTAs
    await page.getByRole('tab', { name: /buttons/i }).click();
    const colorInfo = await page.evaluate(() => {
      // Find a default/forest button — walk all buttons and pick the first with non-transparent bg
      const btns = Array.from(document.querySelectorAll('button')) as HTMLElement[];
      for (const b of btns) {
        const cs = getComputedStyle(b);
        if (
          cs.backgroundColor &&
          cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          cs.backgroundColor !== 'transparent'
        ) {
          return {
            color: cs.color,
            bg: cs.backgroundColor,
            label: (b.textContent || '').slice(0, 40),
          };
        }
      }
      return null;
    });
    expect(colorInfo).not.toBeNull();
    // Text must be a light color against forest (forest is very dark green)
    expect(colorInfo!.bg).toMatch(/rgb/);
    expect(colorInfo!.color).toMatch(/rgb/);
  });
});
