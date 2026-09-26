/**
 * Classes repository.
 */
import { eq, and } from 'drizzle-orm';
import { classes } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewClass, 'organizationId'>,
): Promise<Class> {
  const rows = await db
    .insert(classes)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Class | null> {
  const rows = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, id), eq(classes.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<Class[]> {
  return db
    .select()
    .from(classes)
    .where(eq(classes.organizationId, ctx.organizationId));
}
