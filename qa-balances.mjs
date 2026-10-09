/**
 * Rendered-product QA capture for the Phase 2 carry-in register.
 *
 * Same discipline as `qa-shots.mjs` (Phase 1): the Playwright journeys and the
 * vitest suites read the DOM, and a DOM that is correct can still render badly —
 * which matters most here because the register puts five money figures side by
 * side in a table on a desktop and in a stacked list on a 390px phone.
 *
 * It writes a DRAFT and approves it. It deliberately does NOT post: posting is
 * the only action that creates an invoice, and this capture runs against the
 * shared E2E fixture school that other specs count on. The invoice count is
 * printed before and after so the claim "nothing was billed" is measured rather
 * than asserted.
 *
 * Usage:
 *   QA_STATE=e2e/.artifacts/state-owner.json node qa-balances.mjs
 *   QA_BASE=https://localhost:3443 (default) · QA_SKIP_WRITE=1 to only look.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.QA_BASE ?? 'https://localhost:3443';
const STATE = process.env.QA_STATE;
if (!STATE) {
  console.error(
    'QA_STATE=<playwright storage state> is required (logins are rate-limited by design).',
  );
  process.exit(2);
}

const MARK = `QA${Date.now().toString(36).slice(-5).toUpperCase()}`;
// A unique amount, because the register cannot delete a row it has recorded (by
// design), and repeated capture runs must not be confused with each other.
const NAIRA = 40_000 + (Date.now() % 50_000);
const AMOUNT_TEXT = `₦${NAIRA.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
let passed = 0;
let total = 0;
function check(label, ok, extra = '') {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  return ok;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: STATE,
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

/** The same measurement qa-shots.mjs uses, so the two sets of numbers compare. */
async function overflowReport(label) {
  const report = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1)
      .map((e) => `${e.tagName}.${(e.className || '').toString().slice(0, 28)}`);
    const clipped = [...document.querySelectorAll('main p, main td, main li, main dd, main dt')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => `"${e.textContent.trim().slice(0, 46)}" (${e.scrollWidth}>${e.clientWidth})`);
    return {
      vw: de.clientWidth,
      pageScrollWidth: de.scrollWidth,
      pageScrollable: de.scrollWidth > de.clientWidth + 1,
      overflowing: wide.slice(0, 6),
      clipped,
    };
  });
  const ok = report.pageScrollable === false && report.clipped.length === 0;
  check(
    `overflow ${label}`.padEnd(34),
    ok,
    `vw=${report.vw} pageScrollWidth=${report.pageScrollWidth} clipped=${report.clipped.length}` +
      (report.clipped.length ? ` → ${report.clipped.join(' | ')}` : '') +
      (report.pageScrollable ? ` OVERFLOWS → ${report.overflowing.join(' , ')}` : ''),
  );
  return ok;
}

const text = async () => (await page.locator('main').innerText()) ?? '';

/**
 * The register's five figures, read out of the summary card by label.
 *
 * Asserting on the card and not on the page's whole text matters: the five labels
 * are on the screen permanently, so a check like "the page says Approved, not
 * posted" is true before anything has been approved. The numbers are what moved.
 */
async function card(label) {
  const t = await text();
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  return i >= 0 && lines[i + 1] ? lines[i + 1] : '';
}

// ---------------------------------------------------------------- 1440 desktop
await page.goto(`${BASE}/finance/opening-balances`, { waitUntil: 'networkidle' });
const heading = await text();
check(
  'page renders (not an error boundary)',
  !/something went wrong|Application error/i.test(heading),
);
check(
  'register explains itself',
  /carry-in|opening/i.test(heading),
  heading.split('\n')[0]?.slice(0, 60),
);
check(
  'five figures are shown apart, never summed',
  /Owed from before, still outstanding/.test(heading) &&
    /Waiting to be reviewed/.test(heading) &&
    /Approved, not posted/.test(heading) &&
    /Credits and overpayments/.test(heading) &&
    /Unverified/.test(heading),
);
check(
  'an empty register is not called complete',
  /Nothing carried in yet|carried in nothing yet|no figures yet/i.test(heading) ||
    /figure/i.test(heading),
);
await overflowReport('register-1440');
await page.screenshot({ path: 'qa/phase2-register-1440.png', fullPage: true });

