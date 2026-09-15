import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Visual QA screenshot capture for M1.
 * Saves desktop / tablet / mobile screenshots for human pixel review.
 */

const OUT_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });
['desktop', 'tablet', 'mobile'].forEach((s) => {
  fs.mkdirSync(path.join(OUT_DIR, s), { recursive: true });
});

const viewports = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const;

const pages = [
  { name: '01-command-center', url: '/preview/command-center' },
  { name: '02-primitives-tokens', url: '/preview/primitives' },
  { name: '03-invoices-list', url: '/preview/list/invoices' },
  { name: '04-invoice-detail', url: '/preview/invoice/INV-1042', full: true },
  { name: '05-students-list', url: '/preview/list/students' },
  { name: '06-payments-list', url: '/preview/list/payments' },
];

for (const [device, vp] of Object.entries(viewports)) {
  for (const p of pages) {
    test(`${device}: ${p.name}`, async ({ page }) => {
      await page.setViewportSize(vp);
      const res = await page.goto(p.url);
      expect(res?.status()).toBe(200);
      // Wait for a stable heading to appear
      await page.waitForSelector('h1, h2', { timeout: 15000 });
      await page.waitForTimeout(500);
      const file = path.join(OUT_DIR, device, `${p.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      if (p.full) {
        await page.screenshot({
          path: path.join(OUT_DIR, device, `${p.name}-full.png`),
          fullPage: true,
        });
      }
    });
  }
}
