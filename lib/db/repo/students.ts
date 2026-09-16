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

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;

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
