/**
 * Audit events repository (append-only).
 *
 * Per architecture report §3 N1: DB-level audit triggers are not wired yet.
 * Until they are, the service layer writes audit events explicitly through this
 * repo. The table is append-only via trigger + REVOKE UPDATE/DELETE.
 */
import { eq, and, desc } from 'drizzle-orm';
import { auditEvents } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
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
    })
    .returning();
  return rows[0]!;
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
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
