/**
 * /api/guardians/[id]
 *   GET    — one guardian, with the students they are linked to.
 *   PATCH  — update contact details.
 *   DELETE — soft-delete the guardian and remove their links.
 *
 * Authorization: `guardian.manage`.
 *
 * A guardian has NO financial authority; none of these operations can affect an
 * invoice, payment, allocation, receipt or reconciliation case. Contacts are not
 * ledger entities.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const PatchSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120).optional(),
    lastName: z.string().trim().min(1).max(120).optional(),
    // `.nullish()` so a school can deliberately CLEAR a wrong number, which is
    // a real workflow ("that number was the old house help's"). Clearing is
    // distinguishable from omitting: omit leaves the value, null removes it.
    phone: z.string().trim().max(32).nullish(),
    email: z.string().trim().toLowerCase().email().max(255).nullish(),
    address: z.string().trim().max(500).nullish(),
  })
  .strict();

export const GET = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const guardian = await guardianRepo.get(db, ctx, id as never);
    if (!guardian) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Guardian not found.', 404);
    const students = await guardianRepo.listStudentsForGuardian(db, ctx, id as never);
    return NextResponse.json({ guardian, students });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = PatchSchema.parse(body);
    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'guardian.update',
          path: `/api/guardians/${id}`,
          payload: { id, ...data },
        });
        if (idem.replay) return idem.replay;

        const before = await guardianRepo.get(tx, ctx, id as never);
        if (!before) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Guardian not found.', 404);

        const guardian = await guardianRepo.update(
          tx,
          ctx,
          id as never,
          {
            ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
            ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
            ...('phone' in data ? { phone: data.phone ?? null } : {}),
            ...('email' in data ? { email: data.email ?? null } : {}),
            ...(data.address !== undefined ? { address: data.address ?? null } : {}),
          } as never,
        );

        await auditRepo.record(tx, ctx, {
          action: 'guardian.update',
          entityType: 'guardian',
          entityId: guardian.id,
          before: {
            phone: before.phone,
            email: before.email,
            name: `${before.firstName} ${before.lastName}`,
          },
          after: {
            phone: guardian.phone,
            email: guardian.email,
            name: `${guardian.firstName} ${guardian.lastName}`,
          },
          metadata: { requestId },
        });

        const result = { guardian };
        await completeIdempotency(tx, ctx, idem.key, 200, result);
        return NextResponse.json(result);
      });
    } catch (e: unknown) {
      if (e instanceof AuthzError) throw e;
      const message = e instanceof Error ? e.message : 'Could not update guardian.';
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, message, 400);
    }
  },
);

/**
 * Soft-delete. The row and its audit history survive; only the current contact
 * list changes. Links are removed in the same transaction so a deleted guardian
 * can never resolve as a live reminder destination.
 */
export const DELETE = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'DELETE' },
  async (req, { db, ctx, requestId }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'guardian.delete',
        path: `/api/guardians/${id}`,
        payload: { id },
      });
      if (idem.replay) return idem.replay;

      const before = await guardianRepo.get(tx, ctx, id as never);
      if (!before) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Guardian not found.', 404);
      const linked = await guardianRepo.listStudentsForGuardian(tx, ctx, id as never);

      await guardianRepo.softDelete(tx, ctx, id as never);

      await auditRepo.record(tx, ctx, {
        action: 'guardian.delete',
        entityType: 'guardian',
        entityId: id,
        before: { name: `${before.firstName} ${before.lastName}`, phone: before.phone },
        after: { deleted: true, unlinkedStudentCount: linked.length },
        metadata: { requestId },
      });

      const result = { ok: true, unlinkedStudentCount: linked.length };
      await completeIdempotency(tx, ctx, idem.key, 200, result);
      return NextResponse.json(result);
    });
  },
);
