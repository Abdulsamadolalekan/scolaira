import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillStable, signIn } from './support/seed';

/**
 * Phase 1 — guided onboarding and CSV student import, end to end.
 *
 * The first journey registers a BRAND NEW school through the real registration
 * surface and sets it up entirely through the product: academic session, term,
 * activation, classes, and a CSV of students. Two reasons for not borrowing the
 * shared seeded school:
 *
 *   1. It is the honest test. Onboarding exists for a school that has nothing
 *      yet, and a fixture that already had a session, a term and classes would
 *      skip exactly the steps most likely to be broken.
 *   2. It leaves the rest of the suite's school untouched, so no other spec's
 *      expectations move because this one added students.
 *
 * The later journeys reuse that school — held in a session state file captured by
 * the first journey — because BOTH the registration limit (five per hour per
 * address) and the login limit (ten per fifteen minutes) are real security
 * controls that must not be weakened to make a test convenient. A journey that
 * signed in for every test would spend the budget that protects real users.
 *
 * Everything the interface claims is checked against a fresh page load: a step
 * that only exists in React state would satisfy a weaker test while still losing
 * the school's data.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now().toString(36);
const SCHOOL = `Guide Test ${STAMP}`;
const SLUG = `guide-test-${STAMP}`;
const EMAIL = `owner-${STAMP}@example.test`;
const PASSWORD = 'Onboarding-journey-password-A1!';
const ADMISSION_PREFIX = `GT-${STAMP.toUpperCase()}-`;
const STATE_PATH = resolve(process.cwd(), 'e2e/.artifacts/state-onboarding-owner.json');

const HEAD =
  'Adm No,Surname,First Name,Sex,DOB,Class,Parent Name,Parent Phone,Relationship,Primary';

function csv(...rows: string[]): string {
  return [HEAD, ...rows].join('\n');
}

/**
 * Navigate after an action that triggered `router.refresh()`.
 *
 * Measured on WebKit: the refresh started by an import is still in flight when the
 * next `page.goto` begins, and the goto is aborted by it —
 * "Navigation … is interrupted by another navigation". Waiting for the network to
 * settle first is what a person experiences as the page finishing its update.
 */
async function gotoSettled(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.goto(path);
}

/**
 * Register a school through the real form and land in its workspace.
 *
 * The register form's labels are not associated with their inputs, so fields are
 * addressed by placeholder or by order. `fillStable` is used because a value
 * written before hydration is silently wiped by React — the documented WebKit
 * trap in this suite.
 */
async function registerSchool(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/register');
  const boxes = page.locator('input');
  await fillStable(boxes.nth(0), 'Guide');
  await fillStable(boxes.nth(1), 'Owner');
  await fillStable(page.getByPlaceholder('you@school.edu.ng'), EMAIL);
  await fillStable(page.getByPlaceholder('Grace Academy'), SCHOOL);
  await fillStable(page.getByPlaceholder('grace-academy'), SLUG);
  await fillStable(page.getByPlaceholder('At least 10 characters'), PASSWORD);
  await fillStable(page.locator('input[type="password"]').nth(1), PASSWORD);
  await page.getByRole('button', { name: /create workspace/i }).click();
  try {
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  } catch {
    // Already registered — a re-run of this file. The account exists, so sign in.
    await signIn(page, { email: EMAIL, password: PASSWORD });
  }
}

/**
 * Open the school this file registered, using the session captured by the first
 * journey. Falls back to a real sign-in only if that state is missing.
 */
async function openSchool(
  browser: import('@playwright/test').Browser,
  viewport: { width: number; height: number },
): Promise<{
  context: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
}> {
  const context = await browser.newContext({
    viewport,
    storageState: existsSync(STATE_PATH) ? STATE_PATH : undefined,
  });
  const page = await context.newPage();
  if (!existsSync(STATE_PATH)) await signIn(page, { email: EMAIL, password: PASSWORD });
  return { context, page };
}

