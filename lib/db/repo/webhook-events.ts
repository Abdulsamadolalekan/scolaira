/**
 * Webhook events repository.
 *
 * Persists provider webhook deliveries with a unique (provider, event_id) index
 * so that provider retries do not create duplicate financial effects. The
 * processing worker updates status / attempts / processed_at as it processes.
 */
import { eq, and, desc } from 'drizzle-orm';
import { webhookEvents } from '../schema';
import type { TenantScopedDb, UUID } from './_context';
import type { webhookStatusEnum } from '../schema/enums';

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type WebhookStatus = (typeof webhookStatusEnum.enumValues)[number];

export interface IngestInput {
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  signature?: string;
  /** Resolved organization id (set after validation; nullable at ingest). */
  organizationId?: UUID | null;
}

/**
 * Ingest a webhook event. If the same (provider, event_id) already exists
 * (provider retry), returns the existing row WITHOUT inserting a new one.
 * Returns { event, isDuplicate } so the caller can skip processing for retries.
 */
export async function ingest(
  db: TenantScopedDb,
  input: IngestInput,
): Promise<{ event: WebhookEvent; isDuplicate: boolean }> {
  // Check first to avoid unnecessary inserts on high-volume retries.
  const existing = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, input.provider),
        eq(webhookEvents.eventId, input.eventId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return { event: existing[0], isDuplicate: true };
  }
  try {
    const rows = await db
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload as any,
        signature: input.signature ?? null,
        organizationId: input.organizationId ?? null,
        status: 'RECEIVED',
      })
      .returning();
    return { event: rows[0]!, isDuplicate: false };
  } catch (e: any) {
    if (e?.code === '23505') {
      // Concurrent duplicate insert.
      const rows = await db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.provider, input.provider),
            eq(webhookEvents.eventId, input.eventId),
          ),
        )
        .limit(1);
      return { event: rows[0]!, isDuplicate: true };
    }
    throw e;
  }
}

export async function markProcessing(
  db: TenantScopedDb,
  id: UUID,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(eq(webhookEvents.id, id));
}

export async function markProcessed(
  db: TenantScopedDb,
  id: UUID,
  organizationId?: UUID,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      status: 'PROCESSED',
      processedAt: new Date(),
      lastError: null,
      ...(organizationId ? { organizationId } : {}),
    })
    .where(eq(webhookEvents.id, id));
}

export async function markFailed(
  db: TenantScopedDb,
  id: UUID,
  error: string,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      status: 'FAILED',
      lastError: error.slice(0, 4096),
      lastAttemptAt: new Date(),
    })
    .where(eq(webhookEvents.id, id));
}

export async function listPending(
  db: TenantScopedDb,
  limit = 50,
): Promise<WebhookEvent[]> {
  return db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.status, 'RECEIVED'))
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(limit);
}

// NOTE: sql tagged-template import needed for the increment.
import { sql } from 'drizzle-orm';
