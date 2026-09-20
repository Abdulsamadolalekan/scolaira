/**
 * Academic structure: academic_sessions, terms, classes, students,
 * guardians, student_guardians, class_enrollments.
 */
import {
  pgTable,
  text,
  varchar,
  date,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, timestamps, softDeletable } from './_columns';
import { organizations, users } from './tenancy';
import {
  sessionStatusEnum,
  termStatusEnum,
  studentStatusEnum,
  guardianRelationshipEnum,
} from './enums';

// ---------- Academic Sessions ----------

export const academicSessions = pgTable('academic_sessions', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 32 }).notNull(), // e.g. "2025/2026"
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  isCurrent: boolean('is_current').notNull().default(false),
  status: sessionStatusEnum('status').notNull().default('PLANNED'),
  closedAt: date('closed_at'),
  closedBy: uuid('closed_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('acad_sessions_org_name_idx').on(t.organizationId, t.name),
  index('acad_sessions_org_current_idx').on(t.organizationId, t.isCurrent),
]);

// ---------- Terms ----------

export const terms = pgTable('terms', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 32 }).notNull(), // "First Term" etc.
  label: varchar('label', { length: 8 }).notNull(), // "1st"/"2nd"/"3rd" for ordering
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  dueDate: date('due_date'),
  isCurrent: boolean('is_current').notNull().default(false),
  billed: boolean('billed').notNull().default(false),
  status: termStatusEnum('status').notNull().default('PLANNED'),
  billedAt: timestamp('billed_at', { withTimezone: true, mode: 'date' }),
  billedBy: uuid('billed_by').references(() => users.id, { onDelete: 'set null' }),
  closedAt: date('closed_at'),
  closedBy: uuid('closed_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('terms_org_session_name_idx').on(t.organizationId, t.sessionId, t.name),
  index('terms_org_current_idx').on(t.organizationId, t.isCurrent),
  index('terms_session_idx').on(t.sessionId),
]);

// ---------- Classes ----------

export const classes = pgTable('classes', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(), // "JSS 2A"
  arm: varchar('arm', { length: 16 }),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps(),
  ...softDeletable(),
}, (t) => [
  uniqueIndex('classes_org_name_idx').on(t.organizationId, t.name),
  index('classes_org_sort_idx').on(t.organizationId, t.sortOrder),
]);

// ---------- Students ----------

export const students = pgTable('students', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  studentId: varchar('student_id', { length: 32 }).notNull(), // school-issued ID e.g. STU-001
  firstName: varchar('first_name', { length: 120 }).notNull(),
  lastName: varchar('last_name', { length: 120 }).notNull(),
  middleName: varchar('middle_name', { length: 120 }),
  gender: varchar('gender', { length: 16 }),
  dateOfBirth: date('date_of_birth'),
  admissionDate: date('admission_date'),
  status: studentStatusEnum('status').notNull().default('ACTIVE'),
  archivedAt: date('archived_at'),
  graduatedAt: date('graduated_at'),
  withdrawnAt: date('withdrawn_at'),
  withdrawnReason: text('withdrawn_reason'),
  archivedReason: text('archived_reason'),
  ...timestamps(),
  ...softDeletable(),
}, (t) => [
  uniqueIndex('students_org_student_id_idx').on(t.organizationId, t.studentId),
  index('students_org_status_idx').on(t.organizationId, t.status),
  index('students_org_name_idx').on(t.organizationId, t.lastName, t.firstName),
]);

// ---------- Guardians ----------

export const guardians = pgTable('guardians', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 120 }).notNull(),
  lastName: varchar('last_name', { length: 120 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 32 }),
  address: text('address'),
  ...timestamps(),
  ...softDeletable(),
}, (t) => [
  index('guardians_org_phone_idx').on(t.organizationId, t.phone),
  index('guardians_org_email_idx').on(t.organizationId, t.email),
]);

// ---------- Student-Guardians join ----------

export const studentGuardians = pgTable('student_guardians', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  guardianId: uuid('guardian_id')
    .notNull()
    .references(() => guardians.id, { onDelete: 'cascade' }),
  relationship: guardianRelationshipEnum('relationship').notNull().default('PARENT'),
  isPrimary: boolean('is_primary').notNull().default(false),
  ...timestamps(),
}, (t) => [
  uniqueIndex('student_guardians_pair_idx').on(t.studentId, t.guardianId),
  index('student_guardians_guardian_idx').on(t.guardianId),
]);

// ---------- Class Enrollments (student-in-class per term) ----------

export const classEnrollments = pgTable('class_enrollments', {
  id: pk(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  classId: uuid('class_id')
    .notNull()
    .references(() => classes.id, { onDelete: 'cascade' }),
  termId: uuid('term_id')
    .notNull()
    .references(() => terms.id, { onDelete: 'cascade' }),
  enrolledOn: date('enrolled_on').notNull(),
  leftOn: date('left_on'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('class_enrollments_unique_idx').on(t.studentId, t.termId),
  index('class_enrollments_term_class_idx').on(t.termId, t.classId),
  index('class_enrollments_student_idx').on(t.studentId),
]);

// ---------- Relations ----------

export const academicSessionsRelations = relations(academicSessions, ({ many }) => ({
  terms: many(terms),
}));

export const termsRelations = relations(terms, ({ one, many }) => ({
  session: one(academicSessions, {
    fields: [terms.sessionId],
    references: [academicSessions.id],
  }),
  enrollments: many(classEnrollments),
}));

export const classesRelations = relations(classes, ({ many }) => ({
  enrollments: many(classEnrollments),
}));

export const studentsRelations = relations(students, ({ many }) => ({
  guardians: many(studentGuardians),
  enrollments: many(classEnrollments),
}));

export const guardiansRelations = relations(guardians, ({ many }) => ({
  students: many(studentGuardians),
}));

export const studentGuardiansRelations = relations(studentGuardians, ({ one }) => ({
  student: one(students, {
    fields: [studentGuardians.studentId],
    references: [students.id],
  }),
  guardian: one(guardians, {
    fields: [studentGuardians.guardianId],
    references: [guardians.id],
  }),
}));

export const classEnrollmentsRelations = relations(classEnrollments, ({ one }) => ({
  student: one(students, {
    fields: [classEnrollments.studentId],
    references: [students.id],
  }),
  class: one(classes, {
    fields: [classEnrollments.classId],
    references: [classes.id],
  }),
  term: one(terms, {
    fields: [classEnrollments.termId],
    references: [terms.id],
  }),
}));
