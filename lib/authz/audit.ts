/**
 * Audit helper for M4 authorization/business events.
 *
 * Schema matches M2 audit_events: actor, action, entity, before/after,
 * metadata, requestId. We never log passwords, session tokens, reset tokens,
 * cookies, or secrets.
 *
 * Audit failures are swallowed after logging to console — they must NOT break
 * the audited operation.
 */
import 'server-only';

import { auditEvents } from '@/lib/db/schema';
import type { TenantCtx, TenantScopedDb, UUID } from '@/lib/db/repo/_context';
import { asUUID } from '@/lib/db/repo/_context';

export interface AuditEvent {
  organizationId?: UUID | null;
  actorUserId?: UUID | null;
  action: string;          // e.g. 'member.role_changed'
  entityType: string;      // e.g. 'organization_member'
  entityId?: UUID | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(
  db: TenantScopedDb,
  ev: AuditEvent,
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      organizationId: ev.organizationId ?? null,
      actorType: 'USER',
      actorUserId: ev.actorUserId ?? null,
      action: ev.action,
      entityType: ev.entityType,
      entityId: ev.entityId ?? null,
      before: ev.before ?? null,
      after: ev.after ?? null,
      reason: ev.reason ?? null,
      metadata: {
        ...(ev.metadata ?? {}),
        ...(ev.ipAddress || ev.userAgent ? { ip: ev.ipAddress, ua: ev.userAgent } : {}),
      },
      requestId: ev.requestId ?? null,
      createdAt: new Date(),
    } as unknown as typeof auditEvents.$inferInsert);
  } catch (e) {
    console.error('audit write failed', e);
  }
}

/** Audit convenience wrappers for common events. */
export async function auditMembershipChange(
  db: TenantScopedDb,
  ctx: TenantCtx,
  opts: {
    action: 'member.invited' | 'member.suspended' | 'member.reactivated' | 'member.revoked' | 'member.role_changed';
    targetMemberId: UUID;
    targetUserId: UUID;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    requestId?: string;
  },
): Promise<void> {
  return writeAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: opts.action,
    entityType: 'organization_member',
    entityId: asUUID(opts.targetMemberId),
    before: opts.before ?? null,
    after: opts.after ?? { targetUserId: opts.targetUserId },
    metadata: { targetUserId: opts.targetUserId },
    requestId: opts.requestId,
  });
}

export async function auditOwnershipTransfer(
  db: TenantScopedDb,
  ctx: TenantCtx,
  opts: {
    previousOwnerMemberId: UUID;
    previousOwnerUserId: UUID;
    newOwnerMemberId: UUID;
    newOwnerUserId: UUID;
    requestId?: string;
  },
): Promise<void> {
  return writeAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'org.owner.transferred',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: { ownerUserId: opts.previousOwnerUserId, ownerMemberId: opts.previousOwnerMemberId },
    after: { ownerUserId: opts.newOwnerUserId, ownerMemberId: opts.newOwnerMemberId },
    requestId: opts.requestId,
  });
}
