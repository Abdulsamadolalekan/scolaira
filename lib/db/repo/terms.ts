/**
 * Terms repository.
 */
import { eq, and, sql } from 'drizzle-orm';
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

/** Lock the term row so a bill run sees one coherent fee/enrollment snapshot. */
export async function lockForBilling(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Term | null> {
  const rows = await db.execute(sql`
    SELECT id,
           organization_id AS "organizationId",
           session_id AS "sessionId",
           name, label, starts_on AS "startsOn", ends_on AS "endsOn",
           due_date AS "dueDate", is_current AS "isCurrent",
           billed, status, billed_at AS "billedAt", billed_by AS "billedBy",
           closed_at AS "closedAt", closed_by AS "closedBy",
           created_at AS "createdAt", updated_at AS "updatedAt"
      FROM terms
     WHERE id = ${id}::uuid
       AND organization_id = ${ctx.organizationId}::uuid
     FOR UPDATE
  `) as unknown as Term[];
  return rows[0] ?? null;
}

/** ACTIVE → BILLED is called only after billing completeness is proven. */
export async function markBilled(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<Term | null> {
  const rows = await db
    .update(terms)
    .set({
      billed: true,
      status: 'BILLED',
      billedAt: new Date(),
      billedBy: ctx.userId,
    })
    .where(
      and(
        eq(terms.id, id),
        eq(terms.organizationId, ctx.organizationId),
        eq(terms.status, 'ACTIVE'),
        eq(terms.billed, false),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
