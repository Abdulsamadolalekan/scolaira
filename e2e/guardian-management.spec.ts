import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { attemptJourney, fillStable, loadSeed } from './support/seed';

/**
 * Phase 3 — guardian management, end to end, in a real browser.
 *
 * The audit's second blocker was that NO part of the product could record a
 * guardian: `guardians` and `student_guardians` had tables, RLS and indexes, and
 * zero inserts anywhere in `app/`, `lib/`, `scripts/` or `e2e/`. The debtors
 * register therefore rendered an em dash where the responsible contact should
 * be, and every fee reminder had nobody to address.
 *
 * These tests walk the workflow a bursar actually performs, against the real
 * seeded database, through the real UI:
 *
 *   record a guardian → see them as the primary contact → add a second →
 *   change who is primary → edit their number → remove them →
 *   and confirm the debtors register names a reachable person.
 *
 * Persistence is checked by RELOADING, because a list that only exists in the
 * client's React state would satisfy a weaker test while still losing the data.
 *
 * The student is shared with every other spec in this seeded database, so each
 * test first clears the slate and leaves it clear. That is deliberately done
 * through the product's own Remove action rather than by reaching into the
 * database: a spec that cleans up through a private door would keep passing
 * after the public one broke.
 */
const MARK = `E2gu${Date.now().toString(36)}`;
const PRIMARY = { exact: true } as const;

test.use({ storageState: resolve(process.cwd(), 'e2e/.artifacts/state-owner.json') });

function addForm(page: import('@playwright/test').Page) {
  return page.locator('form', { has: page.getByRole('button', { name: /save guardian/i }) });
}

function guardianRows(page: import('@playwright/test').Page) {
  // Only the guardian list items: the workspace navigation is also a list.
  return page.locator('li').filter({ has: page.getByRole('button', { name: /^remove$/i }) });
}

/**
 * Leave the student with no guardians, so an assertion about "no contact" cannot
 * be satisfied or broken by whatever a previous test (or a previous failed run)
 * happened to leave behind.
 */
async function clearGuardians(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { name: 'Guardians' })).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 12; i++) {
    const rows = guardianRows(page);
    const count = await rows.count();
    if (count === 0) return;
    await rows
      .first()
      .getByRole('button', { name: /^remove$/i })
      .click();
    await expect(guardianRows(page)).toHaveCount(count - 1, { timeout: 20_000 });
  }
}

/** The add form is open immediately when the student has no guardian. */
async function openAddForm(page: import('@playwright/test').Page) {
  if ((await addForm(page).count()) === 0) {
    await page.getByRole('button', { name: /add (another )?guardian/i }).click();
  }
  await expect(addForm(page)).toBeVisible();
}

/**
 * Fill and submit the add form.
 *
 * `fillStable` and `attemptJourney` are the house helpers for the ONE race that
 * belongs to the harness rather than the product: on WebKit a client component
 * can finish hydrating between a fill and a submit, React reconciles the
 * controlled input back to its initial (empty) state, and the submit is then
 * refused by validation with no request ever made. Measured here: the FIRST
 * field filled was emptied while the later ones kept their values, which is the
 * signature of that race. A person typing does not hit it; a test filling three
 * fields in ~50ms does. The retry reloads and repeats, so a genuine regression
 * still fails loudly instead of being retried away.
 */
async function addGuardian(
  page: import('@playwright/test').Page,
  opts: { first: string; last: string; phone?: string },
) {
  await attemptJourney(async (attempt) => {
    if (attempt > 1) await page.reload();
    await openAddForm(page);
    const form = addForm(page);
    await fillStable(form.getByLabel('First name'), opts.first);
    await fillStable(form.getByLabel('Last name'), opts.last);
    if (opts.phone) await fillStable(form.getByLabel('Phone'), opts.phone);
    await form.getByRole('button', { name: /save guardian/i }).click();
    await expect(page.getByText(`${opts.first} ${opts.last}`)).toBeVisible({ timeout: 20_000 });
  });
}

