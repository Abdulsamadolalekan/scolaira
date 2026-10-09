/**
 * Term-specific student/class enrollment repository.
 *
 * `class_enrollments` is the authoritative academic population consumed by
 * M8 billing. This repository never creates or mutates financial records.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { classEnrollments, classes, students, terms } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
import { RepoInvariantError } from './_context';

export type Enrollment = typeof classEnrollments.$inferSelect;
export type NewEnrollment = typeof classEnrollments.$inferInsert;

export interface EnrollmentDetail {
  id: UUID;
  organizationId: UUID;
  studentId: UUID;
  studentCode: string;
  studentName: string;
  studentStatus: string;
  classId: UUID;
  className: string;
  classArm: string | null;
  classDeletedAt: Date | null;
  termId: UUID;
  termName: string;
  termStatus: string;
  enrolledOn: string;
  leftOn: string | null;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Enrollment | null> {
  const rows = await db
    .select()
    .from(classEnrollments)
    .where(and(eq(classEnrollments.id, id), eq(classEnrollments.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDetailed(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<EnrollmentDetail | null> {
  const rows = await db
    .select({
      id: classEnrollments.id,
      organizationId: classEnrollments.organizationId,
      studentId: classEnrollments.studentId,
      studentCode: students.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
      studentStatus: students.status,
      classId: classEnrollments.classId,
      className: classes.name,
      classArm: classes.arm,
      classDeletedAt: classes.deletedAt,
      termId: classEnrollments.termId,
      termName: terms.name,
      termStatus: terms.status,
      enrolledOn: classEnrollments.enrolledOn,
      leftOn: classEnrollments.leftOn,
    })
    .from(classEnrollments)
    .innerJoin(students, eq(students.id, classEnrollments.studentId))
    .innerJoin(classes, eq(classes.id, classEnrollments.classId))
    .innerJoin(terms, eq(terms.id, classEnrollments.termId))
    .where(and(eq(classEnrollments.id, id), eq(classEnrollments.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as UUID,
    organizationId: row.organizationId as UUID,
    studentId: row.studentId as UUID,
    studentCode: row.studentCode,
    studentName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    studentStatus: row.studentStatus,
    classId: row.classId as UUID,
    className: row.className,
    classArm: row.classArm,
    classDeletedAt: row.classDeletedAt,
    termId: row.termId as UUID,
    termName: row.termName,
    termStatus: row.termStatus,
    enrolledOn: row.enrolledOn,
    leftOn: row.leftOn,
  };
}

export async function listForTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
  options: { activeOnly?: boolean } = {},
): Promise<EnrollmentDetail[]> {
  const predicates = [
    eq(classEnrollments.organizationId, ctx.organizationId),
    eq(classEnrollments.termId, termId),
  ];
  if (options.activeOnly) predicates.push(isNull(classEnrollments.leftOn));

  const rows = await db
    .select({
      id: classEnrollments.id,
      organizationId: classEnrollments.organizationId,
      studentId: classEnrollments.studentId,
      studentCode: students.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
      studentStatus: students.status,
      classId: classEnrollments.classId,
      className: classes.name,
      classArm: classes.arm,
      classDeletedAt: classes.deletedAt,
      termId: classEnrollments.termId,
      termName: terms.name,
      termStatus: terms.status,
      enrolledOn: classEnrollments.enrolledOn,
      leftOn: classEnrollments.leftOn,
    })
    .from(classEnrollments)
    .innerJoin(students, eq(students.id, classEnrollments.studentId))
    .innerJoin(classes, eq(classes.id, classEnrollments.classId))
    .innerJoin(terms, eq(terms.id, classEnrollments.termId))
    .where(and(...predicates))
    .orderBy(asc(classes.sortOrder), asc(classes.name), asc(students.lastName), asc(students.firstName));

  return rows.map((row) => ({
    id: row.id as UUID,
    organizationId: row.organizationId as UUID,
    studentId: row.studentId as UUID,
    studentCode: row.studentCode,
    studentName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    studentStatus: row.studentStatus,
    classId: row.classId as UUID,
    className: row.className,
    classArm: row.classArm,
    classDeletedAt: row.classDeletedAt,
    termId: row.termId as UUID,
    termName: row.termName,
    termStatus: row.termStatus,
    enrolledOn: row.enrolledOn,
    leftOn: row.leftOn,
  }));
}

export async function listForStudent(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: UUID,
): Promise<EnrollmentDetail[]> {
  const rows = await db
    .select({
      id: classEnrollments.id,
      organizationId: classEnrollments.organizationId,
      studentId: classEnrollments.studentId,
      studentCode: students.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
      studentStatus: students.status,
      classId: classEnrollments.classId,
      className: classes.name,
      classArm: classes.arm,
      classDeletedAt: classes.deletedAt,
      termId: classEnrollments.termId,
      termName: terms.name,
      termStatus: terms.status,
      enrolledOn: classEnrollments.enrolledOn,
      leftOn: classEnrollments.leftOn,
    })
    .from(classEnrollments)
    .innerJoin(students, eq(students.id, classEnrollments.studentId))
    .innerJoin(classes, eq(classes.id, classEnrollments.classId))
    .innerJoin(terms, eq(terms.id, classEnrollments.termId))
    .where(and(eq(classEnrollments.organizationId, ctx.organizationId), eq(classEnrollments.studentId, studentId)))
    .orderBy(desc(terms.startsOn), desc(classEnrollments.enrolledOn));

  return rows.map((row) => ({
    id: row.id as UUID,
    organizationId: row.organizationId as UUID,
    studentId: row.studentId as UUID,
    studentCode: row.studentCode,
    studentName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    studentStatus: row.studentStatus,
    classId: row.classId as UUID,
    className: row.className,
    classArm: row.classArm,
    classDeletedAt: row.classDeletedAt,
    termId: row.termId as UUID,
    termName: row.termName,
    termStatus: row.termStatus,
    enrolledOn: row.enrolledOn,
    leftOn: row.leftOn,
  }));
}

export async function getForStudentTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: UUID,
  termId: UUID,
): Promise<Enrollment | null> {
  const rows = await db
    .select()
    .from(classEnrollments)
    .where(and(
      eq(classEnrollments.organizationId, ctx.organizationId),
      eq(classEnrollments.studentId, studentId),
      eq(classEnrollments.termId, termId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Pick<NewEnrollment, 'studentId' | 'classId' | 'termId' | 'enrolledOn'>,
): Promise<Enrollment> {
  const rows = await db
    .insert(classEnrollments)
    .values({
      organizationId: ctx.organizationId,
      studentId: input.studentId,
      classId: input.classId,
      termId: input.termId,
      enrolledOn: input.enrolledOn,
      leftOn: null,
    })
    .returning();
  return rows[0]!;
}

export async function updateClass(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  input: { classId: UUID; enrolledOn?: string },
): Promise<Enrollment> {
  const rows = await db
    .update(classEnrollments)
    .set({ classId: input.classId, ...(input.enrolledOn ? { enrolledOn: input.enrolledOn } : {}) })
    .where(and(eq(classEnrollments.id, id), eq(classEnrollments.organizationId, ctx.organizationId)))
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Enrollment not found.');
  return rows[0];
}

export async function leave(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  leftOn: string,
): Promise<Enrollment> {
  const rows = await db
    .update(classEnrollments)
    .set({ leftOn })
    .where(and(eq(classEnrollments.id, id), eq(classEnrollments.organizationId, ctx.organizationId)))
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Enrollment not found.');
  return rows[0];
}

export interface RosterSummary {
  activeEnrollmentCount: number;
  activeStudentCount: number;
  noEnrollmentStudentCount: number;
  inactiveActiveEnrollmentCount: number;
  archivedClassActiveEnrollmentCount: number;
}

/**
 * Exception counts intentionally mirror M8's active-enrollment population:
 * active student + left_on NULL + selected term. Closed-term history is not
 * treated as an actionable current roster exception.
 */
