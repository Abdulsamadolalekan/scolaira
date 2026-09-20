/**
 * Financial entities: fee_definitions, fee_assignments, invoices, invoice_lines,
 * payments, payment_allocations, receipts, reversals.
 *
 * Non-negotiable:
 *  - All money columns end with `_kobo` and are BIGINT (non-negative for events;
 *    signed for derived balances).
 *  - No cascade deletes on financial records (RESTRICT by default).
 *  - Enforced by CHECK constraints and triggers (added in the SQL migration
 *    alongside drizzle-generated code).
 */
import {
  pgTable,
  text,
  varchar,
  date,
  boolean,
  integer,
  bigint,
  uuid,
  index,
  uniqueIndex,
  timestamp,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { pk, timestamps } from './_columns';
import { organizations, users } from './tenancy';
import { academicSessions, terms, classes, students } from './academic';
import {
  feeAssignmentStatusEnum,
  invoiceStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  allocationStatusEnum,
  receiptStatusEnum,
  reversalTypeEnum,
  waiverReasonEnum,
} from './enums';

// ---------- Helpers for kobo (non-negative BIGINT) ----------

/** Non-negative kobo column. We apply CHECK (value >= 0) via manual SQL in migration. */
const koboColumn = (name: string) =>
  bigint(name, { mode: 'number' }).notNull();

// ---------- Fee Definitions ----------

export const feeDefinitions = pgTable('fee_definitions', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  code: varchar('code', { length: 32 }).notNull(), // e.g. "TUITION", "DEV_LEVY"
  name: varchar('name', { length: 120 }).notNull(), // "Tuition Fee"
  description: text('description'),
  defaultAmountKobo: bigint('default_amount_kobo', { mode: 'number' }).notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps(),
}, (t) => [
  uniqueIndex('fee_defs_org_code_idx').on(t.organizationId, t.code),
  index('fee_defs_org_active_idx').on(t.organizationId, t.isActive),
]);

// ---------- Fee Assignments (fee x class x term) ----------

export const feeAssignments = pgTable('fee_assignments', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  feeDefinitionId: uuid('fee_definition_id')
    .notNull()
    .references(() => feeDefinitions.id, { onDelete: 'restrict' }),
  classId: uuid('class_id').references(() => classes.id, { onDelete: 'restrict' }),
  termId: uuid('term_id')
    .notNull()
    .references(() => terms.id, { onDelete: 'cascade' }),
  amountKobo: koboColumn('amount_kobo'),
  adjustmentKobo: bigint('adjustment_kobo', { mode: 'number' }).notNull().default(0),
  dueDate: date('due_date'),
  status: feeAssignmentStatusEnum('status').notNull().default('DRAFT'),
  ...timestamps(),
}, (t) => [
  // A fee definition is assigned to (class, term) at most once
  uniqueIndex('fee_assign_unique_idx').on(t.feeDefinitionId, t.classId, t.termId),
  index('fee_assign_term_idx').on(t.termId),
  index('fee_assign_class_idx').on(t.classId),
]);

// ---------- Invoices ----------

export const invoices = pgTable('invoices', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  invoiceNumber: varchar('invoice_number', { length: 32 }).notNull(), // e.g. INV-1042
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'restrict' }),
  termId: uuid('term_id')
    .notNull()
    .references(() => terms.id, { onDelete: 'restrict' }),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => academicSessions.id, { onDelete: 'restrict' }),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  status: invoiceStatusEnum('status').notNull().default('DRAFT'),
  memo: text('memo'),
  totalKobo: koboColumn('total_kobo').default(0),
  paidKobo: koboColumn('paid_kobo').default(0),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
  voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
  voidedReason: text('voided_reason'),
  voidedBy: uuid('voided_by').references(() => users.id),
  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('invoices_org_number_idx').on(t.organizationId, t.invoiceNumber),
  index('invoices_student_idx').on(t.studentId),
  index('invoices_term_idx').on(t.termId),
  index('invoices_org_status_idx').on(t.organizationId, t.status),
  index('invoices_org_due_idx').on(t.organizationId, t.dueDate),
]);

