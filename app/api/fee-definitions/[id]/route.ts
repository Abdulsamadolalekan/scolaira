/** PATCH /api/fee-definitions/:id — update or archive a reusable fee definition. */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import * as feeRepo from '@/lib/db/repo/fee-definitions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PatchSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/).transform((value) => value.toUpperCase()).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  defaultAmountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  isActive: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const PATCH = withAuthorizedRoute(
  { action: 'fee_definition.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (_req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid fee definition id' } }, { status: 400 });
    }
    const data = body as z.infer<typeof PatchSchema>;
    try {
      const updated = await db.transaction(async (tx) => {
        const before = await feeRepo.get(tx, ctx, id as any);
        if (!before) return null;
        const row = await feeRepo.update(tx, ctx, id as any, data);
        if (!row) return null;
        await auditRepo.record(tx, ctx, {
          action: data.isActive === false ? 'fee_definition.archive' : 'fee_definition.update',
          entityType: 'fee_definition',
          entityId: row.id,
          before: { code: before.code, name: before.name, defaultAmountKobo: Number(before.defaultAmountKobo), isActive: before.isActive },
          after: { code: row.code, name: row.name, defaultAmountKobo: Number(row.defaultAmountKobo), isActive: row.isActive },
          metadata: { requestId },
        });
        return row;
      });
      if (!updated) {
        return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Fee definition not found' } }, { status: 404 });
      }
      return NextResponse.json({ feeDefinition: serializeFee(updated) });
    } catch (error: any) {
      if (error instanceof RepoInvariantError) {
        return NextResponse.json({ error: { code: 'BAD_REQUEST', message: error.message } }, { status: 400 });
      }
      if (error?.code === '23505') {
        return NextResponse.json({ error: { code: 'CONFLICT', message: 'A fee with this code already exists.' } }, { status: 409 });
      }
      throw error;
    }
  },
);

function serializeFee(fee: feeRepo.FeeDefinition) {
  return {
    id: fee.id,
    code: fee.code,
    name: fee.name,
    description: fee.description,
    defaultAmountKobo: Number(fee.defaultAmountKobo),
    isActive: fee.isActive,
    createdAt: fee.createdAt,
    updatedAt: fee.updatedAt,
  };
}
