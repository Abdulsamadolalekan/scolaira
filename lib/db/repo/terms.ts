/**
 * Terms repository.
 */
import { eq, and } from 'drizzle-orm';
import { terms } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type Term = typeof terms.$inferSelect;
export type NewTerm = typeof terms.$inferInsert;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewTerm, 'organizationId'>,
): Promise<Term> {
  const rows = await db
    .insert(terms)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Term | null> {
  const rows = await db
    .select()
    .from(terms)
    .where(and(eq(terms.id, id), eq(terms.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<Term[]> {
  return db
    .select()
    .from(terms)
    .where(eq(terms.organizationId, ctx.organizationId));
}

export async function getCurrent(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<Term | null> {
  const rows = await db
    .select()
    .from(terms)
    .where(
      and(
        eq(terms.organizationId, ctx.organizationId),
        eq(terms.isCurrent, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