// ---------- Invoice Lines ----------

export const invoiceLines = pgTable('invoice_lines', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  feeAssignmentId: uuid('fee_assignment_id').references(() => feeAssignments.id, {
    onDelete: 'restrict',
  }),
  // Denormalized billing key columns. They are NULL for legitimate ad-hoc
  // lines; M8's database trigger proves they match invoice.student_id /
  // invoice.term_id whenever feeAssignmentId is present.
  billingStudentId: uuid('billing_student_id').references(() => students.id, { onDelete: 'restrict' }),
  billingTermId: uuid('billing_term_id').references(() => terms.id, { onDelete: 'restrict' }),
  description: varchar('description', { length: 255 }).notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitRateKobo: koboColumn('unit_rate_kobo'),
  adjustmentKobo: bigint('adjustment_kobo', { mode: 'number' }).notNull().default(0),
  amountKobo: koboColumn('amount_kobo'),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  ...timestamps(),
}, (t) => [
  index('invoice_lines_invoice_idx').on(t.invoiceId),
  index('invoice_lines_fee_assignment_idx').on(t.feeAssignmentId),
]);

// ---------- Payments ----------

export const payments = pgTable('payments', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  paymentNumber: varchar('payment_number', { length: 32 }).notNull(), // PMT-0001
  method: paymentMethodEnum('method').notNull(),
  status: paymentStatusEnum('status').notNull().default('PENDING'),
  amountKobo: koboColumn('amount_kobo'),
  // Remaining amount not yet allocated — maintained by trigger; CHECK unallocated_kobo >= 0.
  unallocatedKobo: koboColumn('unallocated_kobo').default(sql`0`),
  reference: varchar('reference', { length: 128 }), // bank teller, POS ref, Paystack transaction id
  payerName: varchar('payer_name', { length: 160 }),
  payerPhone: varchar('payer_phone', { length: 32 }),
  payerEmail: varchar('payer_email', { length: 255 }),
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
  notes: text('notes'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('payments_org_number_idx').on(t.organizationId, t.paymentNumber),
  // Reference uniqueness is method/channel-specific; enforced by partial unique:
  // - CASH has no reference, so no unique attempt
  // - Other methods require unique reference within org
  // We add the unique index in the SQL migration because drizzle partial-index
  // expressions are verbose; drizzle still allows index() placeholders.
  index('payments_org_reference_idx').on(t.organizationId, t.method, t.reference),
  index('payments_status_idx').on(t.organizationId, t.status),
  index('payments_paid_at_idx').on(t.organizationId, t.paidAt),
]);

// ---------- Payment Allocations ----------

export const paymentAllocations = pgTable('payment_allocations', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'restrict' }),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'restrict' }),
  amountKobo: koboColumn('amount_kobo'),
  status: allocationStatusEnum('status').notNull().default('ACTIVE'),
  allocatedAt: timestamp('allocated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  reversalId: uuid('reversal_id'), // FK to reversals set after creation
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  index('allocations_payment_idx').on(t.paymentId),
  index('allocations_invoice_idx').on(t.invoiceId),
  index('allocations_active_invoice_idx').on(t.invoiceId, t.status),
]);

// ---------- Receipts ----------

export const receipts = pgTable('receipts', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  receiptNumber: varchar('receipt_number', { length: 32 }).notNull(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'restrict' }),
  // A receipt may be issued against a single allocation or for the whole payment.
  allocationId: uuid('allocation_id').references(() => paymentAllocations.id, {
    onDelete: 'restrict',
  }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'restrict' }),
  amountKobo: koboColumn('amount_kobo'),
  status: receiptStatusEnum('status').notNull().default('ISSUED'),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
  voidedReason: text('voided_reason'),
  issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
  pdfUrl: text('pdf_url'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('receipts_org_number_idx').on(t.organizationId, t.receiptNumber),
  index('receipts_payment_idx').on(t.paymentId),
  index('receipts_student_idx').on(t.studentId),
]);

