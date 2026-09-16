/** GET /api/invoices — list invoices (invoice.read), with kobo-precise summary & human fields. */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { invoices } from '@/lib/db/schema/financials';
import { students } from '@/lib/db/schema/academic';
import { terms } from '@/lib/db/schema/academic';

export type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
  studentId: string;
  studentName: string;
  studentCode: string;
  termName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalKobo: number;
  paidKobo: number;
  remainingKobo: number;
  isOverdue: boolean;
  daysOverdue: number;
};

const fmtDate = (d: Date | string | null): string | null => {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d + 'T00:00:00Z') : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export const GET = withAuthorizedRoute(
  { action: 'invoice.read', method: 'GET' },
  async (req, { db, ctx }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get('status');

    const where = [eq(invoices.organizationId, ctx.organizationId)] as any[];
    if (status && ['DRAFT','ISSUED','PARTIALLY_PAID','PAID','VOID'].includes(status)) {
      where.push(eq(invoices.status, status as any));
    }

    const rows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        studentId: invoices.studentId,
        studentFirstName: students.firstName,
        studentLastName: students.lastName,
        studentCode: students.studentId,
        termName: terms.name,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalKobo: invoices.totalKobo,
        paidKobo: invoices.paidKobo,
      })
      .from(invoices)
      .leftJoin(students, eq(students.id, invoices.studentId))
      .leftJoin(terms, eq(terms.id, invoices.termId))
      .where(and(...where))
      .orderBy(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt}) desc`)
      .limit(200);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const result: InvoiceRow[] = rows.map((r: any) => {
      const total = Number(r.totalKobo) || 0;
      const paid = Number(r.paidKobo) || 0;
      const remaining = Math.max(0, total - paid);
      let daysOverdue = 0;
      let isOverdue = false;
      if (r.dueDate && (r.status === 'ISSUED' || r.status === 'PARTIALLY_PAID') && remaining > 0) {
        const due = new Date(r.dueDate + 'T00:00:00Z');
        const diff = Math.ceil((today.getTime() - due.getTime()) / 86400000);
        daysOverdue = Math.max(0, diff);
        isOverdue = daysOverdue > 0;
      }
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        studentId: r.studentId,
        studentName: [r.studentFirstName, r.studentLastName].filter(Boolean).join(' ').trim() || '—',
        studentCode: r.studentCode || '',
        termName: r.termName ?? null,
        issueDate: fmtDate(r.issueDate),
        dueDate: fmtDate(r.dueDate),
        totalKobo: total,
        paidKobo: paid,
        remainingKobo: remaining,
        isOverdue, daysOverdue,
      };
    });

    return NextResponse.json({ invoices: result });
  },
);
