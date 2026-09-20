/**
 * Fee-assignment repository.
 *
 * Assignments are the term-scoped, authoritative amount for a reusable fee
 * definition. A NULL class_id is a school-wide assignment; a class-specific
 * assignment overrides that school-wide assignment for students in the class
 * during preview/billing.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { feeAssignments, feeDefinitions, classes } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';

export type FeeAssignment = typeof feeAssignments.$inferSelect;
export type NewFeeAssignment = Omit<typeof feeAssignments.$inferInsert, 'organizationId'>;

export interface ReplaceAssignmentInput {
  feeDefinitionId: UUID;
  classId?: UUID | null;
  amountKobo: number;
  adjustmentKobo?: number;
  dueDate?: string | null;
  status?: 'DRAFT' | 'ACTIVE';
}

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewFeeAssignment, 'organizationId'>,
): Promise<FeeAssignment> {
  const rows = await db
    .insert(feeAssignments)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FeeAssignment | null> {
  const rows = await db
    .select()
    .from(feeAssignments)
    .where(
      and(
        eq(feeAssignments.id, id),
        eq(feeAssignments.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
): Promise<FeeAssignment[]> {
  return db
    .select()
    .from(feeAssignments)
    .where(
      and(
        eq(feeAssignments.organizationId, ctx.organizationId),
        eq(feeAssignments.termId, termId),
      ),
    )
    .orderBy(feeAssignments.createdAt);
}

export async function listDetailedForTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
): Promise<Array<FeeAssignment & { feeName: string; feeCode: string; className: string | null }>> {
  const rows = await db
    .select({
      assignment: feeAssignments,
      feeName: feeDefinitions.name,
      feeCode: feeDefinitions.code,
      className: classes.name,
    })
    .from(feeAssignments)
    .innerJoin(feeDefinitions, eq(feeDefinitions.id, feeAssignments.feeDefinitionId))
    .leftJoin(classes, eq(classes.id, feeAssignments.classId))
    .where(
      and(
        eq(feeAssignments.organizationId, ctx.organizationId),
        eq(feeAssignments.termId, termId),
      ),
    )
    .orderBy(feeDefinitions.name, feeAssignments.classId);
  return rows.map((row) => ({
    ...row.assignment,
    feeName: row.feeName,
    feeCode: row.feeCode,
    className: row.className,
  }));
}

/**
 * Replace the complete assignment set for an unbilled term atomically. The
 * caller normally invokes this inside its own transaction; the term trigger
 * also takes a conflicting lock for every row mutation.
 */
export async function replaceForTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
  inputs: ReadonlyArray<ReplaceAssignmentInput>,
): Promise<FeeAssignment[]> {
  const termRows = await db.execute(sql`
    SELECT id, status, billed
      FROM terms
     WHERE id = ${termId}::uuid
       AND organization_id = ${ctx.organizationId}::uuid
     FOR UPDATE
  `) as unknown as Array<{ id: UUID; status: string; billed: boolean }>;
  const term = termRows[0];
  if (!term) throw new RepoInvariantError('Term not found');
  if (term.status === 'BILLED' || term.status === 'CLOSED' || term.billed) {
    throw new RepoInvariantError('Fee assignments are frozen after billing');
  }

  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.amountKobo <= 0 || !Number.isSafeInteger(input.amountKobo)) {
      throw new RepoInvariantError('Fee assignment amount must be a positive kobo integer');
    }
    if (input.adjustmentKobo !== undefined && (!Number.isSafeInteger(input.adjustmentKobo) || input.adjustmentKobo < 0)) {
      throw new RepoInvariantError('Fee assignment adjustment must be a non-negative kobo integer');
    }
    const key = `${input.feeDefinitionId}:${input.classId ?? 'ORG'}`;
    if (seen.has(key)) throw new RepoInvariantError('A fee cannot be assigned twice to the same class in one term');
    seen.add(key);
  }

  await db
    .delete(feeAssignments)
    .where(and(eq(feeAssignments.organizationId, ctx.organizationId), eq(feeAssignments.termId, termId)));

  if (inputs.length === 0) return [];
  return db
    .insert(feeAssignments)
    .values(inputs.map((input) => ({
      organizationId: ctx.organizationId,
      feeDefinitionId: input.feeDefinitionId,
      classId: input.classId ?? null,
      termId,
      amountKobo: input.amountKobo,
      adjustmentKobo: input.adjustmentKobo ?? 0,
      dueDate: input.dueDate ?? null,
      status: input.status ?? 'ACTIVE',
    })))
    .returning();
}

export async function activate(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FeeAssignment | null> {
  const rows = await db
    .update(feeAssignments)
    .set({ status: 'ACTIVE' })
    .where(and(eq(feeAssignments.id, id), eq(feeAssignments.organizationId, ctx.organizationId)))
    .returning();
  return rows[0] ?? null;
}

export async function archive(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FeeAssignment | null> {
  const rows = await db
    .update(feeAssignments)
    .set({ status: 'ARCHIVED' })
    .where(and(eq(feeAssignments.id, id), eq(feeAssignments.organizationId, ctx.organizationId)))
    .returning();
  return rows[0] ?? null;
}

/** Assert foreign key references belong to the active tenant before replace. */
export async function assertReferencesInTenant(
  db: TenantScopedDb,
  ctx: TenantCtx,
  inputs: ReadonlyArray<ReplaceAssignmentInput>,
): Promise<void> {
  const feeIds = Array.from(new Set(inputs.map((i) => i.feeDefinitionId)));
  const classIds = Array.from(new Set(inputs.map((i) => i.classId).filter(Boolean))) as UUID[];
  if (feeIds.length) {
    const fees = await db.select({ id: feeDefinitions.id, isActive: feeDefinitions.isActive }).from(feeDefinitions)
      .where(and(eq(feeDefinitions.organizationId, ctx.organizationId), inArray(feeDefinitions.id, feeIds)));
    if (fees.length !== feeIds.length) throw new RepoInvariantError('One or more fee definitions are not in this school');
    if (fees.some((fee) => !fee.isActive)) throw new RepoInvariantError('Archived fee definitions cannot be assigned to a new term structure');
  }
  if (classIds.length) {
    const klasses = await db.select({ id: classes.id }).from(classes)
      .where(and(eq(classes.organizationId, ctx.organizationId), inArray(classes.id, classIds)));
    if (klasses.length !== classIds.length) throw new RepoInvariantError('One or more classes are not in this school');
  }
}
