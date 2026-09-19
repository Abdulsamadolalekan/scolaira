/**
 * Students repository.
 *
 * Student financial state (outstanding balance, payments) is NOT stored on the
 * student row — it is computed by aggregating invoices and allocations. The
 * repo exposes only CRUD and a typed lookup; balance queries live in a service.
 */
import { eq, and } from 'drizzle-orm';
import { students } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
import { RepoInvariantError } from './_context';

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type StudentPatch = Partial<Pick<Student, 'firstName'|'lastName'|'middleName'|'gender'|'dateOfBirth'|'admissionDate'>>;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewStudent, 'organizationId'>,
): Promise<Student> {
  const rows = await db
    .insert(students)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Student | null> {
  const rows = await db
    .select()
    .from(students)
    .where(and(eq(students.id, id), eq(students.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByStudentId(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: string,
): Promise<Student | null> {
  const rows = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.organizationId, ctx.organizationId),
        eq(students.studentId, studentId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<Student[]> {
  return db
    .select()
    .from(students)
    .where(eq(students.organizationId, ctx.organizationId));
}

/**
 * Patch a subset of non-financial student fields. Financial state (balance,
 * enrollment-class linkage, guardians) is NOT modified here.
 */
export async function update(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  patch: StudentPatch,
): Promise<Student> {
  const cleaned: Record<string, unknown> = {};
  for (const k of ['firstName','lastName','middleName','gender','dateOfBirth','admissionDate'] as const) {
    if (k in patch) cleaned[k] = (patch as any)[k];
  }
  if (cleaned.firstName !== undefined && (typeof cleaned.firstName !== 'string' || !cleaned.firstName.trim())) {
    throw new RepoInvariantError('First name is required.');
  }
  if (cleaned.lastName !== undefined && (typeof cleaned.lastName !== 'string' || !cleaned.lastName.trim())) {
    throw new RepoInvariantError('Last name is required.');
  }
  const rows = await db
    .update(students)
    .set(cleaned as any)
    .where(and(eq(students.id, id), eq(students.organizationId, ctx.organizationId)))
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Student not found.');
  return rows[0]!;
}

export async function archive(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  reason?: string,
): Promise<Student> {
  // Status transition is enforced by trg_enforce_status_transitions.
  const rows = await db
    .update(students)
    .set({ status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason ?? null } as any)
    .where(and(eq(students.id, id), eq(students.organizationId, ctx.organizationId)))
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Student not found.');
  return rows[0]!;
}

export async function restore(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Student> {
  const rows = await db
    .update(students)
    .set({ status: 'ACTIVE', archivedAt: null, archivedReason: null, withdrawnAt: null, withdrawnReason: null, graduatedAt: null } as any)
    .where(and(eq(students.id, id), eq(students.organizationId, ctx.organizationId)))
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Student not found.');
  return rows[0]!;
}
