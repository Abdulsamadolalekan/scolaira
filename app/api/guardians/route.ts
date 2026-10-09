/**
 * /api/guardians
 *   GET  — list the organization's guardians.
 *   POST — create a guardian.
 *
 * Authorization: `guardian.manage` (OWNER, SCHOOL_ADMIN, FINANCE_OFFICER —
 * already granted in lib/authz/permissions.ts; no policy change was needed).
 *
 * Tenant isolation is not re-implemented here. `withAuthorizedRoute` sets the
 * tenant GUC and the `guardians_tenant_isolation` RLS policy (USING + WITH CHECK)
 * enforces it at the database. Every query in the repo additionally scopes by
 * `ctx.organizationId`, so isolation holds even with RLS bypassed.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';

export const runtime = 'nodejs';

// Nigerian numbers arrive as 0803…, +234803…, 234 803 …; we normalise rather than
// reject, so a school is never blocked by punctuation. Email is optional because
// many parents have none — phone is the channel that matters for a fee reminder.
const CreateSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  address: z.string().trim().max(500).optional(),
});

export const GET = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await guardianRepo.listForOrg(db, ctx);
    return NextResponse.json({
      guardians: rows,
      // Reported, never assumed: the surfaces that need a destination read this
      // rather than discovering at send time that a guardian has no phone.
      total: rows.length,
      withoutContact: rows.filter((g) => !guardianRepo.hasContact(g)).length,
    });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'guardian.manage', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = CreateSchema.parse(body);
    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'guardian.create',
          path: '/api/guardians',
          payload: data,
        });
        if (idem.replay) return idem.replay;

        const guardian = await guardianRepo.create(tx, ctx, {
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone ?? null,
          email: data.email ?? null,
          address: data.address ?? null,
        });

        await auditRepo.record(tx, ctx, {
          action: 'guardian.create',
          entityType: 'guardian',
          entityId: guardian.id,
          after: {
            name: `${guardian.firstName} ${guardian.lastName}`,
            hasPhone: Boolean(guardian.phone),
            hasEmail: Boolean(guardian.email),
          },
          metadata: { requestId },
        });

        const result = { guardian };
        await completeIdempotency(tx, ctx, idem.key, 201, result);
        return NextResponse.json(result, { status: 201 });
      });
    } catch (e: unknown) {
      if (e instanceof AuthzError) throw e;
      const message = e instanceof Error ? e.message : 'Could not create guardian.';
      throw new AuthzError(AuthzErrorCode.BAD_REQUEST, message, 400);
    }
  },
);
