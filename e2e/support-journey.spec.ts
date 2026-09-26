/**
 * H-8 — the platform support journey, end to end.
 *
 * A platform administrator signs in, opens the console, enters read-only support
 * mode for an organization they do not belong to, looks at it, and leaves. The
 * audit trail records both the entry and the exit; a forged support cookie
 * records nothing and shows nothing; and no write lands in the supported
 * organization at any point.
 *
 * The identity used here is the seeded platform administrator, which the H-6
 * seed already provides (`platform@e2e.demo.school`, `is_platform_admin = true`,
 * ACTIVE in Demo School only). The H-6 seed is NOT edited: the membership-less
 * platform identity D-3 asked for is created by `e2e/support/platform-fixture.ts`
 * for the tests that need it, and removed afterwards.
 */
import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { loadSeed } from './support/seed';
import {
  auditRowsFor,
  closeFixtureConnection,
  createMembershiplessPlatformAdmin,
  describeMembershipless,
  discoverSupportTarget,
  dropMembershiplessPlatformAdmin,
  invitationCountFor,
  type SupportTarget,
} from './support/platform-fixture';

const PLATFORM_STATE = resolve(process.cwd(), 'e2e/.artifacts/state-platform.json');
const OWNER_STATE = resolve(process.cwd(), 'e2e/.artifacts/state-owner.json');

test.use({ storageState: PLATFORM_STATE });

let target: SupportTarget;

test.beforeAll(async () => {
  const seed = loadSeed();
  target = await discoverSupportTarget(seed.platformAdmin.email);
});

test.afterAll(async () => {
  await closeFixtureConnection();
});

/** The CSRF double-submit header, read from the browser's own cookie jar. */
async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'sc_csrf');
  return csrf ? { 'x-csrf-token': decodeURIComponent(csrf.value) } : {};
}

test.describe('H-8 platform support journey', () => {
  test('enters support mode for another organization, read-only and audited', async ({ page }) => {
    // The audit trail is append-only and this throwaway database is reused
    // between runs, so the assertion is about the DELTA this visit creates.
    const entersBefore = (
      await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.enter')
    ).length;
    const exitsBefore = (
      await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.exit')
    ).length;

    await page.goto('/platform');

    await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();
    // Both organizations are visible: this page is served from database-minted
    // platform context, so seeing the second one IS the platform identity proof.
    await expect(page.getByText('Demo School').first()).toBeVisible();
    await expect(page.getByText(target.name).first()).toBeVisible();

    const row = page.locator('li', { hasText: target.name }).first();
    await row.getByRole('button', { name: /support view/i }).click();

    await page.waitForURL(new RegExp(`/platform/orgs/${target.organizationId}$`), {
      timeout: 60_000,
    });
    await expect(page.getByText(/Support mode — read-only/i)).toBeVisible();
    await expect(page.getByText(/Read-only\./)).toBeVisible();
    await expect(page.getByText('Members')).toBeVisible();

    // Evidence: the entry is in the supported organization's own audit trail.
    await expect
      .poll(
        async () =>
          (await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.enter'))
            .length,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(entersBefore);

    const enters = await auditRowsFor(
      target.organizationId,
      target.memberUserId,
      'platform.support.enter',
    );
    expect((enters[enters.length - 1]!.metadata as Record<string, unknown>).mode).toBe('READ_ONLY');

    // The read plane works while the window is open...
    const list = await page.request.get('/api/platform/orgs');
    expect(list.status()).toBe(200);

    // ...and the platform plane exposes no mutation to attempt.
    const noMutation = await page.request.post(`/api/platform/orgs/${target.organizationId}`, {
      data: {},
      headers: await csrfHeader(page),
    });
    expect([403, 404, 405]).toContain(noMutation.status());

    await page.getByRole('button', { name: /exit support mode/i }).click();
    await expect
      .poll(
        async () =>
          (await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.exit'))
            .length,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(exitsBefore);
  });

  test('every mutation attempt fails and the supported organization is untouched', async ({
    page,
  }) => {
    const targetBefore = await invitationCountFor(target.organizationId, target.memberUserId);

    await page.goto('/platform');
    const row = page.locator('li', { hasText: target.name }).first();
    await row.getByRole('button', { name: /support view/i }).click();
    await page.waitForURL(new RegExp(`/platform/orgs/${target.organizationId}$`), {
      timeout: 60_000,
    });

    // 1. A tenant mutation through the ordinary route. The seeded platform
    //    administrator holds STAFF in the seeded organization, so the write is
    //    refused by the role gate — the point here is that support mode grants
    //    it nothing extra: the attempt fails and no tenant boundary moves.
    const invite = await page.request.post('/api/members/invitations', {
      data: { email: `h8-journey-${Date.now()}@example.com`, role: 'STAFF' },
      headers: await csrfHeader(page),
    });
    expect(invite.status()).toBe(403);

    // 2. A platform mutation. The support plane exposes no mutation at all.
    const suspend = await page.request.post(`/api/platform/orgs/${target.organizationId}/suspend`, {
      data: {},
      headers: await csrfHeader(page),
    });
    expect([403, 404, 405]).toContain(suspend.status());

    // 3. Nothing landed in the supported organization.
    const targetAfter = await invitationCountFor(target.organizationId, target.memberUserId);
    expect(targetAfter).toBe(targetBefore);
  });

  test('a forged support cookie shows nothing and records nothing', async ({ page, context }) => {
    // Baseline: earlier tests in this file legitimately entered support mode, and
    // the audit trail is append-only by design — so the assertion is "this
    // attempt added no evidence", not "the trail is empty".
    const before = (
      await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.enter')
    ).length;

    // A syntactically perfect claim that this user never received: the
    // signature is not theirs to make.
    const forged = `${target.organizationId}.forged-nonce-value.${Math.floor(Date.now() / 1000) + 600}.AAAA`;
    await context.addCookies([
      {
        name: 'sc_support',
        value: forged,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(`/platform/orgs/${target.organizationId}`);

    // The page refuses to render the support view: it falls back to the
    // un-opened state ("Detailed figures require a support window").
    await expect(page.getByText(/require a support window/i)).toBeVisible();
    await expect(page.getByText(/Support mode — read-only/i)).toHaveCount(0);

    // And the forged claim created no new evidence.
    await expect
      .poll(
        async () =>
          (await auditRowsFor(target.organizationId, target.memberUserId, 'platform.support.enter'))
            .length,
        {
          timeout: 15_000,
        },
      )
      .toBe(before);
  });

  test('the D-3 fixture is a real platform administrator with no memberships (created outside the seed)', async () => {
    const ghost = await createMembershiplessPlatformAdmin();
    try {
      const state = await describeMembershipless(ghost.userId);
      expect(state).toEqual({ isPlatformAdmin: true, memberships: 0 });
      // The consequence — such an identity can never hold a session, because
      // `getSession()` requires an ACTIVE membership, and that boundary is M4 and
      // untouched — is pinned where it can be measured precisely:
      // tests/auth/h8-platform-boundary.test.ts.
    } finally {
      await dropMembershiplessPlatformAdmin(ghost.userId);
    }
  });

  test('a non-platform administrator never sees the console', async ({ browser }) => {
    const context = await browser.newContext({ storageState: OWNER_STATE });
    const page = await context.newPage();
    try {
      const res = await page.goto('/platform');
      // notFound(): the console does not advertise itself to ordinary users.
      expect(res?.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
