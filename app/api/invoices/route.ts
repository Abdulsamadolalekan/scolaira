/** GET /api/invoices — list invoices (invoice.read). Demonstrates financial read authorization. */
import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { invoices } from '@/lib/db/schema';

export const GET = withAuthorizedRoute(
  { action: 'invoice.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    // RLS already scopes reads to org; we additionally pass organizationId
    // explicitly (defense in depth). Project a safe column set.
    const rows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        studentId: invoices.studentId,
        termId: invoices.termId,
        dueDate: invoices.dueDate,
        issuedAt: invoices.issuedAt,
        totalKobo: invoices.totalKobo,
        paidKobo: invoices.paidKobo,
      })
      .from(invoices)
      .where(eq(invoices.organizationId, ctx.organizationId))
      .orderBy(desc(invoices.issuedAt));
    return NextResponse.json({ invoices: rows });
  },
);
