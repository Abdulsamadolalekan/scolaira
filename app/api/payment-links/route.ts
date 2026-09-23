/**
 * Payment link management API.
 *
 * Lists links for the tenant and creates new ones with a cryptographically
 * random opaque token. The public payer page lives at /p/[token] and does NOT
 * run fake PSP processing — it explains bank-transfer options so the school
 * can reconcile manually.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { desc, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute, assertResourceInOrg } from '@/lib/authz';
import * as linkRepo from '@/lib/db/repo/payment-links';
import * as studentRepo from '@/lib/db/repo/students';
import * as invRepo from '@/lib/db/repo/invoices';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { paymentLinks, students, invoices } from '@/lib/db/schema';
import { kobo as asKobo } from '@/lib/money';

export const runtime = 'nodejs';

const CreateSchema = z.object({
  invoiceId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  amountKobo: z.number().int().nonnegative().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  note: z.string().max(500).optional(),
});

const studentName = sql<string>`trim(coalesce(${students.firstName},'') || ' ' || coalesce(${students.lastName},''))`.as('student_name');

export const GET = withAuthorizedRoute(
  { action: 'payment_link.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const rows = await db.select({
      id: paymentLinks.id,
      token: paymentLinks.token,
      status: paymentLinks.status,
      amountKobo: paymentLinks.amountKobo,
      expiresAt: paymentLinks.expiresAt,
      note: paymentLinks.note,
      createdAt: paymentLinks.createdAt,
      invoiceId: paymentLinks.invoiceId,
      studentId: paymentLinks.studentId,
      invoiceNumber: invoices.invoiceNumber,
      studentName,
    })
      .from(paymentLinks)
      .leftJoin(invoices, eq(invoices.id, paymentLinks.invoiceId))
      .leftJoin(students, eq(students.id, paymentLinks.studentId))
      .where(eq(paymentLinks.organizationId, ctx.organizationId))
      .orderBy(desc(paymentLinks.createdAt))
      .limit(100);

    return NextResponse.json({ links: rows.map(r => ({
      id: r.id, token: r.token, status: r.status, amountKobo: r.amountKobo ? Number(r.amountKobo) : null,
      expiresAt: r.expiresAt, note: r.note, createdAt: r.createdAt,
      invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber,
      studentId: r.studentId, studentName: r.studentName,
      url: `/p/${r.token}`,
    }))});
  },
);

export const POST = withAuthorizedRoute(
  { action: 'payment_link.create', method: 'POST', bodySchema: CreateSchema },
  async (_req, { db, ctx, requestId, body }) => {
    const data = CreateSchema.parse(body);
    if (!data.invoiceId && !data.studentId) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'A payment link must reference an invoice or a student.' } }, { status: 400 });
    }
    if (data.invoiceId) {
      const inv = await invRepo.get(db, ctx, data.invoiceId as any);
      assertResourceInOrg(ctx, inv, 'Invoice');
    }
    if (data.studentId) {
      const stu = await studentRepo.get(db, ctx, data.studentId as any);
      assertResourceInOrg(ctx, stu, 'Student');
    }
    const token = nanoid(24);
    const expiresAt = data.expiresInDays ? new Date(Date.now() + data.expiresInDays*24*60*60*1000) : null;
    const link = await linkRepo.create(db, ctx, {
      token,
      invoiceId: data.invoiceId as any,
      studentId: data.studentId as any,
      amountKobo: data.amountKobo != null ? asKobo(data.amountKobo) : null,
      expiresAt,
      note: data.note,
    });
    await auditRepo.record(db, ctx, {
      action: 'payment_link.create', entityType: 'payment_link', entityId: link.id,
      // R3 (H-3): the audit trail records the link's IDENTIFIER, never the
      // bearer secret. The token is a credential: the moment it is written to an
      // append-only row, every backup, replica, log export and support dump of
      // that row is a live link. The link id answers "which link was created"
      // without being usable by anyone who reads it.
      after: {
        linkId: link.id,
        invoiceId: link.invoiceId,
        studentId: link.studentId,
        amountKobo: link.amountKobo === null ? null : Number(link.amountKobo),
        expiresAt: link.expiresAt,
      },
      metadata: { requestId },
    });
    return NextResponse.json({ link: { id: link.id, token: link.token, url: `/p/${link.token}` } }, { status: 201 });
  },
);