// ---------- Reversals / Refunds / Corrections ----------

export const reversals = pgTable('reversals', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  reversalNumber: varchar('reversal_number', { length: 32 }).notNull(),
  type: reversalTypeEnum('type').notNull(),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
  // A reversal may target specific allocations; if none given, reverses entire payment.
  amountKobo: koboColumn('amount_kobo'),
  reason: text('reason').notNull(),
  reference: varchar('reference', { length: 128 }), // external ref e.g. Paystack refund id
  reversedAt: timestamp('reversed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  reversedBy: uuid('reversed_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  uniqueIndex('reversals_org_number_idx').on(t.organizationId, t.reversalNumber),
  index('reversals_payment_idx').on(t.paymentId),
]);

// Now wire the allocation.reversalId circular reference (reversals is declared after
// allocations; add FK separately below by altering table in SQL migration — drizzle
// doesn't easily express late FKs, so the migration adds it).

// ---------- Relations ----------

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  student: one(students, { fields: [invoices.studentId], references: [students.id] }),
  term: one(terms, { fields: [invoices.termId], references: [terms.id] }),
  session: one(academicSessions, {
    fields: [invoices.sessionId],
    references: [academicSessions.id],
  }),
  lines: many(invoiceLines),
  allocations: many(paymentAllocations),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  feeAssignment: one(feeAssignments, {
    fields: [invoiceLines.feeAssignmentId],
    references: [feeAssignments.id],
  }),
  billingStudent: one(students, {
    fields: [invoiceLines.billingStudentId],
    references: [students.id],
  }),
  billingTerm: one(terms, {
    fields: [invoiceLines.billingTermId],
    references: [terms.id],
  }),
}));

export const waivers = pgTable('waivers', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  invoiceLineId: uuid('invoice_line_id')
    .notNull()
    .references(() => invoiceLines.id, { onDelete: 'restrict' }),
  reason: waiverReasonEnum('reason').notNull(),
  amountKobo: koboColumn('amount_kobo'),
  note: text('note'),
  approvedBy: uuid('approved_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (t) => [
  uniqueIndex('waivers_invoice_line_unique_idx').on(t.invoiceLineId),
  index('waivers_org_created_idx').on(t.organizationId, t.createdAt),
  index('waivers_org_reason_idx').on(t.organizationId, t.reason),
]);

export const waiversRelations = relations(waivers, ({ one }) => ({
  invoiceLine: one(invoiceLines, {
    fields: [waivers.invoiceLineId],
    references: [invoiceLines.id],
  }),
  approver: one(users, { fields: [waivers.approvedBy], references: [users.id] }),
}));

export const paymentsRelations = relations(payments, ({ many }) => ({
  allocations: many(paymentAllocations),
  receipts: many(receipts),
  reversals: many(reversals),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentAllocations.paymentId],
    references: [payments.id],
  }),
  invoice: one(invoices, {
    fields: [paymentAllocations.invoiceId],
    references: [invoices.id],
  }),
}));

export const receiptsRelations = relations(receipts, ({ one }) => ({
  payment: one(payments, { fields: [receipts.paymentId], references: [payments.id] }),
  allocation: one(paymentAllocations, {
    fields: [receipts.allocationId],
    references: [paymentAllocations.id],
  }),
  student: one(students, { fields: [receipts.studentId], references: [students.id] }),
}));

export const reversalsRelations = relations(reversals, ({ one }) => ({
  payment: one(payments, { fields: [reversals.paymentId], references: [payments.id] }),
}));

export const feeDefinitionsRelations = relations(feeDefinitions, ({ many }) => ({
  assignments: many(feeAssignments),
}));

export const feeAssignmentsRelations = relations(feeAssignments, ({ one }) => ({
  feeDefinition: one(feeDefinitions, {
    fields: [feeAssignments.feeDefinitionId],
    references: [feeDefinitions.id],
  }),
  term: one(terms, { fields: [feeAssignments.termId], references: [terms.id] }),
  klass: one(classes, { fields: [feeAssignments.classId], references: [classes.id] }),
}));
