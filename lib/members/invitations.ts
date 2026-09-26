/**
 * H-8 — membership invitations.
 *
 * WHAT THE TOKEN IS
 *
 * The invitation is the bearer credential: 32 random bytes, URL-safe, shown once
 * to the inviter and never stored. The database keeps only `sha256(token)`, so a
 * dump of `member_invitations` cannot be turned into a working link. A token is
 * bound to one organization and one email address, expires, and can be consumed
 * exactly once.
 *
 * WHY ACCEPTANCE RUNS IN SYSTEM SCOPE (and why that is the narrow reading)
 *
 * Acceptance is the one operation in this file that cannot run in tenant
 * context: the accepting user is not yet a member of the organization, and the
 * organization itself is only known *after* the token row is read. There is no
 * caller-supplied organization to trust, and no membership to resolve, so the
 * scope has to be the same one `register()` uses for first-run provisioning —
 * `withSystemScope()`, i.e. the database's bootstrap context.
 *
 * That context is powerful, so the reading is deliberately narrow and provable:
 *
 *   - the ONLY row addressed is the single row whose `token_hash` equals
 *     `sha256(presented token)`, taken `FOR UPDATE` so two concurrent attempts
 *     cannot both observe PENDING (the frozen reset-lifecycle idiom);
 *   - every write is constrained by `WHERE id = <that row's id>`;
 *   - acceptance requires status PENDING, `expires_at > now()`, and an email
 *     match against the *session's* email — never a request body;
 *   - the role written into `organization_members` is copied from the locked
 *     invitation row, which could not have been created with OWNER.
 *
 * The audit row for acceptance is written afterwards, in tenant context, because
 * the bootstrap branch of `audit_events_tenant_isolation` does not exist: a
 * system-scope insert into the audit trail would be (correctly) refused. It is
 * therefore best-effort by construction, and the membership change itself is the
 * durable evidence. `writeAudit` follows the same convention everywhere else.
 *
 * DELIVERY (decision D-1)
 *
 * No email is sent. `createInvitation` returns the plaintext link to the
 * authorised inviter, who delivers it by whatever channel they already use. The
 * inviter's own UI is the only place the link is ever rendered.
 */
import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { hashResetToken, generateUrlToken, normalizeEmail } from '@/lib/auth/cookies';
import { withSystemScope, withTenant } from '@/lib/db/tenant';
import type { Database } from '@/lib/db';
import type { TenantCtx, TenantScopedDb, UUID } from '@/lib/db/repo/_context';
import { memberInvitations } from '@/lib/db/schema/invitations';
import { organizationMembers, organizations } from '@/lib/db/schema/tenancy';
import { writeAudit } from '@/lib/authz/audit';

export type InvitableRole = 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF';

export const INVITABLE_ROLES: readonly InvitableRole[] = [
  'SCHOOL_ADMIN',
  'FINANCE_OFFICER',
  'STAFF',
] as const;

/** Invitations live for seven days; long enough to deliver, short enough to matter. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InvitationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'InvitationError';
  }
}

export interface CreatedInvitation {
  id: UUID;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
  /** Plaintext, returned exactly once. Never persisted, never re-derivable. */
  token: string;
  /** Relative accept path — the caller composes the absolute link for delivery. */
  acceptPath: string;
  /** A previous live invitation for the same address was revoked by this call. */
  replacedPending: boolean;
}

export interface InvitationRow {
  id: UUID;
  email: string;
  role: InvitableRole;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  invitedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /** True when the row is still usable right now. */
  live: boolean;
}

const ROLE_SET = new Set<string>(INVITABLE_ROLES);

function assertInvitableRole(role: string): asserts role is InvitableRole {
  if (!ROLE_SET.has(role)) {
    throw new InvitationError(
      'INVALID_ROLE',
      'An invitation can grant Administrator, Finance Officer or Staff — ownership moves through transfer, not invitation',
      400,
    );
  }
}

/**
 * Create (or replace) a pending invitation.
 *
 * At most one PENDING row may exist per (organization, email) — enforced by a
 * partial unique index, not by application bookkeeping. A re-invite therefore
 * has to revoke the previous row first; both statements run in one transaction
 * so the pair can never be half-applied.
 */
