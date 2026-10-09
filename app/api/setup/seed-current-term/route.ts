/**
 * POST /api/setup/seed-current-term — internal-only test/dev helper to stand up
 * a minimal academic scaffolding (session + term marked current) so invoices
 * have a valid parent session/term. Guarded: only available when NODE_ENV !==
 * 'production', and restricted to org owners.
 *
 * This is NOT a production endpoint; it exists because the E2E lifecycle test
 * needs a deterministic academic skeleton and we will not ship an academic-
 * setup UI in M5.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as termRepo from '@/lib/db/repo/terms';
import { academicSessions, terms } from '@/lib/db/schema/academic';

export const runtime = 'nodejs';

const EmptySchema = z.object({}).optional();

export const POST = withAuthorizedRoute(
  { action: 'academic_session.manage', method: 'POST', bodySchema: EmptySchema },
  async (_req, { db, ctx }) => {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
    }
    const existing = await sessionRepo.getCurrent(db, ctx);
    const existingTerm = await termRepo.getCurrent(db, ctx);
    if (existing && existingTerm) {
      return NextResponse.json({ session: existing, term: existingTerm, idempotent: true });
    }
    if (!existing) {
      // Mark any prior current sessions non-current first.
      await db.update(academicSessions).set({ isCurrent: false }).where(eq(academicSessions.organizationId, ctx.organizationId));
    }
    const y = new Date().getFullYear();
    const sess = existing ?? await sessionRepo.create(db, ctx, {
      name: `${y}/${y+1}`,
      startsOn: `${y}-09-01`,
      endsOn: `${y+1}-07-31`,
      isCurrent: true,
      status: 'ACTIVE',
    } as any);
    await db.update(terms).set({ isCurrent: false }).where(eq(terms.organizationId, ctx.organizationId));
    const term = existingTerm ?? await termRepo.create(db, ctx, {
      sessionId: sess.id,
      name: 'First Term',
      label: '1st',
      startsOn: `${y}-09-08`,
      endsOn: `${y}-12-15`,
      dueDate: `${y}-12-01`,
      isCurrent: true,
      billed: false,
      status: 'ACTIVE',
    } as any);
    return NextResponse.json({ session: sess, term });
  },
);
