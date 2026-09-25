/**
 * Idempotency keys repository.
 *
 * Used by API handlers (Idempotency-Key header) and webhook intake to guarantee
 * that retries do not produce duplicate financial effects. The unique index on
 * (organization_id, user_id, key) is the hard guard at the DB level.
 *
 * NOTE per architecture report §3 N2: scope is not part of the unique index in
 * M2 (service layer should use distinct key prefixes for API vs WEBHOOK scope
 * until the index is expanded).
 */
import { eq, and } from 'drizzle-orm';
import { idempotencyKeys } from '../schema';
import type { TenantCtx, TenantScopedDb } from './_context';

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export interface IdempotencyRecord {
  key: string;
  scope?: string;
  requestMethod?: string;
  requestPath?: string;
  requestHash?: string;
  expiresAt: Date;
}

function userPredicate(userId: string | null) {
  // The user_id column is nullable (webhook keys may have no user), so when
  // userId is null we match IS NULL explicitly via `isNull()`. For simplicity,
  // we match a non-null userId with eq().
  if (userId === null) {
    return and(eq(idempotencyKeys.userId, null as unknown as string));
  }
  return eq(idempotencyKeys.userId, userId);
}

export async function acquire(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: IdempotencyRecord,
): Promise<IdempotencyKey | null> {
  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, ctx.organizationId),
        userPredicate(ctx.userId),
        eq(idempotencyKeys.key, input.key),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  try {
    await db.insert(idempotencyKeys).values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      key: input.key,
      scope: input.scope ?? 'API',
      requestMethod: input.requestMethod ?? null,
      requestPath: input.requestPath ?? null,
      requestHash: input.requestHash ?? null,
      lockedAt: new Date(),
      expiresAt: input.expiresAt,
      responseBody: null,
      responseStatus: null,
    });
    return null;
  } catch (e: any) {
    if (e?.code === '23505') {
      const row = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.organizationId, ctx.organizationId),
            userPredicate(ctx.userId),
            eq(idempotencyKeys.key, input.key),
          ),
        )
        .limit(1);
      return row[0] ?? null;
    }
    throw e;
  }
}

export async function complete(
  db: TenantScopedDb,
  ctx: TenantCtx,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      responseStatus,
      responseBody: responseBody as any,
      lockedAt: null,
      recoveredAt: new Date(),
    })
    .where(
      and(
        eq(idempotencyKeys.organizationId, ctx.organizationId),
        userPredicate(ctx.userId),
        eq(idempotencyKeys.key, key),
      ),
    );
}
