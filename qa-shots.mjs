/**
 * Rendered-product QA capture for the setup guide (Phase 1).
 *
 * Why this exists: unit tests, route tests and the Playwright journey all read the
 * DOM, and a DOM that is correct can still render badly. This script drives the
 * built app at the viewports that matter for a Nigerian primary school — a desktop
 * laptop and a 430px / 390px phone — writes PNGs into qa/, and prints an overflow
 * report so clipping is measured rather than guessed.
 *
 * It only ever VALIDATES a CSV (the import panel's review state); nothing is
 * committed, so the fixture school's records — including its invoices — are
 * untouched.
 *
 * Usage:  node qa-shots.mjs
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Credentials come from the E2E seed artefact, never from a hard-coded copy, so
// this keeps working after the fixture database is rebuilt.
const seed = JSON.parse(readFileSync('e2e/.artifacts/seed.json', 'utf8'));
const EMAIL = seed.owner.email;
const PASSWORD = seed.owner.password;
const CLASS = 'SS3 East';

const HEAD =
  'Adm No,Surname,First Name,Sex,DOB,Class,Parent Name,Parent Phone,Relationship,Primary';
// Row 2 names a class that does not exist; row 3 has no admission number and an
// unreadable phone. Both states have to be legible on a phone.
const csv = [
  HEAD,
  `QA-001,Eze,Ada,F,2013-09-02,${CLASS},Chidi Eze,0803 555 0142,Mother,yes`,
  'QA-002,Danjuma,Musa,M,2012-04-11,SS4 North,Aisha Danjuma,call mama,Father,no',
  ',Okonkwo,Ngozi,F,2013-01-20,SS3 East,Emeka Okonkwo,0803 555 0301,Uncle,no',
].join('\n');

const browser = await chromium.launch();

/**
 * Sign in ONCE and hand the session to every capture. The app rate-limits logins
 * per IP (10 per quarter hour, by design), and a QA script that spends nine of
 * them is a QA script that gets locked out of its own run.
 */
/**
 * `QA_STATE=<path>` reuses an existing Playwright storage state instead of signing
 * in — which is what the E2E release gate already produces. Without it this script
 * signs in once and caches the session in qa/.state.json (deleted after use).
 */
const STATE = process.env.QA_STATE ?? 'qa/.state.json';
const usingGivenState = Boolean(process.env.QA_STATE);
if (!usingGivenState) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('https://localhost:3443/login', { waitUntil: 'networkidle' });
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
  await ctx.storageState({ path: STATE });
  await ctx.close();
}

/** Anything wider than the viewport, plus any section hint cut mid-word. */
async function overflowReport(page, label) {
  const report = await page.evaluate(() => {
    const vw = window.innerWidth;
    const wide = [];
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && r.width > 0) {
        const tag = el.tagName.toLowerCase();
        const cls = typeof el.className === 'string' ? el.className.slice(0, 55) : '';
        wide.push(`${tag}.${cls} [${Math.round(r.left)}→${Math.round(r.right)}]`);
      }
    }
    const clipped = [...document.querySelectorAll('main p, main td, main li')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => `"${e.textContent.trim().slice(0, 46)}" (${e.scrollWidth}>${e.clientWidth})`);
    const de = document.scrollingElement ?? document.documentElement;
    return {
      vw,
      pageScrollWidth: de.scrollWidth,
      pageScrollable: de.scrollWidth > de.clientWidth + 1,
      overflowing: wide.slice(0, 6),
      clipped,
    };
  });
  const ok = report.pageScrollable === false && report.clipped.length === 0;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label.padEnd(28)} vw=${report.vw} pageScrollWidth=${report.pageScrollWidth} clipped=${report.clipped.length}` +
      (report.clipped.length ? ` → ${report.clipped.join(' | ')}` : '') +
      (report.pageScrollable ? ` OVERFLOWS → ${report.overflowing.join(' , ')}` : ''),
  );
}

async function openReview(page) {
  await page.goto('https://localhost:3443/onboarding', { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /^Students\b/i })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page
    .locator('#import-file')
    .setInputFiles({ name: 'qa.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.waitForTimeout(2500);
}

/** The guide itself, without a CSV in flight. */
async function openGuide(page) {
  await page.goto('https://localhost:3443/onboarding', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
}

const jobs = [
  { name: 'onboarding-1440-guide', viewport: { width: 1440, height: 900 }, act: openGuide },
  { name: 'onboarding-1440-review', viewport: { width: 1440, height: 900 }, act: openReview },
  { name: 'onboarding-1280-review', viewport: { width: 1280, height: 900 }, act: openReview },
  { name: 'onboarding-1024-review', viewport: { width: 1024, height: 900 }, act: openReview },
  { name: 'onboarding-390-review', viewport: { width: 390, height: 844 }, act: openReview },
  {
    name: 'onboarding-390-review-bottom',
    viewport: { width: 390, height: 844 },
    act: openReview,
    fullPage: false,
    scrollToBottom: true,
  },
  { name: 'onboarding-430-review', viewport: { width: 430, height: 932 }, act: openReview },
  { name: 'onboarding-390-guide', viewport: { width: 390, height: 844 }, act: openGuide },
  {
    name: 'onboarding-390-session',
    viewport: { width: 390, height: 844 },
    act: async (page) => {
      await page.goto('https://localhost:3443/onboarding', { waitUntil: 'networkidle' });
      await page
        .getByRole('button', { name: /^Academic session\b/i })
        .first()
        .click();
      await page.waitForTimeout(600);
    },
  },
];

for (const job of jobs) {
  const ctx = await browser.newContext({
    viewport: job.viewport,
    ignoreHTTPSErrors: true,
    storageState: STATE,
  });
  const page = await ctx.newPage();
  if (job.act) await job.act(page);
  if (job.scrollToBottom) await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await overflowReport(page, job.name);
  await page.screenshot({ path: `qa/${job.name}.png`, fullPage: job.fullPage !== false });
  await ctx.close();
}

await browser.close();
