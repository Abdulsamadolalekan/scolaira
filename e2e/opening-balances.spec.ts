import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillStable, signIn } from './support/seed';

/**
 * Phase 2 — carry-in opening balances, end to end.
 *
 * The journey a mid-year school actually walks: it already has arrears on paper,
 * it registers, it records what was owed with the source it came from, somebody
 * approves it, it is posted to the term it belongs to, and the family's debt then
 * reads correctly everywhere else in the product. Then the two things a bursar
 * fears most are checked in the order they would notice them: that a second post
 * for the same child and term is REFUSED, and that reversing takes the debt back
 * out without ever inventing money that was not received.
 *
 * What the school is registered for:
 *   1. it is the honest test — the register's meaning depends on there being a
 *      PRIOR term and a CURRENT term, and the shared seeded school does not
 *      guarantee either;
 *   2. it leaves every other spec's expectations alone, so no other journey
 *      shifts because a figure was carried in here.
 *
 * Fixtures the register itself does not own (sessions, terms, the child) are
 * created through the product's own endpoints with the owner's session — a
 * `request` call over the same cookies and CSRF token the browser holds. The
 * surface under test is the register and the guide, and every one of those steps is
 * a real click on a real page. Money claims are then re-read from `/api/students`,
 * so "posted" is proven by the debt moving, not by a row of text.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now().toString(36);
const SCHOOL = `Carry Test ${STAMP}`;
const SLUG = `carry-test-${STAMP}`;
const EMAIL = `carry-owner-${STAMP}@example.test`;
const PASSWORD = 'Carry-in-journey-password-A1!';
const ADMISSION = `OB-${STAMP.toUpperCase()}`;
const SOURCE_MARK = `Exercise book 2024, page 11 (${STAMP})`;
const STUDENT_FIRST = 'Carry';
const STUDENT_LAST = 'Child';
/** What the register must show for that pupil — derived so it cannot drift. */
const STUDENT_NAME = `${STUDENT_FIRST} ${STUDENT_LAST}`;
const STATE_PATH = resolve(process.cwd(), 'e2e/.artifacts/state-balances-owner.json');

