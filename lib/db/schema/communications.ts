/**
 * Communications / reminders.
 *
 * reminders: immutable audit log of balance follow-up sent to a guardian
 * (SMS/email/print). Updated only to reflect delivery lifecycle.
 */
import {
  pgTable,
  text,
  varchar,
  integer,
  bigint,
  uuid,
  index,
  timestamp,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_columns';
import { organizations, users } from './tenancy';
import { invoices } from './financials';
import { guardians, students } from './academic';
import { communicationChannelEnum, communicationStatusEnum } from './enums';
import { relations } from 'drizzle-orm';

export const reminders = pgTable('reminders', {
  id: pk(),
  organizationId: uuid('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
  studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
  guardianId: uuid('guardian_id').references(() => guardians.id, { onDelete: 'restrict' }),
  channel: communicationChannelEnum('channel').notNull(),
  status: communicationStatusEnum('status').notNull().default('PENDING'),
  balanceKobo: bigint('balance_kobo', { mode: 'number' }).notNull().default(0),
  agingDays: integer('aging_days').notNull().default(0),
  agingBucket: varchar('aging_bucket', { length: 16 }).notNull().default('CURRENT'),
  subject: text('subject'),
  body: text('body').notNull(),
  externalId: varchar('external_id', { length: 128 }),
  errorMessage: text('error_message'),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  index('reminders_org_created_idx').on(t.organizationId, t.createdAt),
  index('reminders_org_invoice_idx').on(t.organizationId, t.invoiceId, t.createdAt),
  index('reminders_org_student_idx').on(t.organizationId, t.studentId, t.createdAt),
  index('reminders_org_status_idx').on(t.organizationId, t.status),
]);

export const remindersRelations = relations(reminders, ({ one }) => ({
  organization: one(organizations, { fields: [reminders.organizationId], references: [organizations.id] }),
  invoice: one(invoices, { fields: [reminders.invoiceId], references: [invoices.id] }),
  student: one(students, { fields: [reminders.studentId], references: [students.id] }),
  guardian: one(guardians, { fields: [reminders.guardianId], references: [guardians.id] }),
  creator: one(users, { fields: [reminders.createdBy], references: [users.id] }),
}));