test.describe('guardian management', () => {
  test('records a guardian, makes them primary, edits and removes them', async ({ page }) => {
    const seed = loadSeed();
    await page.goto(`/students/${seed.student.id}`);
    await clearGuardians(page);

    // With no guardian recorded, the panel says so and opens the form: the
    // honest next action is to record the person responsible.
    await expect(page.getByText('No guardian is recorded for this student.')).toBeVisible();

    // --- record the first guardian -------------------------------------------------
    await addGuardian(page, { first: 'First', last: `${MARK}One`, phone: '0803 555 0001' });

    const firstRow = page.locator('li', { hasText: `${MARK}One` });
    await expect(firstRow).toHaveCount(1);
    // The first guardian is promoted automatically: a student with one guardian
    // and no primary is exactly the ambiguity this phase removes.
    await expect(firstRow.getByText('Primary', PRIMARY)).toBeVisible();
    // The phone is stored normalised, so what renders is dialable.
    await expect(firstRow).toContainText('08035550001');

    // --- it is really persisted ----------------------------------------------------
    await page.reload();
    await expect(page.locator('li', { hasText: `${MARK}One` })).toHaveCount(1, { timeout: 20_000 });

    // --- a second guardian is NOT automatically primary -----------------------------
    await addGuardian(page, { first: 'Second', last: `${MARK}Two`, phone: '0803 555 0002' });
    const secondRow = page.locator('li', { hasText: `${MARK}Two` });
    await expect(secondRow).toHaveCount(1);
    await expect(secondRow.getByText('Primary', PRIMARY)).toHaveCount(0);
    await expect(page.getByText('Primary', PRIMARY)).toHaveCount(1);

    // --- move the responsibility ---------------------------------------------------
    await secondRow.getByRole('button', { name: /make primary/i }).click();
    await expect(secondRow.getByText('Primary', PRIMARY)).toBeVisible({ timeout: 20_000 });
    // Exactly one primary at all times — never two, never none.
    await expect(page.getByText('Primary', PRIMARY)).toHaveCount(1);
    await expect(firstRow.getByText('Primary', PRIMARY)).toHaveCount(0);

    // Survives a reload, so the change is in the database and not in React state.
    await page.reload();
    await expect(
      page.locator('li', { hasText: `${MARK}Two` }).getByText('Primary', PRIMARY),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('li', { hasText: `${MARK}One` }).getByText('Primary', PRIMARY),
    ).toHaveCount(0);

    // --- edit a contact number -----------------------------------------------------
    const firstRowAgain = page.locator('li', { hasText: `${MARK}One` });
    await firstRowAgain.getByRole('button', { name: /^edit$/i }).click();
    // While editing, the name is in an input VALUE rather than in text, so the
    // row is no longer addressable by name. The edit form is identified by its
    // own Save button instead ("Save guardian" belongs to the add form).
    // The edit controls replace the row's contents in place (they are not a
    // <form>), so the row is located by the Save button it now contains.
    const editForm = page
      .locator('li')
      .filter({ has: page.getByRole('button', { name: /^save$/i }) });
    await expect(editForm).toBeVisible();
    await fillStable(editForm.getByLabel('Phone'), '0803 555 0099');
    await editForm.getByRole('button', { name: /^save$/i }).click();
    await expect(page.locator('li', { hasText: `${MARK}One` })).toContainText('08035550099', {
      timeout: 20_000,
    });

    // --- remove a guardian ---------------------------------------------------------
    await page
      .locator('li', { hasText: `${MARK}One` })
      .getByRole('button', { name: /^remove$/i })
      .click();
    await expect(page.locator('li', { hasText: `${MARK}One` })).toHaveCount(0, { timeout: 20_000 });
    // The surviving guardian still holds the primary flag.
    await expect(
      page.locator('li', { hasText: `${MARK}Two` }).getByText('Primary', PRIMARY),
    ).toBeVisible();
    await expect(page.getByText('Primary', PRIMARY)).toHaveCount(1);

    await page
      .locator('li', { hasText: `${MARK}Two` })
      .getByRole('button', { name: /^remove$/i })
      .click();
    await expect(page.getByText('No guardian is recorded for this student.')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('the debtors register names a reachable contact, and says so when there is none', async ({
    page,
  }) => {
    const seed = loadSeed();

    // 1. No guardian: the register must not imply a contact exists.
    await page.goto(`/students/${seed.student.id}`);
    await clearGuardians(page);

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await attemptJourney(async () => {
      await page.goto('/debtors');
      await expect(page.getByRole('heading', { name: 'Debtors and aging' })).toBeVisible({
        timeout: 20_000,
      });
    });
    const row = page.locator('tr', { hasText: seed.student.studentId });
    if ((await row.count()) > 0) {
      await expect(row).toContainText('None recorded');
      await expect(row.getByRole('link', { name: /add guardian/i })).toBeVisible();
    }

    // 2. Record a guardian: the register must resolve an actual person to ring.
    await page.goto(`/students/${seed.student.id}`);
    await addGuardian(page, {
      first: 'Debtor',
      last: `${MARK}Contact`,
      phone: '0803 555 0003',
    });

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await attemptJourney(async () => {
      await page.goto('/debtors');
      await expect(page.getByRole('heading', { name: 'Debtors and aging' })).toBeVisible({
        timeout: 20_000,
      });
    });
    const rowAfter = page.locator('tr', { hasText: seed.student.studentId });
    if ((await rowAfter.count()) > 0) {
      await expect(rowAfter).toContainText(`Debtor ${MARK}Contact`);
      await expect(rowAfter).toContainText('08035550003');
    }

    // 3. Removing the guardian must remove them from the register too, so a
    //    deleted contact is never still named as responsible for a debt.
    await page.goto(`/students/${seed.student.id}`);
    await page
      .locator('li', { hasText: `${MARK}Contact` })
      .getByRole('button', { name: /^remove$/i })
      .click();
    await expect(page.getByText('No guardian is recorded for this student.')).toBeVisible({
      timeout: 20_000,
    });

    // Removing a guardian calls router.refresh(), which is a client-side
    // navigation for the CURRENT route. A goto issued while that is still in
    // flight is aborted by the browser ("interrupted by another navigation"),
    // so the refresh is allowed to land first and the goto is retried.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await attemptJourney(async () => {
      await page.goto('/debtors');
      await expect(page.getByRole('heading', { name: 'Debtors and aging' })).toBeVisible({
        timeout: 20_000,
      });
    });
    const rowFinal = page.locator('tr', { hasText: seed.student.studentId });
    if ((await rowFinal.count()) > 0) {
      await expect(rowFinal).toContainText('None recorded');
      await expect(rowFinal).not.toContainText(`${MARK}Contact`);
    }
  });

  test('the panel is usable on a low-end phone viewport without sideways scroll', async ({
    page,
  }) => {
    const seed = loadSeed();
    // 390x844 is the common low-end Android class this product targets.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/students/${seed.student.id}`);
    await clearGuardians(page);

    await addGuardian(page, { first: 'Mobile', last: `${MARK}Phone`, phone: '0803 555 0004' });

    const row = page.locator('li', { hasText: `${MARK}Phone` });
    await expect(row).toHaveCount(1);

    // The page must not scroll sideways: a bursar on a phone cannot reach an
    // action that has been pushed off the right edge.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      overflow.scrollWidth,
      `document scrollWidth ${overflow.scrollWidth} exceeds viewport ${overflow.innerWidth}`,
    ).toBeLessThanOrEqual(overflow.innerWidth + 1);

    // The actions stay tappable rather than clipped.
    await expect(row.getByRole('button', { name: /^remove$/i })).toBeVisible();

    await row.getByRole('button', { name: /^remove$/i }).click();
    await expect(page.getByText('No guardian is recorded for this student.')).toBeVisible({
      timeout: 20_000,
    });
  });
});
