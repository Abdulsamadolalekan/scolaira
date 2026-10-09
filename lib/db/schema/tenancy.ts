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

// ---------- Relations (Drizzle query helper — not enforced at SQL level) ----------
// NOTE: sessions table is defined in schema/auth.ts (M3 hardened); re-exported
// via the schema index for cross-table relations.

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
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
