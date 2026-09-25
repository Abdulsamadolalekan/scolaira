/**
 * Membership service (M4).
 *
 * Handles invite/list/suspend/reactivate/revoke/role_change and OWNER transfer.
 * Every method is called from a route handler that has already authenticated,
 * authorized, and set tenant context via withTenant().
 *
 * Therefore we can assume org scoping from RLS + ctx. We still do explicit
 * defense-in-depth checks on organization matches and the one-owner
 * invariant at the application level. The partial unique index in the DB
 * (org_members_one_active_owner_idx) is the final backstop.
 */
import 'server-only';

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { organizationMembers, users } from '@/lib/db/schema';
import { AuthzError, AuthzErrorCode } from './errors';
import type { TenantCtx, TenantScopedDb, UUID } from '@/lib/db/repo/_context';
import { asUUID } from '@/lib/db/repo/_context';
import { auditMembershipChange, auditOwnershipTransfer } from './audit';
import type { MembershipRole } from './permissions';

const ASSIGNABLE_ROLES: MembershipRole[] = ['SCHOOL_ADMIN', 'FINANCE_OFFICER', 'STAFF'];

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

async function mustFindMember(db: TenantScopedDb, ctx: TenantCtx, memberId: UUID) {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.id, memberId),
        eq(organizationMembers.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  const m = rows[0];
  if (!m) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Member not found', 404);
  return m;
}

async function mustFindActiveOwner(db: TenantScopedDb, ctx: TenantCtx) {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.role, 'OWNER'),
        eq(organizationMembers.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  const m = rows[0];
  if (!m) {
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'Organization has no active owner (data invariant violation)',
      500,
    );
  }
  return m;
}

// --------------------------------------------------------------------------
// Operations
// --------------------------------------------------------------------------

/**
 * Invite: create an INVITED membership for an existing user (by email).
 *
 * Note: full invite flow (provisioning stub users, sending invite emails) is
 * M5; M4 only supports inviting already-registered users so that the
 * authorization layer has real behavior to prove itself against.
 */
export async function inviteMember(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: { email: string; role: MembershipRole },
) {
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, `Cannot invite with role ${input.role}`, 400);
  }
  const email = input.email.trim().toLowerCase();
  const userRows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'No user with that email exists', 404);
  }

  const existing = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.userId, user.id),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new AuthzError(AuthzErrorCode.CONFLICT, 'User is already a member', 409);
  }

  const now = new Date();
  const id = crypto.randomUUID() as UUID;
  await db.insert(organizationMembers).values({
    id,
    organizationId: ctx.organizationId,
    userId: user.id,
    role: input.role,
    status: 'INVITED',
    invitedAt: now,
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof organizationMembers.$inferInsert);

  await auditMembershipChange(db, ctx, {
    action: 'member.invited',
    targetMemberId: id,
    targetUserId: user.id as UUID,
    after: { role: input.role, status: 'INVITED' },
  });

  return { id, userId: user.id, email: user.email, role: input.role, status: 'INVITED' as const };
}

/** List members of this org (with user display info). */
export async function listMembers(db: TenantScopedDb, ctx: TenantCtx) {
  return db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      joinedAt: organizationMembers.joinedAt,
      invitedAt: organizationMembers.invitedAt,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, ctx.organizationId));
}

/** Suspend (DISABLED) a member. Cannot suspend OWNER. Cannot suspend self. */
export async function suspendMember(db: TenantScopedDb, ctx: TenantCtx, memberId: UUID) {
  const m = await mustFindMember(db, ctx, asUUID(memberId));
  if (m.role === 'OWNER' && m.status === 'ACTIVE') {
    throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Cannot suspend the organization owner', 403);
  }
  if (m.status === 'DISABLED') return { id: m.id, status: 'DISABLED' as const };
  if (m.userId === ctx.userId) {
    throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Cannot suspend yourself', 403);
  }
  const previousStatus = m.status;
  await db
    .update(organizationMembers)
    .set({ status: 'DISABLED', updatedAt: new Date() })
    .where(eq(organizationMembers.id, m.id));
  await auditMembershipChange(db, ctx, {
    action: 'member.suspended',
    targetMemberId: m.id as UUID,
    targetUserId: m.userId as UUID,
    before: { status: previousStatus },
    after: { status: 'DISABLED' },
  });
  return { id: m.id, status: 'DISABLED' as const };
}

/** Reactivate a DISABLED member. */
export async function reactivateMember(db: TenantScopedDb, ctx: TenantCtx, memberId: UUID) {
  const m = await mustFindMember(db, ctx, asUUID(memberId));
  if (m.status === 'ACTIVE') return { id: m.id, status: 'ACTIVE' as const };
  if (m.role === 'OWNER') {
    // OWNER rows shouldn't be DISABLED; defensively refuse.
    throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Cannot reactivate OWNER via this endpoint', 403);
  }
  const previousStatus = m.status;
  await db
    .update(organizationMembers)
    .set({ status: 'ACTIVE', updatedAt: new Date() })
    .where(eq(organizationMembers.id, m.id));
  await auditMembershipChange(db, ctx, {
    action: 'member.reactivated',
    targetMemberId: m.id as UUID,
    targetUserId: m.userId as UUID,
    before: { status: previousStatus },
    after: { status: 'ACTIVE' },
  });
  return { id: m.id, status: 'ACTIVE' as const };
}