export async function readinessSummary(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
): Promise<RosterSummary> {
  const rows = await db.execute(sql`
    WITH active_enrollments AS (
      SELECT e.student_id, e.class_id, s.status AS student_status,
             c.deleted_at AS class_deleted_at
        FROM class_enrollments e
        JOIN students s ON s.id = e.student_id AND s.organization_id = e.organization_id
        JOIN classes c ON c.id = e.class_id AND c.organization_id = e.organization_id
        JOIN terms t ON t.id = e.term_id AND t.organization_id = e.organization_id
       WHERE e.organization_id = ${ctx.organizationId}::uuid
         AND e.term_id = ${termId}::uuid
         AND t.status <> 'CLOSED'
         AND e.left_on IS NULL
    ),
    active_students AS (
      SELECT s.id
        FROM students s
       WHERE s.organization_id = ${ctx.organizationId}::uuid
         AND s.status = 'ACTIVE'
    )
    SELECT
      (SELECT count(*) FROM active_enrollments)::int AS active_enrollment_count,
      (SELECT count(*) FROM active_students)::int AS active_student_count,
      (SELECT count(*) FROM active_students a
        WHERE NOT EXISTS (SELECT 1 FROM active_enrollments e WHERE e.student_id = a.id AND e.student_status = 'ACTIVE'))::int
        AS no_enrollment_student_count,
      (SELECT count(*) FROM active_enrollments WHERE student_status <> 'ACTIVE')::int
        AS inactive_active_enrollment_count,
      (SELECT count(*) FROM active_enrollments WHERE class_deleted_at IS NOT NULL)::int
        AS archived_class_active_enrollment_count
  `) as unknown as Array<Record<string, number | string>>;
  const row = rows[0] ?? {};
  return {
    activeEnrollmentCount: Number(row.active_enrollment_count ?? 0),
    activeStudentCount: Number(row.active_student_count ?? 0),
    noEnrollmentStudentCount: Number(row.no_enrollment_student_count ?? 0),
    inactiveActiveEnrollmentCount: Number(row.inactive_active_enrollment_count ?? 0),
    archivedClassActiveEnrollmentCount: Number(row.archived_class_active_enrollment_count ?? 0),
  };
}
