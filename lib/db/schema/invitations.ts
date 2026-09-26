/**
 * Membership invitations (H-8).
 *
 * A row records the intent to add an email to an organization, plus the sha256 of
 * a single-use, expiring URL token. The plaintext token is never stored: it is
 * returned once, to the authorised inviter, and the invitation is accepted by an
 * authenticated user whose email matches.
 *
 * Uniqueness: at most one PENDING invitation per (organization, email). The partial
 * unique index is what makes "re-invite" replace the previous token instead of
 * leaving two usable ones outstanding.
 */
import { pgTable, uuid, varchar, char, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './tenancy';
import { invitationStatusEnum, membershipRoleEnum } from './enums';

export const memberInvitations = pgTable(
  'member_invitations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: membershipRoleEnum('role').notNull(),
    /** sha256 hex of the URL token — the plaintext is never persisted. */
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    status: invitationStatusEnum('status').notNull().default('PENDING'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_invitations_token_hash_idx').on(t.tokenHash),
    uniqueIndex('member_invitations_pending_unique_idx')
      .on(t.organizationId, t.email)
      .where(sql`status = 'PENDING'`),
    index('member_invitations_org_status_idx').on(t.organizationId, t.status, t.invitedAt),
  ],
);

export type MemberInvitation = typeof memberInvitations.$inferSelect;
export type NewMemberInvitation = typeof memberInvitations.$inferInsert;
