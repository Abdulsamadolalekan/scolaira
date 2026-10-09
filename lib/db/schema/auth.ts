/**
 * Auth schema (M3 + M4 authorization primitives).
 *
 * M4 additions:
 *   - sessions.lastSeenOrgId: tracks the most recent active organization for
 *     the session (audit + "return to where you were" UX).
 *   - sessions.isPlatformSession: true when the session was created via an
 *     explicit platform-admin "enter support mode" entry point. Such sessions
 *     are restricted per the M4 policy (read-only, audited) and cannot
 *     mutate financial state.
 */
import { pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, index, uniqueIndex, char, bigserial } from 'drizzle-orm/pg-core';
import { users, organizations } from './tenancy';

export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  algorithm: varchar('algorithm', { length: 16 }).notNull().default('argon2id'),
  params: jsonb('params').notNull().default({}),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: char('token_hash', { length: 64 }).notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // NOTE: original sessions table had user_agent / ip_address pre-M2.
  userAgent: text('user_agent'),
  ipAddress: varchar('ip_address', { length: 64 }),
  // csrf_token added in M3.
  csrfToken: char('csrf_token', { length: 43 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: varchar('revoked_reason', { length: 32 }),
  // M4 additions
  lastSeenOrgId: uuid('last_seen_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  isPlatformSession: boolean('is_platform_session').notNull().default(false),
}, (t) => [
  uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
  index('sessions_user_id_idx').on(t.userId),
  index('sessions_user_active_idx').on(t.userId),
  index('sessions_revoked_idx').on(t.revokedAt),
  index('sessions_platform_session_idx').on(t.userId, t.isPlatformSession),
]);

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: char('token_hash', { length: 64 }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  requestIp: varchar('request_ip', { length: 64 }),
  requestUserAgent: text('request_user_agent'),
}, (t) => [
  uniqueIndex('pw_resets_token_hash_key').on(t.tokenHash),
  index('pw_resets_user_idx').on(t.userId, t.requestedAt),
]);

export const rateLimits = pgTable('rate_limits', {
  key: varchar('key', { length: 128 }).primaryKey(),
  counter: integer('counter').notNull().default(1),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const loginAttempts = pgTable('login_attempts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  email: varchar('email', { length: 255 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  success: boolean('success').notNull().default(false),
});