export async function createInvitation(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: { email: string; role: string; invitedBy: UUID },
  now: Date = new Date(),
): Promise<CreatedInvitation> {
  const role = input.role;
  assertInvitableRole(role);

  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) {
    throw new InvitationError('INVALID_EMAIL', 'A valid email address is required', 400);
  }

  const token = generateUrlToken(32);
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(memberInvitations)
      .set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(memberInvitations.organizationId, ctx.organizationId),
          eq(memberInvitations.email, email),
          eq(memberInvitations.status, 'PENDING'),
        ),
      )
      .returning({ id: memberInvitations.id });

    const inserted = await tx
      .insert(memberInvitations)
      .values({
        organizationId: ctx.organizationId,
        email,
        role,
        tokenHash,
        status: 'PENDING',
        invitedBy: input.invitedBy,
        invitedAt: now,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: memberInvitations.id });

    const id = inserted[0]?.id;
    if (!id) throw new InvitationError('INSERT_FAILED', 'Invitation could not be created', 500);

    return {
      id,
      email,
      role,
      expiresAt,
      token,
      acceptPath: `/invitations/${token}`,
      replacedPending: revoked.length > 0,
    };
  });
}

/** Pending and historical invitations for the active organization. */
export async function listInvitations(
  db: TenantScopedDb,
  ctx: TenantCtx,
  now: Date = new Date(),
): Promise<InvitationRow[]> {
  const rows = await db
    .select({
      id: memberInvitations.id,
      email: memberInvitations.email,
      role: memberInvitations.role,
      status: memberInvitations.status,
      invitedAt: memberInvitations.invitedAt,
      expiresAt: memberInvitations.expiresAt,
      acceptedAt: memberInvitations.acceptedAt,
      revokedAt: memberInvitations.revokedAt,
    })
    .from(memberInvitations)
    .where(eq(memberInvitations.organizationId, ctx.organizationId))
    .orderBy(memberInvitations.invitedAt);

  return rows.map((r) => ({
    ...r,
    role: r.role as InvitableRole,
    live: r.status === 'PENDING' && r.expiresAt.getTime() > now.getTime(),
  }));
}

