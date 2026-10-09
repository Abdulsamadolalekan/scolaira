/**
 * /api/students/[id]/guardians
 *   GET  — the guardians linked to this student, primary first.
 *   POST — attach a guardian, either an existing one or a brand-new one.
 *
 * Authorization: `guardian.manage`.
 *
 * WHY ONE ENDPOINT DOES BOTH
 *   The common real action is not "create a guardian" or "link a guardian" — it
 *   is "this child's mother, here is her number". Making the school create a
 *   guardian in one screen and then hunt for them in a picker is the kind of
 *   two-step that causes exactly the data-entry the audit found missing. So the
 *   body is discriminated:
 *
 *     { guardianId, relationship?, isPrimary? }              → link existing
 *     { firstName, lastName, phone?, email?, … }             → create AND link
 *
 *   Both paths run in ONE transaction, so a failure leaves neither a guardian
 *   with no student nor a student with no guardian.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as studentRepo from '@/lib/db/repo/students';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

const RelationshipEnum = z.enum(['PARENT', 'GUARDIAN', 'SPONSOR', 'OTHER']);

const LinkSchema = z
  .object({
    guardianId: z.string().uuid(),
    relationship: RelationshipEnum.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

// Create-and-link in one step. Guardian fields sit at the top level so the form
// can post a flat object.
const CreateAndLinkSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    address: z.string().trim().max(500).optional(),
    relationship: RelationshipEnum.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

const PostSchema = z.union([LinkSchema, CreateAndLinkSchema]);

/** Which of the two bodies did we get? Discriminated by the presence of an id. */
function isLinkBody(b: z.infer<typeof PostSchema>): b is z.infer<typeof LinkSchema> {
  return typeof (b as { guardianId?: unknown }).guardianId === 'string';
}

export const GET = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const student = await studentRepo.get(db, ctx, id as never);
    if (!student) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);

    const guardianList = await guardianRepo.listForStudent(db, ctx, id as never);
    const primary = await guardianRepo.resolvePrimaryContact(db, ctx, id as never);

    return NextResponse.json({
      guardians: guardianList,
      // The single field a collection workflow needs. Null means "we have nobody
      // to contact", which the UI must say plainly rather than leave to a blank
      // column.
      primaryContact: primary,
      hasReachableContact: Boolean(primary && guardianRepo.hasContact(primary)),
    });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'POST', bodySchema: PostSchema },
  async (req, { db, ctx, requestId, body }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    const data = PostSchema.parse(body);

    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'guardian.link',
        path: `/api/students/${id}/guardians`,
        payload: data,
      });
      if (idem.replay) return idem.replay;

      // The student must be in this org and not deleted. Verified inside the
      // transaction so the check and the write cannot drift apart.
      const student = await studentRepo.get(tx, ctx, id as never);
      if (!student) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Student not found.', 404);

      let guardianId: string;
      let created = false;

      if (isLinkBody(data)) {
        const existing = await guardianRepo.get(tx, ctx, data.guardianId as never);
        if (!existing) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Guardian not found.', 404);
        guardianId = existing.id;
      } else {
        const guardian = await guardianRepo.create(tx, ctx, {
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone ?? null,
          email: data.email ?? null,
          address: data.address ?? null,
        });
        guardianId = guardian.id;
        created = true;
      }

      const link = await guardianRepo.link(tx, ctx, {
        studentId: student.id,
        guardianId: guardianId as never,
        relationship: data.relationship ?? 'PARENT',
        isPrimary: data.isPrimary ?? false,
      });

      await auditRepo.record(tx, ctx, {
        action: created ? 'guardian.create_link' : 'guardian.link',
        entityType: 'student_guardian',
        entityId: link.id,
        after: {
          studentId: student.id,
          guardianId,
          relationship: link.relationship,
          isPrimary: link.isPrimary,
        },
        metadata: { requestId, createdInSameStep: created },
      });

      const guardians = await guardianRepo.listForStudent(tx, ctx, student.id);

      // If this is the student's FIRST guardian, make them primary automatically.
      // A student with one guardian and no primary is a state that only creates
      // ambiguity later, when a reminder has to pick someone.
      if (!data.isPrimary && guardians.length === 1) {
        await guardianRepo.setPrimary(tx, ctx, {
          studentId: student.id,
          guardianId: guardianId as never,
        });
        await auditRepo.record(tx, ctx, {
          action: 'guardian.set_primary',
          entityType: 'student_guardian',
          entityId: link.id,
          after: { studentId: student.id, guardianId, reason: 'first_guardian_on_student' },
          metadata: { requestId, automatic: true },
        });
      }

      const finalList = await guardianRepo.listForStudent(tx, ctx, student.id);
      const result = { guardians: finalList, linkId: link.id };
      await completeIdempotency(tx, ctx, idem.key, 201, result);
      return NextResponse.json(result, { status: 201 });
    });
  },
);
