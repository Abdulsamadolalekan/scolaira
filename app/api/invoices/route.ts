/**
 * /api/invoices
 *   GET  — list (invoice.read). Returns a curated projection for the register.
 *   POST — create + issue a new invoice (invoice.create, invoice.issue).
 *          Transactional: verify student/term/session belong to tenant →
 *          create DRAFT invoice → insert lines → ISSUE → write audit event.
 *
 * All money amounts are kobo-precise integers. Idempotency via the
 * Idempotency-Key header is enforced on POST.
 */
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedRoute, assertResourceInOrg, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { invoices } from '@/lib/db/schema/financials';
import { students } from '@/lib/db/schema/academic';
import { terms } from '@/lib/db/schema/academic';
import * as invRepo from '@/lib/db/repo/invoices';
import * as lineRepo from '@/lib/db/repo/invoice-lines';
import * as studentRepo from '@/lib/db/repo/students';
import * as termRepo from '@/lib/db/repo/terms';
import * as sessionsRepo from '@/lib/db/repo/academic-sessions';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as idemRepo from '@/lib/db/repo/idempotency-keys';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import type { UUID } from '@/lib/db/repo/_context';
import type { Kobo } from '@/lib/money';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KoboInt = z.number().int().nonnegative();
const asKobo = (n: number) => n as Kobo;

const LineSchema = z.object({
  description: z.string().trim().min(1).max(255),
  quantity: z.number().int().positive().default(1),
  unitRateKobo: KoboInt,
  adjustmentKobo: z.number().int().default(0),
});

const CreateSchema = z.object({
  studentId: z.string().regex(UUID_RE),
  termId: z.string().regex(UUID_RE).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(1000).optional(),
  lines: z.array(LineSchema).min(1),
});

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

export const POST = withAuthorizedRoute(
  { action: 'invoice.create', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = CreateSchema.parse(body);

    // Idempotency: acquire/replay within a single transaction so we don't
    // double-create on retries.
    const idemKey = req.headers.get('idempotency-key')?.trim();
    return db.transaction(async (tx) => {
      if (idemKey) {
        const existing = await idemRepo.acquire(tx, ctx, {
          key: idemKey, scope: 'invoice.create', requestMethod: 'POST',
          requestPath: '/api/invoices', expiresAt: new Date(Date.now() + 24*60*60*1000),
        });
        if (existing && existing.responseStatus) {
          try {
            const parsed = (typeof existing.responseBody === "string" ? JSON.parse(existing.responseBody) : existing.responseBody);
            const resp = NextResponse.json(parsed, { status: existing.responseStatus });
            resp.headers.set('Idempotent-Replayed', 'true');
            return resp;
          } catch { /* fall through and recreate */ }
        }
      }

      // Validate student belongs to this tenant.
      const student = await studentRepo.get(tx, ctx, data.studentId as UUID);
      assertResourceInOrg(ctx, student, 'Student');

      // Resolve term: explicit or current.
      const term = data.termId
        ? await termRepo.get(tx, ctx, data.termId as UUID)
        : await termRepo.getCurrent(tx, ctx);
      if (!term) {
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          data.termId ? 'Term not found.' : 'No current term configured; specify termId explicitly.',
          400,
        );
      }
      assertResourceInOrg(ctx, term, 'Term');
      // Load the parent academic session from the term.
      const sess = await sessionsRepo.get(tx, ctx, term.sessionId as UUID);
      if (!sess) throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Term has no parent academic session.', 400);

      const totalLinesKobo = data.lines.reduce(
        (acc: number, l) => acc + Math.max(0, l.quantity * l.unitRateKobo + l.adjustmentKobo), 0,
      );
      if (totalLinesKobo <= 0) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invoice total must be greater than zero.', 400);
      }

      // Create draft, add lines, issue in one transaction.
      const draft = await invRepo.createDraft(tx, ctx, {
        studentId: data.studentId as UUID,
        termId: term.id,
        sessionId: sess.id,
        memo: data.memo ?? null,
      });
      await lineRepo.addLines(tx, ctx, draft.id, data.lines.map(l => ({
        description: l.description,
        quantity: l.quantity,
        unitRateKobo: asKobo(l.unitRateKobo),
        adjustmentKobo: l.adjustmentKobo,
        amountKobo: asKobo(Math.max(0, l.quantity * l.unitRateKobo + l.adjustmentKobo)),
      })));
      const issued = await invRepo.issue(tx, ctx, draft.id, { dueDate: data.dueDate });

      await auditRepo.record(tx, ctx, {
        action: 'invoice.create', entityType: 'invoice', entityId: issued.id,
        after: { invoiceNumber: issued.invoiceNumber, totalKobo: issued.totalKobo, studentId: issued.studentId },
        metadata: { requestId, lines: data.lines.length },
      });

      const response = {
        invoice: {
          id: issued.id,
          invoiceNumber: issued.invoiceNumber,
          status: issued.status,
          studentId: issued.studentId,
          termId: issued.termId,
          sessionId: issued.sessionId,
          dueDate: issued.dueDate,
          totalKobo: Number(issued.totalKobo),
          paidKobo: Number(issued.paidKobo),
        },
      };

      if (idemKey) {
        await idemRepo.complete(tx, ctx, idemKey, 201, response);
      }
      return NextResponse.json(response, { status: 201 });
    }).catch((e: unknown) => {
      if (e instanceof RepoInvariantError) {
        return NextResponse.json({ error: { code: 'BAD_REQUEST', message: e.message } }, { status: 400 });
      }
      throw e;
    });
  },
);