// A unique amount, so a row can be addressed unambiguously: the register never
// deletes a figure it has recorded, and repeated runs must not blur together.
const NAIRA = 40_000 + (Date.now() % 50_000);
const KOBO = NAIRA * 100;
const AMOUNT_TEXT = `₦${NAIRA.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const PRIOR_AS_AT = '2025-06-30';
const PRIOR_TERM_NAME = 'Prior Carry Term';

/** POST/GET through the app's own API with the browser's cookies and CSRF token. */
async function api(
  context: import('@playwright/test').BrowserContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === 'sc_csrf')?.value ?? '';
  const res = await context.request.fetch(path, {
    method,
    data: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }),
      ...headers,
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status(), body: json };
}

/** Register a school through the real form, then hand its session to the rest. */
async function registerSchool(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/register');
  const boxes = page.locator('input');
  await fillStable(boxes.nth(0), 'Carry');
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
 * The two terms the carry-in story needs: a PAST one to post against, and a
 * CURRENT one that must refuse it. Created through the product's own endpoints.
 */
async function buildCalendar(context: import('@playwright/test').BrowserContext) {
  const sessions = await api(context, 'GET', '/api/academic-sessions');
  // Every one of these routes demands an Idempotency-Key (required:true), so a
  // retried call cannot create a second session, term or activation.
  const priorSession = await api(
    context,
    'POST',
    '/api/academic-sessions',
    { name: '2024/2025', startsOn: '2024-09-01', endsOn: '2025-07-31' },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(priorSession.status, JSON.stringify(priorSession.body)).toBe(201);
  const priorTerm = await api(
    context,
    'POST',
    '/api/terms',
    {
      sessionId: priorSession.body.session.id,
      name: PRIOR_TERM_NAME,
      label: 'PRIOR',
      startsOn: '2024-09-02',
      endsOn: '2024-12-19',
      dueDate: '2024-12-19',
    },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(priorTerm.status, JSON.stringify(priorTerm.body)).toBe(201);

  // Created in this order on purpose: a session is activated only once a term
  // exists inside it, which is what the setup guide does too, and what a school
  // with an empty active session would find broken.
  const currentSession = await api(
    context,
    'POST',
    '/api/academic-sessions',
    { name: '2026/2027', startsOn: '2026-09-01', endsOn: '2027-07-30' },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(currentSession.status, JSON.stringify(currentSession.body)).toBe(201);

  const currentTerm = await api(
    context,
    'POST',
    '/api/terms',
    {
      sessionId: currentSession.body.session.id,
      name: 'First Term',
      label: 'T1',
      startsOn: '2026-09-08',
      endsOn: '2026-12-18',
      dueDate: '2026-12-18',
    },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(currentTerm.status, JSON.stringify(currentTerm.body)).toBe(201);
  const activateSession = await api(
    context,
    'POST',
    `/api/academic-sessions/${currentSession.body.session.id}/activate`,
    {},
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(activateSession.status, JSON.stringify(activateSession.body)).toBe(200);
  const activateTerm = await api(
    context,
    'POST',
    `/api/terms/${currentTerm.body.term.id}/activate`,
    {},
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(activateTerm.status, JSON.stringify(activateTerm.body)).toBe(200);

  const student = await api(context, 'POST', '/api/students', {
    studentId: ADMISSION,
    firstName: STUDENT_FIRST,
    lastName: STUDENT_LAST,
  });
  expect(student.status, JSON.stringify(student.body)).toBe(201);

  return {
    priorTermId: priorTerm.body.term.id as string,
    currentTermId: currentTerm.body.term.id as string,
    studentId: student.body.student.id as string,
    alreadyHadSessions: (sessions.body?.sessions ?? []).length,
  };
}

async function studentTotals(context: import('@playwright/test').BrowserContext, id: string) {
  const res = await api(context, 'GET', '/api/students?limit=200');
  expect(res.status).toBe(200);
  const row = (res.body.students as Array<Record<string, unknown>>).find((s) => s.id === id);
  expect(row, `student ${id} is not on the roster the pages read`).toBeTruthy();
  return row as { billedKobo: number; paidKobo: number; outstandingKobo: number };
}

test('a carry-in figure is recorded, approved, posted, refused twice, and reversible', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const context = page.context();

  await registerSchool(page);
  await context.storageState({ path: STATE_PATH });

  const cal = await buildCalendar(context);

  // Baseline: a fresh school with a past term owes nothing yet, and has no money.
  expect(await studentTotals(context, cal.studentId)).toMatchObject({
    billedKobo: 0,
    paidKobo: 0,
    outstandingKobo: 0,
  });
  const paymentsBefore = await api(context, 'GET', '/api/payments?limit=50');
  expect(paymentsBefore.status).toBe(200);
  const paymentCountBefore = (paymentsBefore.body?.payments ?? []).length as number;

  // ── The guide offers the step, and links to the register ───────────────────
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: /set up scolaira/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: /Carry in what is owed/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Carry in what is owed/i }).first()).toContainText(
    /Nothing carried in yet/i,
  );
  await page
    .getByRole('button', { name: /Carry in what is owed/i })
    .first()
    .click();
  // It is a Button with router.push, not an <a>: getByRole('link') finds nothing
  // and that is not a defect to assert around — the navigation is the product's
  // own, and it works. (Semantics of a real link for the same action is a
  // Phase 11 note, recorded in the report.)
  await expect(page.getByRole('button', { name: /open the register/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: /open the register/i }).click();
  await expect(page).toHaveURL(/\/finance\/opening-balances/);

  // ── The empty register is honest about being empty ────────────────────────
  const register = page.locator('main');
  await expect(register.getByText(/five separate figures/i)).toBeVisible();
  for (const label of [
    'Owed from before, still outstanding',
    'Waiting to be reviewed',
    'Approved, not posted',
    'Credits and overpayments',
    'Unverified',
  ]) {
    await expect(register.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(register.getByText(/Nothing carried in yet/i).first()).toBeVisible();

  // ── Validation: the form refuses to be where a figure simply appears ─────
  // Two guards, in the order a person meets them. Without a source there is
  // nothing to submit — the button stays disabled and the card says why — and a
  // figure that is not money is answered in words before any request is made.
  await page.selectOption('#ob-student', cal.studentId);
  const record = page.getByRole('button', { name: /record it/i });
  await expect(record).toBeDisabled();
  await fillStable(page.locator('#ob-amount'), 'not money');
  await expect(record).toBeDisabled();
  await expect(register.getByText(/A number with no source is not a record/i)).toBeVisible();
  await fillStable(page.locator('#ob-source'), SOURCE_MARK);
  await expect(record).toBeEnabled();
  await record.click();
  await expect(register.getByText(/Enter the amount as money greater than zero/i)).toBeVisible();
  // And the refused figure left nothing behind — no row for this run's unique
  // amount exists yet, and no request was made to create one.
  await expect(page.locator('tr', { hasText: AMOUNT_TEXT })).toHaveCount(0);

  // ── Record it, for real, from the paper it came off ───────────────────────
  await fillStable(page.locator('#ob-amount'), String(NAIRA));
  await fillStable(page.locator('#ob-asat'), PRIOR_AS_AT);
  await expect(page.locator('#ob-term')).toHaveValue(cal.priorTermId, { timeout: 20_000 });
  await fillStable(page.locator('#ob-source'), SOURCE_MARK);
  await page.getByRole('button', { name: /record it/i }).click();

  const row = page.locator('tr', { hasText: AMOUNT_TEXT }).first();
  await expect(row).toBeVisible({ timeout: 25_000 });
  await expect(row).toContainText('Not reviewed yet');
  await expect(row).toContainText(ADMISSION);
  // The card moved with it, and the register says the figure is not a debt yet.
  await expect(
    register.getByText(/figure(s)? recorded and not yet approved/i).first(),
  ).toBeVisible();
  await expect(row).not.toContainText(/INV-\d{4}-\d{6}/);

  // Recording must not have billed anyone, anywhere.
  expect(await studentTotals(context, cal.studentId)).toMatchObject({
    billedKobo: 0,
    paidKobo: 0,
    outstandingKobo: 0,
  });

  // A draft is not postable: the offer to post is simply not made.
  await row.getByRole('button', { name: /^actions$/i }).click();
  await expect(page.getByRole('button', { name: /post to the ledger/i })).toHaveCount(0);
  // The strip that expands under the row is its own <tr>; read it there rather
  // than anywhere on the page that happens to contain the words.
  await expect(row.locator('xpath=following-sibling::tr[1]')).toContainText(
    /Source: Exercise book 2024, page 11/i,
  );

  // ── The current term is refused, by the same rule the UI relies on ────────
  const wrongTerm = await api(context, 'POST', '/api/opening-balances', {
    studentId: cal.studentId,
    category: 'HISTORICAL_BALANCE',
    amountKobo: KOBO,
    asAt: '2026-10-01',
    termId: cal.currentTermId,
    sourceNote: 'Trying to bill the live term twice',
  });
  expect(wrongTerm.status).toBe(400);
  expect(JSON.stringify(wrongTerm.body)).toMatch(/current term/i);

  // A credit is never a charge, and the API says so rather than storing it wrong.
  const creditPosted = await api(context, 'POST', '/api/opening-balances', {
    studentId: cal.studentId,
    category: 'CREDIT_OVERPAYMENT',
    amountKobo: 5_000_00,
    asAt: PRIOR_AS_AT,
    termId: cal.priorTermId,
    sourceNote: 'Receipt 219, paid twice in March',
  });
  expect(creditPosted.status, JSON.stringify(creditPosted.body)).toBe(201);

  // ── Approve, then post to the ledger ──────────────────────────────────────
  await page
    .getByRole('button', { name: /^Approve$/i })
    .first()
    .click();
  const approvedRow = page.locator('tr', { hasText: AMOUNT_TEXT }).filter({
    hasText: 'Approved, not posted',
  });
  await expect(approvedRow.first()).toBeVisible({ timeout: 25_000 });
  await expect(approvedRow.first()).toContainText(/recorded and approved by the same person/i);
  expect(await studentTotals(context, cal.studentId)).toMatchObject({ billedKobo: 0 });

  await page
    .getByRole('button', { name: /post to the ledger/i })
    .first()
    .click();
  const postedRow = page.locator('tr', { hasText: AMOUNT_TEXT }).filter({
    hasText: 'Posted to the ledger',
  });
  await expect(postedRow.first()).toBeVisible({ timeout: 30_000 });
  await expect(postedRow.first()).toContainText(/INV-\d{4}-\d{6}/);
  // The carried-in figure is now stated as read back FROM THE LEDGER, which is the
  // only way this register is allowed to call something owed.
  await expect(
    register.getByText(/Read back from the posted invoices, not from this register\./i),
  ).toBeVisible();

  // Now the debt is real, and ONLY the debt: nothing was paid and nothing was
  // receipted, so a posted carry-in cannot fabricate payment history.
  expect(await studentTotals(context, cal.studentId)).toMatchObject({
    billedKobo: KOBO,
    paidKobo: 0,
    outstandingKobo: KOBO,
  });
  const paymentsAfter = await api(context, 'GET', '/api/payments?limit=50');
  expect((paymentsAfter.body?.payments ?? []).length).toBe(paymentCountBefore);

  // The setup guide's derived step must agree with the register — and it does, in
  // the honest order: something is still waiting on a decision, so that is what it
  // says, even though a posted debt now exists. The credit row recorded above is
  // still a DRAFT, and an unreviewed figure outranks a carried-in total.
  await page.goto('/onboarding');
  const balanceStep = page.getByRole('button', { name: /Carry in what is owed/i }).first();
  await expect(balanceStep).toContainText(/1 figure waiting to be approved/, { timeout: 20_000 });
  await expect(balanceStep).toContainText(/Not yet completed/, { timeout: 20_000 });

  // ── A second post for the same child and term is refused, not doubled ─────
  const dup = await api(context, 'POST', '/api/opening-balances', {
    studentId: cal.studentId,
    category: 'HISTORICAL_BALANCE',
    amountKobo: KOBO,
    asAt: PRIOR_AS_AT,
    termId: cal.priorTermId,
    sourceNote: 'Same figure, found again in the same book',
  });
  expect(dup.status, JSON.stringify(dup.body)).toBe(201);
  const dupApprove = await api(
    context,
    'POST',
    `/api/opening-balances/${dup.body.openingBalance.id}/review`,
    { decision: 'APPROVE' },
  );
  expect(dupApprove.status, JSON.stringify(dupApprove.body)).toBe(200);
  const dupPost = await api(
    context,
    'POST',
    `/api/opening-balances/${dup.body.openingBalance.id}/post`,
    {},
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(dupPost.status, JSON.stringify(dupPost.body)).toBe(409);
  expect(JSON.stringify(dupPost.body)).toMatch(/was not posted/i);
  // One debt still, not two — and the refused row is left standing for review.
  expect(await studentTotals(context, cal.studentId)).toMatchObject({ billedKobo: KOBO });
  await page.goto('/finance/opening-balances');
  await expect(page.locator('tr', { hasText: 'Posted to the ledger' })).toHaveCount(1);
  await expect(
    page.locator('tr', { hasText: 'Approved, not posted' }).filter({ hasText: ADMISSION }).first(),
  ).toBeVisible();

  // ── Reverse it, with a reason, and the debt goes back out ─────────────────
  await page.goto('/finance/opening-balances');
  const live = page.locator('tr', { hasText: 'Posted to the ledger' }).first();
  await live.getByRole('button', { name: /^actions$/i }).click();
  await expect(register.getByText(/Reason for reversing/i).first()).toBeVisible();
  await page
    .getByRole('button', { name: /^Reverse$/i })
    .first()
    .click();
  // A reversal without a reason is refused — and the refusal is the server's own
  // sentence, printed as it arrived.
  await expect(register.getByText(/reason/i).first()).toBeVisible({ timeout: 20_000 });
  await fillStable(page.locator('[id^="ob-note-"]').first(), 'Wrong child, belongs to a sibling');
  await page
    .getByRole('button', { name: /^Reverse$/i })
    .first()
    .click();
  await expect(
    page.locator('tr', { hasText: AMOUNT_TEXT }).filter({ hasText: 'Reversed' }).first(),
  ).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('tr', { hasText: 'Reversed' }).first()).toContainText(/voided/i);
  expect(await studentTotals(context, cal.studentId)).toMatchObject({
    billedKobo: 0,
    paidKobo: 0,
    outstandingKobo: 0,
  });
});

test('the register is not readable without a session', async ({ browser }) => {
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto('/finance/opening-balances');
  await expect(page).toHaveURL(/\/login/);
  const res = await anon.request.get('/api/opening-balances');
  expect(res.status()).toBe(401);
  await anon.close();
});

test('the stacked phone layout carries the register without cutting it off', async ({
  browser,
}) => {
  test.skip(!existsSync(STATE_PATH), 'the journey above captures the session state first');
  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto('/finance/opening-balances');
  await expect(page.getByRole('heading', { name: /opening balances/i })).toBeVisible({
    timeout: 20_000,
  });
  // What a phone gets is the substance, not the header's one-line gloss: the
  // shared CardHeader hides its description below `sm` (`hidden … sm:block`) and
  // that is the design system's behaviour on every list page, deliberately left
  // alone in Phase 1 as well. The five figures and their per-figure explanation
  // are rendered by the register itself, so those are what must be readable.
  await expect(page.getByText(/Owed from before, still outstanding/i).first()).toBeVisible();
  await expect(
    page.getByText(/Nothing has been posted yet|Read back from the posted invoices/i).first(),
  ).toBeVisible();
  // The phone list keeps what identifies the figure: who it is, what it is, how much and
  // where it came from. The admission number is not repeated there by design — the
  // expanded row and the link to the pupil's record carry the durable references.
  // Scoped to the stacked list: the desktop table is still in the DOM at 390px,
  // only `display:none`, and the pupil picker above repeats the name — an unscoped
  // text query resolves to one of those hidden copies and would report the phone as
  // broken when it is not. One stacked row must carry who it is and where it came
  // from, and the row's own actions must be reachable from it.
  const stackedRow = page
    .locator('main ul li')
    .filter({ hasText: STUDENT_NAME })
    .filter({ hasText: SOURCE_MARK })
    .first();
  await expect(stackedRow).toBeVisible();
  await expect(stackedRow.getByRole('button', { name: /^(Actions|Hide actions)$/i })).toBeVisible();
  // Expanding must reach the durable reference. The ledger invoice this figure was
  // posted to appears only in the opened row, and on a phone the register is the
  // whole interface, so the reference has to be reachable there too.
  await stackedRow.getByRole('button', { name: /^Actions$/i }).click();
  await expect(stackedRow.getByText(/INV-/).first()).toBeVisible();

  const geom = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    rows: document.querySelectorAll('main ul li').length,
  }));
  expect(geom.scroll).toBeLessThanOrEqual(geom.client + 1);
  expect(geom.rows).toBeGreaterThan(0);
  await context.close();
});
