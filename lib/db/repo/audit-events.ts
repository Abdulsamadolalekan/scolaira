/**
 * Audit events repository (append-only).
 *
 * Per architecture report §3 N1: DB-level audit triggers are not wired yet.
 * Until they are, the service layer writes audit events explicitly through this
 * repo. The table is append-only via trigger + REVOKE UPDATE/DELETE.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import { auditEvents } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
import { SURFACE_LIMITS, assertCursorKeys, decodeCursor, encodeCursor, sortKeyUs } from './pagination';
import type { auditActorTypeEnum } from '../schema/enums';

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditActorType = (typeof auditActorTypeEnum.enumValues)[number];

export interface RecordAuditInput {
  actorType?: AuditActorType;
  action: string;
  entityType: string;
  entityId?: UUID;
  before?: unknown;
  after?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  correlationId?: string;
  ipAddress?: string;
}

export async function record(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: RecordAuditInput,
): Promise<AuditEvent> {
  const rows = await db
    .insert(auditEvents)
    .values({
      organizationId: ctx.organizationId,
      actorType: input.actorType ?? (ctx.userId ? 'USER' : 'SYSTEM'),
      actorUserId: ctx.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: (input.before ?? null) as any,
      after: (input.after ?? null) as any,
      reason: input.reason ?? null,
      metadata: (input.metadata ?? null) as any,
      requestId: input.requestId ?? null,
      correlationId: input.correlationId ?? null,
      ipAddress: input.ipAddress ?? null,
      // `now()` is transaction-scoped in PostgreSQL, so two audit rows in one
      // mutation can share an identical timestamp. Use the database clock for
      // deterministic newest-first history; this remains server-maintained.
      createdAt: sql`clock_timestamp()`,
    })
    .returning();
  return rows[0]!;
}

/**
 * H-2/M-6 — the same history, with a declared window.
 *
 * Entity history is embedded in detail payloads (case threads, payment detail),
 * so it is a list surface like any other: it reports how many rows exist and
 * whether the client is looking at a truncated view. `total` is a cheap count on
 * the same (org, entity) filter the rows use.
 */
export async function listForEntityPage(
  db: TenantScopedDb,
  ctx: TenantCtx,
  entityType: string,
  entityId: UUID,
  window: { limit: number; cursor?: string | null } = { limit: 50 },
): Promise<{ rows: AuditEvent[]; total: number; hasMore: boolean; nextCursor: string | null }> {
  const limit = Math.min(Math.max(window.limit, 1), 100);
  const after = window.cursor ? decodeCursor(SURFACE_LIMITS.audit.surface, window.cursor) : null;
  const predicates = [
    eq(auditEvents.organizationId, ctx.organizationId),
    eq(auditEvents.entityType, entityType),
    eq(auditEvents.entityId, entityId),
  ] as any[];
  const sortUs = sortKeyUs(auditEvents.createdAt);
  assertCursorKeys(after, ['bigint', 'uuid']);
  if (after) {
    predicates.push(
      sql`(${sortUs} < ${after[0]}::bigint
        OR (${sortUs} = ${after[0]}::bigint AND ${auditEvents.id} < ${after[1]}::uuid))`,
    );
  }
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(and(...predicates.slice(0, 3)));
  const rows = await db
    .select({ event: auditEvents, sortUs: sql<string>`${sortUs}` })
    .from(auditEvents)
    .where(and(...predicates))
    .orderBy(sql`${sortUs} desc, ${auditEvents.id} desc`)
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = (page[page.length - 1] as any) ?? null;
  return {
    rows: page.map((r: any) => r.event as AuditEvent),
    total: Number(countRows[0]?.n ?? 0),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(SURFACE_LIMITS.audit.surface, [String(last.sortUs), String(last.event.id)])
        : null,
  };
}

export async function listForEntity(
  db: TenantScopedDb,
  ctx: TenantCtx,
  entityType: string,
  entityId: UUID,
  limit = 50,
): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, ctx.organizationId),
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit);
}
