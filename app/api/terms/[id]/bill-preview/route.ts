/** GET /api/terms/:id/bill-preview — read-only controlled billing preview. */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute } from '@/lib/authz';
import * as billingRepo from '@/lib/db/repo/billing';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  // Review is intentionally available to anyone who can read terms. The
  // state-changing POST /bill is separately guarded by term.bill.
  { action: 'term.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid term id' } }, { status: 400 });
    }
    try {
      const preview = await billingRepo.previewTerm(db, ctx, id as any);
      return NextResponse.json({ preview: serializePreview(preview) });
    } catch (error) {
      if (error instanceof billingRepo.BillingError) {
        return NextResponse.json({ error: { code: error.billingCode, message: error.message, details: error.details } }, { status: error.status });
      }
      throw error;
    }
  },
);

function serializePreview(preview: billingRepo.BillingPreview) {
  return {
    ...preview,
    students: preview.students.map((student) => ({
      ...student,
      lines: student.lines.map((line) => ({ ...line })),
    })),
  };
}
