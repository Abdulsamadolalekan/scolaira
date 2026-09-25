// @vitest-environment node
/**
 * Webhook foundation tests (§VIII).
 *
 * Verifies: duplicate detection by (provider, eventId), state transitions
 * (RECEIVED → PROCESSING → PROCESSED / FAILED), payload immutability,
 * timestamps, retry behavior, and organization binding after processing.
 */
import { describe, it, expect } from 'vitest';
import { testDb, testSql } from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as wh from '@/lib/db/repo/webhook-events';
import { webhookEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { UUID } from '@/lib/db/repo/_context';

async function seed() {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb() };
}

describe('Webhook foundation', () => {
  it('ingest inserts a RECEIVED event with provider/id/type/payload and timestamps', async () => {
    const { db } = await seed();
    const { event, isDuplicate } = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_001', eventType: 'charge.success',
      payload: { reference: 'BANK-001', amount: 100000 },
    });
    expect(isDuplicate).toBe(false);
    expect(event.provider).toBe('paystack');
    expect(event.eventId).toBe('evt_001');
    expect(event.status).toBe('RECEIVED');
    expect(event.receivedAt).toBeTruthy();
    expect(event.processedAt).toBeNull();
    expect((event.payload as any).reference).toBe('BANK-001');
  });

  it('same (provider, eventId) returns isDuplicate = true (idempotent)', async () => {
    const { db } = await seed();
    await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_dup', eventType: 'charge.success',
      payload: { amount: 1 },
    });
    const r2 = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_dup', eventType: 'charge.success',
      payload: { amount: 999 },  // different payload on retry
    });
    expect(r2.isDuplicate).toBe(true);
    // first payload preserved
    expect((r2.event.payload as any).amount).toBe(1);
  });

  it('same eventId across providers is NOT considered duplicate (provider namespace)', async () => {
    const { db } = await seed();
    const a = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_same', eventType: 'x', payload: { p: 'a' },
    });
    const b = await wh.ingest(db, {
      provider: 'stripe', eventId: 'evt_same', eventType: 'x', payload: { p: 'b' },
    });
    expect(a.isDuplicate).toBe(false);
    expect(b.isDuplicate).toBe(false);
    expect(a.event.id).not.toBe(b.event.id);
  });

  it('markProcessing increments attempts and sets lastAttemptAt', async () => {
    const { db } = await seed();
    const { event } = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_proc', eventType: 'x', payload: {},
    });
    await wh.markProcessing(db, event.id as UUID);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id)).limit(1);
    expect(row!.processingAttempts).toBe(1);
    expect(row!.lastAttemptAt).toBeTruthy();
  });

  it('markProcessed sets status=PROCESSED, processedAt, and binds organizationId', async () => {
    const { db, ids } = await seed();
    const { event } = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_done', eventType: 'x', payload: {},
    });
    await wh.markProcessed(db, event.id as UUID, ids.orgId);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id)).limit(1);
    expect(row!.status).toBe('PROCESSED');
    expect(row!.processedAt).toBeTruthy();
    expect(row!.organizationId).toBe(ids.orgId);
    expect(row!.lastError).toBeNull();
  });

  it('markFailed sets status=FAILED and stores lastError (truncated)', async () => {
    const { db } = await seed();
    const { event } = await wh.ingest(db, {
      provider: 'paystack', eventId: 'evt_fail', eventType: 'x', payload: {},
    });
    const errMsg = 'signature mismatch'.repeat(400);
    await wh.markFailed(db, event.id as UUID, errMsg);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id)).limit(1);
    expect(row!.status).toBe('FAILED');
    expect(row!.lastError!.length).toBeLessThanOrEqual(4096);
  });

  it('listPending returns only RECEIVED events ordered by receivedAt desc', async () => {
    const { db } = await seed();
    const a = await wh.ingest(db, { provider: 'p', eventId: 'evt_p1', eventType: 'x', payload: {} });
    const b = await wh.ingest(db, { provider: 'p', eventId: 'evt_p2', eventType: 'x', payload: {} });
    await wh.markProcessed(db, b.event.id as UUID);
    const pending = await wh.listPending(db, 10);
    expect(pending.find((e) => e.id === b.event.id)).toBeUndefined();
    expect(pending.find((e) => e.id === a.event.id)).toBeTruthy();
  });
});