/** Revoke a pending invitation. Returns false when there was nothing to revoke. */
export async function revokeInvitation(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(memberInvitations)
    .set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(memberInvitations.organizationId, ctx.organizationId),
        eq(memberInvitations.id, id),
        eq(memberInvitations.status, 'PENDING'),
      ),
    )
    .returning({ id: memberInvitations.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

export interface InvitationPreview {
  organizationId: UUID;
  organizationName: string;
  role: InvitableRole;
  email: string;
  expiresAt: Date;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  /** True when the token could be accepted right now (ignores who is asking). */
  usable: boolean;
}

function assertTokenShape(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new InvitationError('INVALID_TOKEN', 'This invitation link is not valid', 404);
  }
}

interface LockedInvitation {
  id: UUID;
  organizationId: UUID;
  email: string;
  role: InvitableRole;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expiresAt: Date;
}

async function lockByToken(db: Database, tokenHash: string): Promise<LockedInvitation | null> {
  const rows = (await db.execute(sql`
    select id, organization_id, email, role, status, expires_at
      from member_invitations
     where token_hash = ${tokenHash}
     for update
  `)) as unknown as Array<{
    id: UUID;
    organization_id: UUID;
    email: string;
    role: InvitableRole;
    status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
    expires_at: string | Date;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

/**
 * Describe an invitation from its token, without consuming it.
 *
 * Used by the accept page so the visitor can see what they are about to join.
 * Only the token holder can ask, and the response is limited to the organization
 * name, the role, the invited address and the state — never tenant data.
 */
export async function previewInvitation(
  token: string,
  now: Date = new Date(),
): Promise<InvitationPreview | null> {
  assertTokenShape(token);
  const tokenHash = hashResetToken(token);

  return withSystemScope(async (db) => {
    const locked = await lockByToken(db, tokenHash);
    if (!locked) return null;

    const orgRows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, locked.organizationId))
      .limit(1);

    return {
      organizationId: locked.organizationId,
      organizationName: orgRows[0]?.name ?? 'Organization',
      role: locked.role,
      email: locked.email,
      expiresAt: locked.expiresAt,
      status: locked.status,
      usable: locked.status === 'PENDING' && locked.expiresAt.getTime() > now.getTime(),
    };
  });
}

export interface AcceptedInvitation {
  organizationId: UUID;
  organizationName: string;
  role: InvitableRole;
  membershipId: UUID;
  /** True when the user was already an active member of that organization. */
  alreadyMember: boolean;
}

/**
 * Consume an invitation for the authenticated user.
 *
 * Single-use under concurrency: the row is locked `FOR UPDATE`, so a second
 * attempt for the same token blocks and then observes ACCEPTED and fails. The
 * status write and the membership insert share one transaction; if either fails,
 * the token stays usable rather than being burned for nothing.
 */
export async function acceptInvitation(
  token: string,
  actor: { userId: UUID; email: string },
  now: Date = new Date(),
): Promise<AcceptedInvitation> {
  assertTokenShape(token);
  const tokenHash = hashResetToken(token);
  const actorEmail = normalizeEmail(actor.email);

  const claimed = await withSystemScope(async (db) => {
    return db.transaction(async (tx) => {
      const locked = await lockByToken(tx as unknown as Database, tokenHash);
      if (!locked) {
        throw new InvitationError('INVALID_TOKEN', 'This invitation link is not valid', 404);
      }
      if (locked.status === 'REVOKED') {
        throw new InvitationError('REVOKED', 'This invitation has been revoked', 410);
      }
      if (locked.status === 'ACCEPTED') {
        throw new InvitationError('ALREADY_ACCEPTED', 'This invitation has already been used', 410);
      }
      if (locked.expiresAt.getTime() <= now.getTime()) {
        throw new InvitationError('EXPIRED', 'This invitation has expired', 410);
      }
      if (locked.email !== actorEmail) {
        throw new InvitationError(
          'EMAIL_MISMATCH',
          `This invitation was issued to ${locked.email}. Sign in as that user to accept it.`,
          403,
        );
      }

      const orgRows = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, locked.organizationId))
        .limit(1);
      const organizationName = orgRows[0]?.name ?? 'Organization';

      const existing = await tx
        .select({ id: organizationMembers.id, status: organizationMembers.status })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, locked.organizationId),
            eq(organizationMembers.userId, actor.userId),
          ),
        )
        .limit(1);

      let membershipId: UUID;
      let alreadyMember = false;

      if (existing[0]) {
        // Already a member: the token is still burned, but the role in place is
        // left alone — an invitation never silently re-grades an existing seat.
        membershipId = existing[0].id;
        alreadyMember = existing[0].status === 'ACTIVE';
      } else {
        const inserted = await tx
          .insert(organizationMembers)
          .values({
            organizationId: locked.organizationId,
            userId: actor.userId,
            role: locked.role,
            status: 'ACTIVE',
            joinedAt: now,
          })
          .returning({ id: organizationMembers.id });
        const id = inserted[0]?.id;
        if (!id) throw new InvitationError('INSERT_FAILED', 'Membership could not be created', 500);
        membershipId = id;
      }

      await tx
        .update(memberInvitations)
        .set({ status: 'ACCEPTED', acceptedAt: now, acceptedBy: actor.userId, updatedAt: now })
        .where(eq(memberInvitations.id, locked.id));

      return {
        organizationId: locked.organizationId,
        organizationName,
        role: locked.role,
        membershipId,
        alreadyMember,
      };
    });
  });

  // Evidence, best-effort and in tenant context (see the file docblock). The
  // membership row itself is the durable record; this makes the change legible
  // in the organization's audit trail.
  try {
    await withTenant(
      { organizationId: claimed.organizationId, userId: actor.userId },
      async (db, ctx) => {
        await writeAudit(db, {
          organizationId: claimed.organizationId,
          actorUserId: actor.userId,
          action: 'member.invitation_accepted',
          entityType: 'organization_member',
          entityId: claimed.membershipId,
          after: { role: claimed.role, alreadyMember: claimed.alreadyMember },
        });
        void ctx;
      },
    );
  } catch (e) {
    console.error('invitation acceptance audit failed', e);
  }

  return claimed;
}
