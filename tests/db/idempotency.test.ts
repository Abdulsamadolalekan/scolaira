// @vitest-environment node
/**
 * Idempotency-key tests (§IX).
 *
 * Prove:
 *   - Same (org, user, key) acquire returns existing row on second call.
 *   - After complete(), a subsequent acquire returns the recorded row.
 *   - Duplicate reference for same org+method raises (legitimate second
 *     payment with different reference succeeds; duplicate reference fails).
 */
import { describe, it, expect } from 'vitest';
import { testDb, testSql } from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as idemRepo from '@/lib/db/repo/idempotency-keys';
import * as paymentsRepo from '@/lib/db/repo/payments';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';
import type { SeededIds } from '../support/seed';

function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function seedAndLogin(): Promise<{ ids: SeededIds; db: ReturnType<typeof testDb>; ctx: TenantCtx }> {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb(), ctx: ctxFor(ids.orgId, ids.aliceId) };
}

async function expectRejects<T>(p: Promise<T>, pattern: RegExp): Promise<void> {
  let threw = false;
  try { await p; } catch (e: any) {
    threw = true;
    const msg = (e?.message ?? '') + ' | ' + (e?.cause?.message ?? '');
    expect(msg).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

describe('Idempotency keys', () => {
  it('acquire returns null on first call, existing record on second', async () => {
    const { db, ctx } = await seedAndLogin();
    const key = 'idem-' + Date.now();
    const first = await idemRepo.acquire(db, ctx, { key, expiresAt: new Date(Date.now() + 60_000) });
    expect(first).toBeNull();
    const second = await idemRepo.acquire(db, ctx, { key, expiresAt: new Date(Date.now() + 60_000) });
    expect(second).not.toBeNull();
    expect(second!.key).toBe(key);
  });

  it('complete marks key recovered; subsequent acquire still returns it', async () => {
    const { db, ctx } = await seedAndLogin();
    const key = 'idem-c-' + Date.now();
    await idemRepo.acquire(db, ctx, { key, expiresAt: new Date(Date.now() + 60_000) });
    await idemRepo.complete(db, ctx, key, 201, { ok: true });
    const existing = await idemRepo.acquire(db, ctx, { key, expiresAt: new Date(Date.now() + 60_000) });
    expect(existing).not.toBeNull();
    expect(existing!.responseStatus).toBe(201);
  });

  it('duplicate payment reference for same org is rejected (partial unique index)', async () => {
    const { db, ctx } = await seedAndLogin();
    await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(5_000_000), reference: 'BANK-001' });
    await expectRejects(
      paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(5_000_000), reference: 'BANK-001' }),
      /(duplicate|reference|unique)/i,
    );
  });

  it('same reference on CASH is allowed (cash exempt from unique index)', async () => {
    const { db, ctx } = await seedAndLogin();
    const a = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(5_000_000), reference: 'CASH-DAY1' });
    const b = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(5_000_000), reference: 'CASH-DAY1' });
    expect(a.id).not.toBe(b.id);
  });

  it('different reference on same method succeeds', async () => {
    const { db, ctx } = await seedAndLogin();
    await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(5_000_000), reference: 'BANK-001' });
    const other = await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(5_000_000), reference: 'BANK-002' });
    expect(other.id).toBeTruthy();
  });
});
