/**
 * Organizations, users, memberships, sessions.
 *
 * NOTE: `users.id` is UUID now. In M3 we will point it at Supabase `auth.users.id`
 * (also UUID) via migration. No change of type required — only a foreign-key
 * addition.
 */
import { pgTable, text, varchar, char, timestamp, uniqueIndex, index, boolean, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, timestamps } from './_columns';
import {
  orgStatusEnum,
  membershipRoleEnum,
  membershipStatusEnum,
} from './enums';

// ---------- Organizations ----------

export const organizations = pgTable('organizations', {
  id: pk(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  logoUrl: text('logo_url'),
  address: text('address'),
  phone: varchar('phone', { length: 32 }),
  email: varchar('email', { length: 255 }),
  currency: char('currency', { length: 3 }).notNull().default('NGN'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Africa/Lagos'),
  plan: varchar('plan', { length: 32 }).notNull().default('pilot'),
  status: orgStatusEnum('status').notNull().default('ACTIVE'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('organizations_slug_idx').on(t.slug),
  index('organizations_status_idx').on(t.status),
]);

// ---------- Users ----------

export const users = pgTable('users', {
  id: pk(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  firstName: varchar('first_name', { length: 120 }),
  lastName: varchar('last_name', { length: 120 }),
  phone: varchar('phone', { length: 32 }),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  ...timestamps(),
}, (t) => [
  uniqueIndex('users_email_idx').on(t.email),
]);

// ---------- Organization Memberships ----------

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull(),
    status: membershipStatusEnum('status').notNull().default('ACTIVE'),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_members_org_user_idx').on(t.organizationId, t.userId),
    index('org_members_user_idx').on(t.userId),
    index('org_members_org_role_idx').on(t.organizationId, t.role),
  ],
);

// ---------- Sessions (auth) ----------
// Minimal cookie session record. Replaced/augmented by Supabase in M3; present
// so session_id FKs remain valid.

export const sessions = pgTable('sessions', {
  id: pk(),
    // token is the raw session id (opaque) — a separate hashed-token column is
    // added if/when we roll our own sessions pre-Supabase (deferred).
  token: varchar('token', { length: 128 }).notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  userAgent: text('user_agent'),
  ipAddress: varchar('ip_address', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (t) => [
  uniqueIndex('sessions_token_idx').on(t.token),
  index('sessions_user_idx').on(t.userId),
  index('sessions_expires_idx').on(t.expiresAt),
]);

// ---------- Relations (Drizzle query helper — not enforced at SQL level) ----------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  sessions: many(sessions),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
  sessions: many(sessions),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
}));