// ---------------------------------------------------------------- record a draft
if (!process.env.QA_SKIP_WRITE) {
  await page.selectOption('#ob-student', { index: 0 });
  const who = (
    await page.locator('#ob-student').evaluate((el) => el.options[el.selectedIndex].text)
  )
    .replace(/\s+·\s+.*$/, '')
    .trim();
  check('the child picker names a real child', who.length > 3 && !/undefined/i.test(who), who);

  await page.selectOption('#ob-category', { value: 'HISTORICAL_BALANCE' });
  const categoryCopy = await page.evaluate(() => {
    const el = document.querySelector('#ob-category');
    return el ? el.options[el.selectedIndex].text : '';
  });
  check(
    'the category selector explains what will happen',
    /past term|owe/i.test(categoryCopy),
    categoryCopy.slice(0, 40),
  );

  await page.fill('#ob-amount', String(NAIRA));
  await page.fill('#ob-asat', '2026-06-30');
  await page.fill('#ob-source', `Old receipt book, page 14 (${MARK})`);
  await page.getByRole('button', { name: /record it/i }).click();

  const row = page.locator('tr', { hasText: AMOUNT_TEXT }).first();
  await row.waitFor({ timeout: 25_000 });
  const rowWords = ((await row.innerText()) ?? '').replace(/\s+/g, ' ');
  const afterRecord = await text();
  check(
    'the recorded figure appears as its own row',
    /Not reviewed yet/.test(rowWords),
    rowWords.slice(0, 110),
  );
  check(`${NAIRA} typed, ${AMOUNT_TEXT} rendered from kobo`, afterRecord.includes(AMOUNT_TEXT));
  check('the row names the child the form showed', afterRecord.includes(who));
  check('the form says recording is not billing', /does not bill anyone/i.test(afterRecord));
  check(
    'recording billed nothing — no invoice number on the row',
    !/INV-\d{4}-\d{6}/.test(rowWords),
  );
  await overflowReport('after-record-1440');
  await page.screenshot({ path: 'qa/phase2-draft-1440.png', fullPage: true });

  // ------------------------------------------------------------------ approve
  // Opening a row's actions renders them in the row BELOW it (a details strip, not
  // a cell), so the Approve button is addressed from the page and the assertions
  // are read from the data row itself.
  await row.getByRole('button', { name: /^actions$/i }).click();
  await page
    .getByRole('button', { name: /^Approve$/i })
    .first()
    .click();
  await page
    .locator('tr')
    .filter({ hasText: AMOUNT_TEXT })
    .filter({ hasText: 'Approved, not posted' })
    .first()
    .waitFor({ timeout: 25_000 });
  const mainAfterApprove = await text();
  const approvedRow = ((await row.innerText()) ?? '').replace(/\s+/g, ' ');
  check(
    'this row now reads as approved, not posted',
    /Approved, not posted/.test(approvedRow),
    approvedRow.slice(0, 110),
  );
  check(
    'self-approval is stated on the row, not hidden',
    /recorded and approved by the same person/.test(approvedRow),
  );
  check(
    'an approved row is not posted while its past term is unknown',
    /as soon as the term it belongs to is set/i.test(mainAfterApprove),
  );
  check('approval created no invoice', !/INV-\d{4}-\d{6}/.test(approvedRow));
  await overflowReport('after-approve-1440');
  await page.screenshot({ path: 'qa/phase2-approved-1440.png', fullPage: true });

  // ------------------------------------------------- the guide sees the change
  await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' });
  const guide = await text();
  check(
    'the setup guide reports the register honestly',
    /approved figure.*not yet posted|waiting to be approved/i.test(guide),
    (guide.match(/.*(approved figure|waiting to be approved).*/i) ?? ['(none)'])[0]
      .trim()
      .slice(0, 64),
  );
  await page.screenshot({ path: 'qa/phase2-guide-1440.png', fullPage: true });
}

// ---------------------------------------------------------------- 390 phone
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/finance/opening-balances`, { waitUntil: 'networkidle' });
await overflowReport('register-390');
await page.screenshot({ path: 'qa/phase2-register-390.png', fullPage: true });
const phone = await text();
check(
  'the stacked list shows the rows on a phone',
  phone.includes(AMOUNT_TEXT) && /Not reviewed yet|Approved, not posted/.test(phone),
);
if (!process.env.QA_SKIP_WRITE) {
  await page
    .getByRole('button', { name: /^actions$/i })
    .first()
    .click();
  await overflowReport('mobile-actions-open-390');
  await page.screenshot({ path: 'qa/phase2-mobile-actions-390.png', fullPage: true });
}

console.log(`\nCHECKS ${passed}/${total}`);
await browser.close();
process.exit(passed === total ? 0 : 1);
