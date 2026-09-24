/**
 * Platform/reliability tables: payment_links, communications, audit_events,
 * idempotency_keys, webhook_events.
 */
import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  integer,
  bigint,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, timestamps } from './_columns';
import { organizations, users } from './tenancy';
import { invoices } from './financials';
import { students } from './academic';
import {
  paymentLinkStatusEnum,
  communicationChannelEnum,
  communicationStatusEnum,
  auditActorTypeEnum,
  webhookStatusEnum,
} from './enums';

// ---------- Payment Links ----------

export const paymentLinks = pgTable('payment_links', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 64 }).notNull(), // random URL token
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
  studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
  amountKobo: bigint('amount_kobo', { mode: 'number' }), // null = "pay whatever is outstanding"
  status: paymentLinkStatusEnum('status').notNull().default('ACTIVE'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  revokedBy: uuid('revoked_by').references(() => users.id),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  // H-5: rotation provenance. `token_fingerprint` is DERIVED by a trigger (the
  // same HMAC construction the submission audit trail uses, so the two
  // correlate); it is never supplied by application code, and it makes the
  // bearer token correlatable without being storable.
  tokenFingerprint: varchar('token_fingerprint', { length: 16 }).notNull(),
  tokenRotatedAt: timestamp('token_rotated_at', { withTimezone: true, mode: 'date' }),
  tokenRotationCount: integer('token_rotation_count').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('payment_links_token_idx').on(t.token),
  index('payment_links_org_status_idx').on(t.organizationId, t.status),
  index('payment_links_invoice_idx').on(t.invoiceId),
]);

// ---------- Communications ----------

export const communications = pgTable('communications', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  channel: communicationChannelEnum('channel').notNull(),
  status: communicationStatusEnum('status').notNull().default('PENDING'),
  address: varchar('address', { length: 255 }).notNull(), // phone/email
  subject: varchar('subject', { length: 255 }),
  body: text('body').notNull(),
  template: varchar('template', { length: 64 }),
  entityType: varchar('entity_type', { length: 64 }), // e.g. 'invoice', 'receipt'
  entityId: uuid('entity_id'),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  failedReason: text('failed_reason'),
  providerRef: varchar('provider_ref', { length: 255 }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  index('comms_org_status_idx').on(t.organizationId, t.status),
  index('comms_entity_idx').on(t.entityType, t.entityId),
  index('comms_created_idx').on(t.organizationId, t.createdAt),
]);

// ---------- Audit Events ----------
// Append-only: NO UPDATE / DELETE granted to the app role; enforced in migration.

export const auditEvents = pgTable('audit_events', {
  id: pk(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  actorType: auditActorTypeEnum('actor_type').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  // For webhook/system actions we can carry a free-text identifier.
  actorLabel: varchar('actor_label', { length: 160 }),
  action: varchar('action', { length: 128 }).notNull(), // e.g. 'payment.confirmed'
  entityType: varchar('entity_type', { length: 64 }).notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  metadata: jsonb('metadata'),
  requestId: varchar('request_id', { length: 128 }),
  correlationId: varchar('correlation_id', { length: 128 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('audit_org_time_idx').on(t.organizationId, t.createdAt),
  index('audit_entity_idx').on(t.entityType, t.entityId),
  index('audit_action_idx').on(t.action),
  index('audit_actor_idx').on(t.actorUserId, t.createdAt),
  index('audit_correlation_idx').on(t.correlationId),
]);

// ---------- Idempotency Keys ----------

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: pk(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 128 }).notNull(), // UUID or provider event id
  scope: varchar('scope', { length: 32 }).notNull().default('API'), // API | WEBHOOK
  requestMethod: varchar('request_method', { length: 10 }),
  requestPath: varchar('request_path', { length: 255 }),
  requestHash: varchar('request_hash', { length: 64 }), // sha256 of body
  responseStatus: integer('response_status'),
  responseBodyHash: varchar('response_body_hash', { length: 64 }),
  responseBody: jsonb('response_body'), // cached response for replay
  lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
  recoveredAt: timestamp('recovered_at', { withTimezone: true, mode: 'date' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (t) => [
  // API keys are scoped per (org, user, key); webhook keys per (provider_event_id)
  uniqueIndex('idempotency_api_scope_idx').on(t.organizationId, t.userId, t.key),
  index('idempotency_expires_idx').on(t.expiresAt),
]);

// ---------- Webhook Events ----------

export const webhookEvents = pgTable('webhook_events', {
  id: pk(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  provider: varchar('provider', { length: 32 }).notNull(), // 'paystack'
  eventId: varchar('event_id', { length: 255 }).notNull(), // provider event id
  eventType: varchar('event_type', { length: 128 }).notNull(),
  payload: jsonb('payload').notNull(),
  signature: varchar('signature', { length: 255 }),
  status: webhookStatusEnum('status').notNull().default('RECEIVED'),
  processingAttempts: integer('processing_attempts').notNull().default(0),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  lastError: text('last_error'),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
}, (t) => [
  uniqueIndex('webhook_provider_event_idx').on(t.provider, t.eventId),
  index('webhook_status_idx').on(t.status, t.receivedAt),
  index('webhook_org_idx').on(t.organizationId, t.receivedAt),
]);

// ---------- Relations ----------

export const paymentLinksRelations = relations(paymentLinks, ({ one }) => ({
  invoice: one(invoices, { fields: [paymentLinks.invoiceId], references: [invoices.id] }),
  student: one(students, { fields: [paymentLinks.studentId], references: [students.id] }),
  revokedByUser: one(users, { fields: [paymentLinks.revokedBy], references: [users.id] }),
}));

export const communicationsRelations = relations(communications, ({ one }) => ({
  creator: one(users, { fields: [communications.createdBy], references: [users.id] }),
  organization: one(organizations, {
    fields: [communications.organizationId],
    references: [organizations.id],
  }),
}));
