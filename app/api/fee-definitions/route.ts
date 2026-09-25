/**
 * Fee-definition catalog.
 *
 * The catalog is configuration, not a financial ledger. A term assignment
 * snapshots the authoritative amount used by the controlled bill run.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import * as feeRepo from '@/lib/db/repo/fee-definitions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { RepoInvariantError } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  defaultAmountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const GET = withAuthorizedRoute(
  { action: 'fee_definition.manage', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await feeRepo.listForOrg(db, ctx);
    return NextResponse.json({
      feeDefinitions: rows.map((fee) => ({
        id: fee.id,
        code: fee.code,
        name: fee.name,
        description: fee.description,
        defaultAmountKobo: Number(fee.defaultAmountKobo),
        isActive: fee.isActive,
        createdAt: fee.createdAt,
        updatedAt: fee.updatedAt,
      })),
    });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'fee_definition.manage', method: 'POST', bodySchema: CreateSchema },
  async (_req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof CreateSchema>;
    try {
      const fee = await db.transaction(async (tx) => {
        const created = await feeRepo.create(tx, ctx, {
          code: data.code,
          name: data.name,
          description: data.description ?? null,
          defaultAmountKobo: data.defaultAmountKobo,
          isActive: true,
        });
        await auditRepo.record(tx, ctx, {
          action: 'fee_definition.create',
          entityType: 'fee_definition',
          entityId: created.id,
          after: { code: created.code, name: created.name, defaultAmountKobo: Number(created.defaultAmountKobo) },
          metadata: { requestId },
        });
        return created;
      });
      return NextResponse.json({ feeDefinition: serializeFee(fee) }, { status: 201 });
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

export { UUID_RE };
