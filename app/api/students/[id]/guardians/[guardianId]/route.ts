/**
 * /api/students/[id]/guardians/[guardianId]
 *   PATCH  — change the relationship, or make this guardian the primary contact.
 *   DELETE — unlink (the guardian record itself survives).
 *
 * Authorization: `guardian.manage`.
 *
 * Making a guardian primary is exclusive: the repo clears any previous primary
 * for that student inside the same transaction, so the UI can never render two
 * primaries and a reminder can never have to choose between them.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const PatchSchema = z
  .object({
    relationship: z.enum(['PARENT', 'GUARDIAN', 'SPONSOR', 'OTHER']).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export const PATCH = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'PATCH', bodySchema: PatchSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id, guardianId } = await (
      params as { params: Promise<{ id: string; guardianId: string }> }
    ).params;
    const data = PatchSchema.parse(body);

    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'guardian.link.update',
        path: `/api/students/${id}/guardians/${guardianId}`,
        payload: data,
      });
      if (idem.replay) return idem.replay;

      const student = await studentRepo.get(tx, ctx, id as never);
      if (!student) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);

      // Both operations verify the link exists and belongs to this student in
      // this org; neither trusts the ids it was handed.
      const existing = await guardianRepo.listForStudent(tx, ctx, student.id);
      const link = existing.find((g) => g.id === guardianId);
      if (!link)
        throw new AuthzError(
          AuthzErrorCode.NOT_FOUND,
          'That guardian is not linked to this student.',
          404,
        );

      if (data.isPrimary) {
        await guardianRepo.setPrimary(tx, ctx, {
          studentId: student.id,
          guardianId: guardianId as never,
        });
      }

      if (data.relationship && data.relationship !== link.relationship) {
        await guardianRepo.link(tx, ctx, {
          studentId: student.id,
          guardianId: guardianId as never,
          relationship: data.relationship,
          isPrimary: data.isPrimary ?? link.isPrimary,
        });
      }

      await auditRepo.record(tx, ctx, {
        action: 'guardian.link.update',
        entityType: 'student_guardian',
        entityId: link.linkId,
        before: { relationship: link.relationship, isPrimary: link.isPrimary },
        after: {
          relationship: data.relationship ?? link.relationship,
          isPrimary: data.isPrimary ?? link.isPrimary,
        },
        metadata: { requestId },
      });

      const guardians = await guardianRepo.listForStudent(tx, ctx, student.id);
      const result = { guardians };
      await completeIdempotency(tx, ctx, idem.key, 200, result);
      return NextResponse.json(result);
    });
  },
);

export const DELETE = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'DELETE' },
  async (req, { db, ctx, requestId }, params) => {
    const { id, guardianId } = await (
      params as { params: Promise<{ id: string; guardianId: string }> }
    ).params;

    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'guardian.unlink',
        path: `/api/students/${id}/guardians/${guardianId}`,
        payload: { id, guardianId },
      });
      if (idem.replay) return idem.replay;

      const student = await studentRepo.get(tx, ctx, id as never);
      if (!student) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);

      const before = await guardianRepo.listForStudent(tx, ctx, student.id);
      const link = before.find((g) => g.id === guardianId);
      if (!link)
        throw new AuthzError(
          AuthzErrorCode.NOT_FOUND,
          'That guardian is not linked to this student.',
          404,
        );

      await guardianRepo.unlink(tx, ctx, {
        studentId: student.id,
        guardianId: guardianId as never,
      });

      // If we removed the primary and others remain, promote the longest-standing
      // one so the student is never left with guardians but no primary contact.
      let promoted: string | null = null;
      if (link.isPrimary) {
        const remaining = await guardianRepo.listForStudent(tx, ctx, student.id);
        if (remaining.length > 0) {
          await guardianRepo.setPrimary(tx, ctx, {
            studentId: student.id,
            guardianId: remaining[0]!.id as never,
          });
          promoted = remaining[0]!.id;
        }
      }

      await auditRepo.record(tx, ctx, {
        action: 'guardian.unlink',
        entityType: 'student_guardian',
        entityId: link.linkId,
        before: { guardianId, relationship: link.relationship, isPrimary: link.isPrimary },
        after: { unlinked: true, promotedGuardianId: promoted },
        metadata: { requestId },
      });

      const guardians = await guardianRepo.listForStudent(tx, ctx, student.id);
      const result = { guardians, promotedGuardianId: promoted };
      await completeIdempotency(tx, ctx, idem.key, 200, result);
      return NextResponse.json(result);
    });
  },
);