/** Open the guide and select a step by its rail label. */
async function openStep(page: import('@playwright/test').Page, label: RegExp): Promise<void> {
  await gotoSettled(page, '/onboarding');
  await expect(page.getByRole('heading', { name: /set up scolaira/i })).toBeVisible({
    timeout: 20_000,
  });
  // A rail button's accessible name is its label PLUS its detail and its state,
  // so the pattern anchors on the label as a prefix rather than the whole name.
  await page.getByRole('button', { name: label }).first().click();
}

test('a new school can set itself up and import its students', async ({ page }) => {
  test.setTimeout(480_000);

  await registerSchool(page);
  // Capture the session for the journeys below, so they cost no login attempts.
  await page.context().storageState({ path: STATE_PATH });

  // ── The guide tells the truth about a school with nothing ───────────────
  await gotoSettled(page, '/onboarding');
  await expect(page.getByRole('heading', { name: /set up scolaira/i })).toBeVisible();
  // The lede states the promise in words rather than a step count, so the count is
  // read where the count lives: the rail. A school with nothing recorded has six
  // steps in front of it — the five that make a term billable, plus the carry-in
  // register Phase 2 added, because a missed balance is money a school loses.
  await expect(
    page.getByText(/from an empty workspace to a school that can be billed/i),
  ).toBeVisible();
  await expect(page.getByText(SCHOOL).first()).toBeVisible();

  // Progress is read from records: only the school itself is complete. Anchored
  // patterns, because "Not yet completed" CONTAINS "Completed" — an unanchored
  // match would count every unfinished step as finished. The current step's node
  // reads "Not yet completed, current step", so the exact count is one short.
  const rail = page.locator('ol').first();
  await expect(rail.getByText('Not yet completed', { exact: true })).toHaveCount(4);
  await expect(rail.getByText(/^Not yet completed/)).toHaveCount(5);
  await expect(rail.getByText(/^Completed/)).toHaveCount(1);
  // The carry-in step is on the rail for this role, named rather than implied.
  await expect(rail.getByRole('button', { name: /^Carry in what is owed/i })).toBeVisible();

  // ── Academic session ────────────────────────────────────────────────────
  await page
    .getByRole('button', { name: /academic session/i })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /academic session/i })).toBeVisible();
  // Defaults are pre-filled with the Nigerian session year, so this is one click.
  const sessionName = await page.getByLabel('Session name').inputValue();
  expect(sessionName).toMatch(/^\d{4}\/\d{4}$/);
  await page.getByRole('button', { name: /^create session$/i }).click();
  await expect(page.getByText(/Session \d{4}\/\d{4} created\./)).toBeVisible({ timeout: 20_000 });

  // ── Term, then activation ───────────────────────────────────────────────
  // The activation affordance is the one a school setting up from zero depends
  // on: without it its first term can never be made current, and every enrolment
  // is refused.
  await page
    .getByRole('button', { name: /^Term\b/i })
    .first()
    .click();
  await page.getByRole('button', { name: /^create term$/i }).click();
  await expect(page.getByText(/First Term created\./)).toBeVisible({ timeout: 20_000 });
  const activate = page.getByRole('button', { name: /^activate first term$/i });
  await expect(activate).toBeVisible({ timeout: 20_000 });
  await activate.click();
  await expect(page.getByText(/activated\. You can enrol students now\./)).toBeVisible({
    timeout: 20_000,
  });

  // ── Classes ─────────────────────────────────────────────────────────────
  await page
    .getByRole('button', { name: /^Classes\b/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Primary 4', exact: true }).click();
  await page.getByRole('button', { name: 'Primary 5', exact: true }).click();
  await page.getByRole('button', { name: /create 2 classes/i }).click();
  await expect(page.getByText(/2 classes created\./)).toBeVisible({ timeout: 20_000 });

  // ── Import: the file is checked before anything is written ──────────────
  await page
    .getByRole('button', { name: /^Students\b/i })
    .first()
    .click();
  const fileInput = page.locator('#import-file');
  await expect(fileInput).toBeVisible();

  const good = csv(
    `${ADMISSION_PREFIX}001,Eze,Ada,F,2013-09-02,Primary 4,Chidi Eze,0803 555 0142,Mother,yes`,
    `${ADMISSION_PREFIX}002,Danjuma,Musa,M,2012-04-11,Primary 5,Aisha Danjuma,+234 803 555 0200,Father,no`,
    `${ADMISSION_PREFIX}003,Okonkwo,Ngozi,F,2013-01-20,Primary 4,Emeka Okonkwo,0803 555 0301,Uncle,yes`,
  );
  await fileInput.setInputFiles({
    name: 'students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(good, 'utf8'),
  });

  // The review, before anything exists.
  await expect(page.getByText(/3 students ready to import/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no invoices or charges will be created/i).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}001` })).toBeVisible();
  // The phone number is shown normalised, which is what will be stored.
  await expect(page.getByText('Chidi Eze · 08035550142')).toBeVisible();
  // Nothing on this page may be cut off. A clipped element is still "visible"
  // to Playwright — an ellipsis is a style, not a state — so the geometry of
  // every text node is asserted instead. This is the check that the rendered
  // product needed: a section hint here used to read "…your records, n…".
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('main p, main td, main li')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => (e.textContent ?? '').trim().slice(0, 40)),
  );
  expect(clipped).toEqual([]);

  // The mapping is shown rather than assumed, including what was NOT used.
  await page.getByText(/column mapping/i).click();
  await expect(page.getByText(/Admission number/)).toBeVisible();
  await expect(page.getByText(/← “Adm No”/)).toBeVisible();

  // Nothing has been written yet: leave the page entirely and look at the roll.
  await gotoSettled(page, '/students');
  await expect(page.getByText(new RegExp(`${ADMISSION_PREFIX}001`))).toHaveCount(0);

  // ── Import, for real ────────────────────────────────────────────────────
  await openStep(page, /^Students\b/i);
  await page.locator('#import-file').setInputFiles({
    name: 'students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(good, 'utf8'),
  });
  await expect(page.getByText(/3 students ready to import/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /import 3 students/i }).click();
  await expect(page.getByText(/3 students imported/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no invoices or charges were created/i)).toBeVisible();

  // ── Persistence: reload the roll and the students are there ─────────────
  // The roll renders each admission number twice — once in the table and once in
  // the small-screen card — so the table cell is the unambiguous target.
  await gotoSettled(page, '/students');
  await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}001` })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}002` })).toBeVisible();
  await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}003` })).toBeVisible();

  // ── The step is now genuinely complete, in the guide's own words ────────
  await gotoSettled(page, '/onboarding');
  await expect(page.getByText(/3 on roll/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/your school is ready to be billed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /set up fees/i })).toBeVisible();
  // Every step that makes a term billable is complete. The one that is left is the
  // carry-in register, and it is left open DELIBERATELY: an empty register is what a
  // missed balance looks like, so the guide refuses to call it finished. What must
  // hold — the thing Phase 2 must not break — is that this school can still bill:
  // readiness is derived from an active term, classes and pupils on roll, never from
  // whether somebody remembered to carry a debt in.
  const railNow = page.locator('ol').first();
  await expect(railNow.getByText(/^Not yet completed/)).toHaveCount(1);
  await expect(railNow.getByText(/^Completed/)).toHaveCount(5);
  await expect(
    railNow.getByRole('button', {
      name: /Carry in what is owed.*Nothing carried in yet/i,
    }),
  ).toBeVisible();
});