/** Revoke (delete) a membership. OWNER cannot be revoked (must transfer first). */
export async function revokeMember(db: TenantScopedDb, ctx: TenantCtx, memberId: UUID) {
  const m = await mustFindMember(db, ctx, asUUID(memberId));
  if (m.role === 'OWNER' && m.status === 'ACTIVE') {
    throw new AuthzError(
      AuthzErrorCode.FORBIDDEN,
      'Cannot revoke the organization owner; transfer ownership first',
      403,
    );
  }
  if (m.userId === ctx.userId) {
    throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Cannot revoke yourself', 403);
  }
  await db.delete(organizationMembers).where(eq(organizationMembers.id, m.id));
  await auditMembershipChange(db, ctx, {
    action: 'member.revoked',
    targetMemberId: m.id as UUID,
    targetUserId: m.userId as UUID,
    before: { role: m.role, status: m.status },
  });
  return { ok: true };
}

/** Change a member's role. Cannot change OWNER (use transfer ownership). */
export async function changeMemberRole(
  db: TenantScopedDb,
  ctx: TenantCtx,
  memberId: UUID,
  newRole: MembershipRole,
) {
  if (!ASSIGNABLE_ROLES.includes(newRole)) {
    throw new AuthzError(
      AuthzErrorCode.BAD_REQUEST,
      `Cannot assign role ${newRole} via role change (OWNER is only set via transfer)`,
      400,
    );
  }
  const m = await mustFindMember(db, ctx, asUUID(memberId));
  if (m.role === 'OWNER') {
    throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Cannot change role of OWNER (transfer ownership instead)', 403);
  }
  if (m.role === newRole) return { id: m.id, role: newRole };
  const previousRole = m.role;
  await db
    .update(organizationMembers)
    .set({ role: newRole, updatedAt: new Date() })
    .where(eq(organizationMembers.id, m.id));
  await auditMembershipChange(db, ctx, {
    action: 'member.role_changed',
    targetMemberId: m.id as UUID,
    targetUserId: m.userId as UUID,
    before: { role: previousRole },
    after: { role: newRole },
  });
  return { id: m.id, role: newRole };
}

// --------------------------------------------------------------------------
// Ownership transfer (atomic)
// --------------------------------------------------------------------------

/**
 * Transfer OWNER from the current owner to an ACTIVE member. Runs inside a
 * transaction; updates both memberships; verifies exactly-one-owner
 * invariant; audits.
 */
export async function transferOwnership(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: { targetMemberId: UUID },
) {
  const targetId = asUUID(input.targetMemberId);

  return db.transaction(async (tx) => {
    const currentOwner = await mustFindActiveOwner(tx, ctx);
    if (currentOwner.userId !== ctx.userId) {
      throw new AuthzError(AuthzErrorCode.FORBIDDEN, 'Only the current owner may transfer ownership', 403);
    }
    const target = await mustFindMember(tx, ctx, targetId);
    if (target.status !== 'ACTIVE') {
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Target must be an active member', 400);
    }
    if (target.id === currentOwner.id) {
      throw new AuthzError(AuthzErrorCode.CONFLICT, 'Target is already the owner', 409);
    }

    // Demote current owner first, then promote target. Because the unique
    // partial index is on (organization_id) WHERE role='OWNER' AND status='ACTIVE',
    // and Postgres checks unique constraints per statement, either order is
    // safe (one statement always leaves zero or one owner). We demote then
    // promote so that at no point do two ACTIVE OWNERs exist.
    const now = new Date();
    await tx
      .update(organizationMembers)
      .set({ role: 'SCHOOL_ADMIN', updatedAt: now })
      .where(eq(organizationMembers.id, currentOwner.id));
    await tx
      .update(organizationMembers)
      .set({ role: 'OWNER', updatedAt: now })
      .where(eq(organizationMembers.id, target.id));

    // Verify invariant (defense-in-depth; unique index is final backstop).
    const postOwners = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.role, 'OWNER'),
          eq(organizationMembers.status, 'ACTIVE'),
        ),
      );
    if (postOwners.length !== 1) {
      throw new AuthzError(
        AuthzErrorCode.CONFLICT,
        `Ownership transfer invariant violated (${postOwners.length} active owners); rolling back`,
        500,
      );
    }

    await auditOwnershipTransfer(tx, ctx, {
      previousOwnerMemberId: currentOwner.id as UUID,
      previousOwnerUserId: currentOwner.userId as UUID,
      newOwnerMemberId: target.id as UUID,
      newOwnerUserId: target.userId as UUID,
    });

    return {
      previousOwnerMemberId: currentOwner.id,
      newOwnerMemberId: target.id,
      newOwnerUserId: target.userId,
    };
  });
}
