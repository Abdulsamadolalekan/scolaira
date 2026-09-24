import { NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import {
  payments,
  paymentAllocations,
  invoices,
  students,
  reconciliationCases,
} from '@/lib/db/schema';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import { derivedKind } from '@/lib/reconciliation';
import type { UUID } from '@/lib/db/repo/_context';

export const runtime = 'nodejs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuthorizedRoute(
  { action: 'reconciliation.read', method: 'GET' },
  async (_req, { db, ctx }, params) => {
    const { id } = await (params as { params: Promise<{ id: string }> }).params;
    if (!UUID_RE.test(id))
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid payment id.' } },
        { status: 400 },
      );
    const paymentRows = await db
      .select({
        id: payments.id,
        paymentNumber: payments.paymentNumber,
        status: payments.status,
        method: payments.method,
        amountKobo: payments.amountKobo,
        unallocatedKobo: payments.unallocatedKobo,
        reference: payments.reference,
        payerName: payments.payerName,
        payerPhone: payments.payerPhone,
        payerEmail: payments.payerEmail,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(eq(payments.id, id as UUID), eq(payments.organizationId, ctx.organizationId)))
      .limit(1);
    const payment = paymentRows[0];
    if (!payment)
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Payment not found.' } },
        { status: 404 },
      );

    const caseRows = await db
      .select()
      .from(reconciliationCases)
      .where(
        and(
          eq(reconciliationCases.organizationId, ctx.organizationId),
          eq(reconciliationCases.paymentId, id as UUID),
        ),
      )
      .orderBy(desc(reconciliationCases.createdAt), desc(reconciliationCases.id));
    // A closed case is history, not the current work item. Financial state can
    // legitimately create new reconciliation work after a prior close (for
    // example, a reversal can restore an unallocated balance), so prefer the
    // open case and otherwise expose the derived current state below.
    const caseRow = caseRows.find((row) => row.closedAt === null) ?? null;
    const hasDerivedWork =
      payment.status === 'PENDING' ||
      payment.status === 'DUPLICATE_SUSPECT' ||
      (payment.status === 'CONFIRMED' && Number(payment.unallocatedKobo) > 0);
    const related = caseRow
      ? {
          evidence: await reconciliationRepo.listEvidence(db, ctx, caseRow.id),
          candidates: await reconciliationRepo.listCandidates(db, ctx, caseRow.id),
        }
      : { evidence: [], candidates: [] };

    const allocations = await db
      .select({
        id: paymentAllocations.id,
        invoiceId: paymentAllocations.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        studentId: invoices.studentId,
        studentName:
          sql<string>`trim(coalesce(${students.firstName}, '') || ' ' || coalesce(${students.lastName}, ''))`.as(
            'student_name',
          ),
        amountKobo: paymentAllocations.amountKobo,
        status: paymentAllocations.status,
        allocatedAt: paymentAllocations.allocatedAt,
        note: paymentAllocations.note,
      })
      .from(paymentAllocations)
      .innerJoin(
        invoices,
        and(
          eq(invoices.id, paymentAllocations.invoiceId),
          eq(invoices.organizationId, paymentAllocations.organizationId),
        ),
      )
      .innerJoin(
        students,
        and(
          eq(students.id, invoices.studentId),
          eq(students.organizationId, paymentAllocations.organizationId),
        ),
      )
      .where(
        and(
          eq(paymentAllocations.organizationId, ctx.organizationId),
          eq(paymentAllocations.paymentId, id as UUID),
        ),
      )
      .orderBy(desc(paymentAllocations.allocatedAt), desc(paymentAllocations.id));

    // H-2/M-6: this payload merges the payment's own history with every case
    // thread's history and shows the newest 100. That merge is a capped list, so
    // it now reports how many events exist across its sources and how many
    // sources were themselves truncated — instead of looking complete.
    const AUDIT_MERGE_LIMIT = 100;
    const [paymentAudit, caseAudits] = await Promise.all([
      auditRepo.listForEntityPage(db, ctx, 'payment', id as UUID, { limit: 100 }),
      Promise.all(
        caseRows.map((row) =>
          auditRepo.listForEntityPage(db, ctx, 'reconciliation_case', row.id, { limit: 100 }),
        ),
      ),
    ]);
    const auditSources = [paymentAudit, ...caseAudits];
    const audit = auditSources
      .flatMap((source) => source.rows)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, AUDIT_MERGE_LIMIT);
    const auditTotal = auditSources.reduce((sum, source) => sum + source.total, 0);
    const auditTruncatedSources = auditSources.filter((source) => source.hasMore).length;

    return NextResponse.json({
      payment: {
        ...payment,
        amountKobo: Number(payment.amountKobo),
        unallocatedKobo: Number(payment.unallocatedKobo),
        paidAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : null,
        createdAt: new Date(payment.createdAt).toISOString(),
      },
      auditPage: {
        limit: AUDIT_MERGE_LIMIT,
        returned: audit.length,
        total: auditTotal,
        hasMore: auditSources.some((source) => source.hasMore) || auditTotal > audit.length,
        truncatedSources: auditTruncatedSources,
      },
      reconciliation: caseRow
        ? {
            case: caseRow,
            evidence: related.evidence,
            candidates: related.candidates,
            history: caseRows
              .filter((prior) => prior.id !== caseRow.id)
              .map((prior) => ({
                id: prior.id,
                state: prior.state,
                kind: prior.kind,
                reason: prior.reason,
                resolutionCode: prior.resolutionCode,
                createdBy: prior.createdBy,
                resolvedBy: prior.resolvedBy,
                resolvedAt: prior.resolvedAt,
                closedAt: prior.closedAt,
                createdAt: prior.createdAt,
              })),
          }
        : {
            case: null,
            derived: hasDerivedWork
              ? {
                  state: 'UNMATCHED',
                  kind: derivedKind(payment.status, Number(payment.unallocatedKobo)),
                }
              : null,
            evidence: [],
            candidates: [],
            history: caseRows.map((prior) => ({
              id: prior.id,
              state: prior.state,
              kind: prior.kind,
              reason: prior.reason,
              resolutionCode: prior.resolutionCode,
              createdBy: prior.createdBy,
              resolvedBy: prior.resolvedBy,
              resolvedAt: prior.resolvedAt,
              closedAt: prior.closedAt,
              createdAt: prior.createdAt,
            })),
          },
      allocations: allocations.map((row) => ({
        ...row,
        amountKobo: Number(row.amountKobo),
        allocatedAt: row.allocatedAt ? new Date(row.allocatedAt).toISOString() : null,
      })),
      audit,
    });
  },
);
