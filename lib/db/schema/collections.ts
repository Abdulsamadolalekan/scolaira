/**
 * M11 collections workbench.
 *
 * These tables are operational control records only. They deliberately do not
 * store invoice balances, payment balances, allocation amounts, receipts, or
 * reconciliation outcomes. Current financial truth is read from the existing
 * authoritative financial tables at query time.
 */
import { pgTable, uuid, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, timestamps } from './_columns';
import { organizations, users } from './tenancy';
import { students } from './academic';
import { invoices } from './financials';
import { reminders } from './communications';

export const collectionsCases = pgTable(
  'collections_cases',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    /** Optional operator focus; invoice truth remains in invoices. */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    state: varchar('state', { length: 16 }).notNull().default('OPEN'),
    priority: varchar('priority', { length: 16 }).notNull().default('NORMAL'),
    reason: text('reason').notNull(),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    nextActionAt: timestamp('next_action_at', { withTimezone: true, mode: 'date' }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('m11_collections_org_state_idx').on(t.organizationId, t.state, t.createdAt),
    index('m11_collections_org_priority_idx').on(t.organizationId, t.priority, t.createdAt),
    index('m11_collections_org_assignee_idx').on(t.organizationId, t.assignedTo, t.state),
    index('m11_collections_org_student_idx').on(t.organizationId, t.studentId, t.createdAt),
    index('m11_collections_org_invoice_idx').on(t.organizationId, t.invoiceId),
  ],
);

export const collectionsCaseEvents = pgTable(
  'collections_case_events',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => collectionsCases.id, { onDelete: 'restrict' }),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    previousState: varchar('previous_state', { length: 16 }),
    nextState: varchar('next_state', { length: 16 }),
    previousAssignee: uuid('previous_assignee').references(() => users.id, {
      onDelete: 'restrict',
    }),
    nextAssignee: uuid('next_assignee').references(() => users.id, { onDelete: 'restrict' }),
    note: text('note'),
    reminderId: uuid('reminder_id').references(() => reminders.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('m11_collections_events_case_idx').on(t.organizationId, t.caseId, t.createdAt),
    index('m11_collections_events_reminder_idx').on(t.organizationId, t.reminderId),
    index('m11_collections_events_actor_idx').on(t.organizationId, t.createdBy, t.createdAt),
  ],
);

export const collectionsCasesRelations = relations(collectionsCases, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [collectionsCases.organizationId],
    references: [organizations.id],
  }),
  student: one(students, { fields: [collectionsCases.studentId], references: [students.id] }),
  invoice: one(invoices, { fields: [collectionsCases.invoiceId], references: [invoices.id] }),
  assignee: one(users, { fields: [collectionsCases.assignedTo], references: [users.id] }),
  creator: one(users, { fields: [collectionsCases.createdBy], references: [users.id] }),
  resolver: one(users, { fields: [collectionsCases.resolvedBy], references: [users.id] }),
  closer: one(users, { fields: [collectionsCases.closedBy], references: [users.id] }),
  events: many(collectionsCaseEvents),
}));

export const collectionsCaseEventsRelations = relations(collectionsCaseEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [collectionsCaseEvents.organizationId],
    references: [organizations.id],
  }),
  case: one(collectionsCases, {
    fields: [collectionsCaseEvents.caseId],
    references: [collectionsCases.id],
  }),
  reminder: one(reminders, {
    fields: [collectionsCaseEvents.reminderId],
    references: [reminders.id],
  }),
  creator: one(users, { fields: [collectionsCaseEvents.createdBy], references: [users.id] }),
}));
