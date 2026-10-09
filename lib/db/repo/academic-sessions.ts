/**
 * Academic sessions repository — scoped CRUD.
 */
import { eq, and } from 'drizzle-orm';
import { academicSessions } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type AcademicSession = typeof academicSessions.$inferSelect;
export type NewAcademicSession = typeof academicSessions.$inferInsert;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewAcademicSession, 'organizationId'>,
): Promise<AcademicSession> {
  const rows = await db
    .insert(academicSessions)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<AcademicSession | null> {
  const rows = await db
    .select()
    .from(academicSessions)
    .where(
      and(
        eq(academicSessions.id, id),
        eq(academicSessions.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<AcademicSession[]> {
  return db
    .select()
    .from(academicSessions)
    .where(eq(academicSessions.organizationId, ctx.organizationId));
}

export async function getCurrent(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<AcademicSession | null> {
  const rows = await db
    .select()
    .from(academicSessions)
    .where(
      and(
        eq(academicSessions.organizationId, ctx.organizationId),
        eq(academicSessions.isCurrent, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
