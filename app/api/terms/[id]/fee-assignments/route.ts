/**
 * GET/PUT /api/terms/:id/fee-assignments
 *
 * A PUT replaces the complete fee matrix for an unbilled term in one
 * transaction. Class-specific assignments override school-wide assignments for
 * the same fee definition during billing.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import * as termRepo from '@/lib/db/repo/terms';
import * as assignmentRepo from '@/lib/db/repo/fee-assignments';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AssignmentSchema = z.object({
  feeDefinitionId: z.string().regex(UUID_RE),
  classId: z.string().regex(UUID_RE).nullable().optional(),
  amountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  adjustmentKobo: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
});
const ReplaceSchema = z.object({ assignments: z.array(AssignmentSchema).max(500) });

function serializeAssignment(row: assignmentRepo.FeeAssignment & { feeName?: string; feeCode?: string; className?: string | null }) {
  return {
    id: row.id,
    feeDefinitionId: row.feeDefinitionId,
    feeCode: row.feeCode,
    feeName: row.feeName,
    classId: row.classId,
    className: row.className ?? null,
    termId: row.termId,
    amountKobo: Number(row.amountKobo),
    adjustmentKobo: Number(row.adjustmentKobo),
    dueDate: row.dueDate,
    status: row.status,
  };
}

export const GET = withAuthorizedRoute(
  { action: 'fee_assignment.manage', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id' } }, { status: 400 });
    const term = await termRepo.get(db, ctx, id as any);
    if (!term) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Term not found' } }, { status: 404 });
    const rows = await assignmentRepo.listDetailedForTerm(db, ctx, id as any);
    return NextResponse.json({
      term: { id: term.id, name: term.name, status: term.status, billed: term.billed },
      assignments: rows.map(serializeAssignment),
    });
  },
);

export const PUT = withAuthorizedRoute(
  { action: 'fee_assignment.manage', method: 'PUT', bodySchema: ReplaceSchema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id' } }, { status: 400 });
    const data = body as z.infer<typeof ReplaceSchema>;
    const inputs = data.assignments.map((assignment) => ({
      feeDefinitionId: assignment.feeDefinitionId as any,
      classId: assignment.classId as any,
      amountKobo: assignment.amountKobo,
      adjustmentKobo: assignment.adjustmentKobo,
      dueDate: assignment.dueDate ?? null,
      status: assignment.status,
    }));
    try {
      const rows = await db.transaction(async (tx) => {
        await assignmentRepo.assertReferencesInTenant(tx, ctx, inputs);
        const existing = await assignmentRepo.listForTerm(tx, ctx, id as any);
        const replaced = await assignmentRepo.replaceForTerm(tx, ctx, id as any, inputs);
        const term = await termRepo.get(tx, ctx, id as any);
        await auditRepo.record(tx, ctx, {
          action: 'fee_assignment.replace',
          entityType: 'term',
          entityId: id as any,
          before: { assignmentCount: existing.length },
          after: { assignmentCount: replaced.length, activeCount: replaced.filter((row) => row.status === 'ACTIVE').length },
          metadata: { requestId, termId: id },
        });
        return { rows: replaced, term };
      });
      return NextResponse.json({
        term: rows.term ? { id: rows.term.id, name: rows.term.name, status: rows.term.status, billed: rows.term.billed } : null,
        assignments: rows.rows.map((row) => serializeAssignment(row)),
      });
    } catch (error: any) {
      if (error instanceof RepoInvariantError) {
        return NextResponse.json({ error: { code: 'BAD_REQUEST', message: error.message } }, { status: 400 });
      }
      if (error?.code === '23505') {
        return NextResponse.json({ error: { code: 'CONFLICT', message: 'The fee matrix contains a duplicate assignment.' } }, { status: 409 });
      }
      if (error?.code === '23503') {
        return NextResponse.json({ error: { code: 'CONFLICT', message: 'A fee assignment is still referenced by a financial record.' } }, { status: 409 });
      }
      throw error;
    }
  },
);