test('a file with problems is refused, a corrected file imports, and the same file again is refused', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { context, page } = await openSchool(browser, { width: 1440, height: 900 });

  try {
    // The school, its term and its classes were created by the journey above;
    // this journey reuses them, which is how a bursar returns the next morning.
    await openStep(page, /^Students\b/i);
    const fileInput = page.locator('#import-file');

    // A row with no admission number, a row with no surname, a class that does
    // not exist, and a phone number that cannot be dialled.
    const broken = csv(
      `,Eze,Ada,F,2013-09-02,Primary 4,Chidi Eze,0803 555 0142,Mother,yes`,
      `${ADMISSION_PREFIX}BAD2,,Danjuma,M,2012-04-11,Primary 4,Aisha Danjuma,08035550200,Father,no`,
      `${ADMISSION_PREFIX}BAD3,Okonkwo,Ngozi,F,2013-01-20,Primary 9,Emeka Okonkwo,0803 555 0301,Uncle,yes`,
      `${ADMISSION_PREFIX}BAD4,Musa,Sani,M,2012-02-02,Primary 4,Guardian Sani,call mama,Father,no`,
    );
    await fileInput.setInputFiles({
      name: 'broken.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(broken, 'utf8'),
    });

    // Each problem names the LINE, the COLUMN and how to fix it, and the count
    // says how many must be fixed before the import can run.
    await expect(page.getByText(/^3 problems must be fixed before importing$/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Line 2 · admission number/i)).toBeVisible();
    await expect(page.getByText(/Admission number is required/i)).toBeVisible();
    await expect(page.getByText(/Line 3 · last name/i)).toBeVisible();
    await expect(page.getByText(/Last name is required/i)).toBeVisible();
    await expect(page.getByText(/Line 4 · class/i)).toBeVisible();
    await expect(page.getByText(/No class called "Primary 9" exists/i)).toBeVisible();
    // A refusal that lists what DOES exist, so correcting it is mechanical. Both
    // classes must be named; their order is not something the school depends on.
    await expect(page.getByText(/Your classes are: Primary \d, Primary \d/i)).toBeVisible();
    await expect(page.getByText(/Add the class, or correct the name/i)).toBeVisible();

    // A bad phone number is a WARNING, not an error, and the row still imports —
    // minus the number, which is never invented. The warning says both things.
    await expect(
      page.getByText(/^2 things worth checking — these do not block the import$/),
    ).toBeVisible();
    await expect(page.getByText(/Line 5 · guardian phone/i).first()).toBeVisible();
    await expect(page.getByText(/was NOT imported/i)).toBeVisible();
    await expect(page.getByText(/Correct it and re-upload to keep this number/i)).toBeVisible();

    // The import is genuinely blocked, and the school is told how to fix it.
    await expect(page.getByRole('button', { name: /^import \d+ student/i })).toBeDisabled();
    await expect(page.getByText(/fix the problems above/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /download problem list/i })).toBeVisible();

    // ── Correct the file and upload it again, through the same control ────
    const corrected = csv(
      `${ADMISSION_PREFIX}FIX1,Eze,Ada,F,2013-09-02,Primary 4,Chidi Eze,0803 555 0142,Mother,yes`,
      `${ADMISSION_PREFIX}FIX2,Danjuma,Musa,M,2012-04-11,Primary 4,Aisha Danjuma,08035550200,Father,no`,
    );
    await fileInput.setInputFiles({
      name: 'corrected.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(corrected, 'utf8'),
    });
    await expect(page.getByText(/2 students ready to import/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /import 2 students/i }).click();
    await expect(page.getByText(/2 students imported/i)).toBeVisible({ timeout: 30_000 });

    await gotoSettled(page, '/students');
    await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}FIX1` })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}FIX2` })).toBeVisible();

    // Nothing from the broken file was written.
    await expect(page.getByText(`${ADMISSION_PREFIX}BAD2`)).toHaveCount(0);
    await expect(page.getByText('Guardian Sani')).toHaveCount(0);

    // ── The SAME file again is refused, naming the child already on the roll ─
    await openStep(page, /^Students\b/i);
    await page.locator('#import-file').setInputFiles({
      name: 'corrected-again.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(corrected, 'utf8'),
    });
    await expect(page.getByText(/^2 problems must be fixed before importing$/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/0 students ready to import · 2 rows blocked/i)).toBeVisible();
    await expect(
      page.getByText(new RegExp(`${ADMISSION_PREFIX}FIX1 already belongs to Ada Eze`)),
    ).toBeVisible();
    await expect(
      page.getByText(/Remove this row, or give the student a different admission number/i).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^import \d+ student/i })).toBeDisabled();

    // And the roll still holds exactly one of that child.
    await gotoSettled(page, '/students');
    await expect(page.getByRole('cell', { name: `${ADMISSION_PREFIX}FIX1` })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('the guide is usable on a phone viewport', async ({ browser }) => {
  test.setTimeout(480_000);
  const { context, page } = await openSchool(browser, { width: 390, height: 844 });

  try {
    await gotoSettled(page, '/onboarding');
    await expect(page.getByRole('heading', { name: /set up scolaira/i })).toBeVisible({
      timeout: 20_000,
    });

    // The whole rail is on screen and every step is named rather than implied.
    // This school is already set up, so every step reads as complete.
    for (const label of [
      /^School\b/i,
      /^Academic session\b/i,
      /^Term\b/i,
      /^Classes\b/i,
      /^Students\b/i,
      // Phase 2's step has to survive the phone too — a bursar who carries a debt
      // in does it on the device they have.
      /^Carry in what is owed\b/i,
    ]) {
      await expect(page.getByRole('button', { name: label }).first()).toBeVisible();
    }
    await expect(page.getByText(/^Completed/).first()).toBeVisible();
    await expect(page.getByText(/ready to be billed/i)).toBeVisible();

    // A phone must not scroll sideways to reach the import: a bursar in Lagos
    // does this work on a phone. Scroll width is what a thumb experiences.
    await page
      .getByRole('button', { name: /^Students\b/i })
      .first()
      .click();
    const fileInput = page.locator('#import-file');
    await expect(fileInput).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await fileInput.setInputFiles({
      name: 'phone.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        csv(
          `${ADMISSION_PREFIX}PH1,Eze,Ada,F,2013-09-02,Primary 4,Chidi Eze,08035550142,Mother,yes`,
        ),
        'utf8',
      ),
    });
    await expect(page.getByText(/1 student ready to import/i)).toBeVisible({ timeout: 30_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(clientWidth + 1);

    // The small-screen preview is a stack of rows, not a table that has to be
    // dragged sideways. Measured before that was fixed: the ruled table was wider
    // than the column it sat in, and the class and the guardian — the two things
    // a bursar actually checks — fell off the right-hand edge of the screen. The
    // page-level check above cannot see that, because a table inside its own
    // scroll box leaves the page no wider than the phone, so the row's own box is
    // asserted here, and the ruled table is asserted not to be the presentation.
    const phoneRow = page.getByText(new RegExp(`Line 2 · ${ADMISSION_PREFIX}PH1`));
    await expect(phoneRow).toBeVisible();
    const rowBox = await phoneRow.boundingBox();
    if (!rowBox) throw new Error('the small-screen preview row did not render');
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(clientWidth + 1);
    await expect(page.getByRole('table').first()).toBeHidden();

    await page.getByRole('button', { name: /import 1 student/i }).click();
    await expect(page.getByText(/1 student imported/i)).toBeVisible({ timeout: 30_000 });

    // Confirm on the roll, on the same small screen. Measured: at 390px the table
    // is still in the DOM but hidden, and the CARD layout is what a person sees —
    // so an assertion against the table cell resolves to an invisible element and
    // would only pass by accident. The visible card is the honest target.
    await gotoSettled(page, '/students');
    await expect(
      page.getByRole('link', { name: new RegExp(`Ada Eze ${ADMISSION_PREFIX}PH1`) }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});
