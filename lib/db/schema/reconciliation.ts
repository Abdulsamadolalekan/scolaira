/**
 * Reconciliation control-plane records.
 *
 * These tables describe evidence, review decisions, and operational state.
 * They do not contain authoritative payment balances, allocation balances, or
 * invoice totals; those remain in the existing financial tables and triggers.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, timestamps } from './_columns';
import { organizations, users } from './tenancy';
import { payments, invoices } from './financials';
import { students } from './academic';

export const reconciliationCases = pgTable(
  'reconciliation_cases',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    previousState: varchar('previous_state', { length: 16 }),
    reason: text('reason'),
    resolutionCode: varchar('resolution_code', { length: 64 }),
    resolutionNote: text('resolution_note'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    // The partial one-open-case index is defined in the hand-written migration.
    index('m10_reconciliation_org_state_idx').on(t.organizationId, t.state, t.createdAt),
    index('m10_reconciliation_org_kind_idx').on(t.organizationId, t.kind, t.createdAt),
    index('m10_reconciliation_payment_idx').on(t.paymentId),
    index('m10_reconciliation_assignee_idx').on(t.organizationId, t.assignedTo, t.state),
  ],
);

export const reconciliationEvidence = pgTable(
  'reconciliation_evidence',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => reconciliationCases.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    reference: varchar('reference', { length: 255 }),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }),
    note: text('note'),
    contentHash: varchar('content_hash', { length: 128 }),
    metadata: jsonb('metadata'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('m10_reconciliation_evidence_case_idx').on(t.organizationId, t.caseId, t.createdAt),
    index('m10_reconciliation_evidence_reference_idx').on(t.organizationId, t.reference),
  ],
);

export const reconciliationCandidates = pgTable(
  'reconciliation_candidates',
  {
    id: pk(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => reconciliationCases.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    basis: text('basis').notNull(),
    state: varchar('state', { length: 16 }).notNull().default('PROPOSED'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('m10_reconciliation_candidates_case_idx').on(t.organizationId, t.caseId, t.createdAt),
    index('m10_reconciliation_candidates_invoice_idx').on(t.organizationId, t.invoiceId),
    index('m10_reconciliation_candidates_student_idx').on(t.organizationId, t.studentId),
  ],
);

export const reconciliationCasesRelations = relations(reconciliationCases, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [reconciliationCases.organizationId],
    references: [organizations.id],
  }),
  payment: one(payments, { fields: [reconciliationCases.paymentId], references: [payments.id] }),
  assignee: one(users, { fields: [reconciliationCases.assignedTo], references: [users.id] }),
  creator: one(users, { fields: [reconciliationCases.createdBy], references: [users.id] }),
  resolver: one(users, { fields: [reconciliationCases.resolvedBy], references: [users.id] }),
  evidence: many(reconciliationEvidence),
  candidates: many(reconciliationCandidates),
}));

export const reconciliationEvidenceRelations = relations(reconciliationEvidence, ({ one }) => ({
  organization: one(organizations, {
    fields: [reconciliationEvidence.organizationId],
    references: [organizations.id],
  }),
  case: one(reconciliationCases, {
    fields: [reconciliationEvidence.caseId],
    references: [reconciliationCases.id],
  }),
  creator: one(users, { fields: [reconciliationEvidence.createdBy], references: [users.id] }),
}));

export const reconciliationCandidatesRelations = relations(reconciliationCandidates, ({ one }) => ({
  organization: one(organizations, {
    fields: [reconciliationCandidates.organizationId],
    references: [organizations.id],
  }),
  case: one(reconciliationCases, {
    fields: [reconciliationCandidates.caseId],
    references: [reconciliationCases.id],
  }),
  student: one(students, {
    fields: [reconciliationCandidates.studentId],
    references: [students.id],
  }),
  invoice: one(invoices, {
    fields: [reconciliationCandidates.invoiceId],
    references: [invoices.id],
  }),
  creator: one(users, { fields: [reconciliationCandidates.createdBy], references: [users.id] }),
}));
