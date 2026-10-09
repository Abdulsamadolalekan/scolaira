/**
 * GET /api/debtors — the aging workbench for the current tenant.
 *
 * H-2 contract, all four parts declared in the payload:
 *
 *   * SCOPE — the queue is ALL_TERM by definition (arrears are arrears, whatever
 *     term billed them) and the payload says so, with the cut-over term used for
 *     the prior-term classification.
 *   * TOTALS — computed by the database over every matching row (`debtorTotals`),
 *     never by summing the returned page. Before H-2 this route looped its capped
 *     page, so 501 debtors were reported as 500 with a short outstanding total.
 *   * PAGINATION — declared cap (500), `limit`, opaque keyset `cursor`, `total`,
 *     `returned`, `hasMore`, `nextCursor`.
 *   * STALENESS — each row carries its last reminder classified against the
 *     shared thresholds, and the thresholds themselves are echoed here, so a
 *     client can label "stale" exactly the way the server decided it.
 *
 * Financial numbers come from the same trigger-maintained columns
 * (invoices.total_kobo/paid_kobo) used by the dashboard and the invoice list —
 * there is no parallel AR ledger.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as reminderRepo from '@/lib/db/repo/reminders';
import * as scopingRepo from '@/lib/db/repo/scoping';
import { SURFACE_LIMITS, resolveLimit } from '@/lib/db/repo/pagination';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export type DebtorSummary = {
  students: Array<{
    studentId: string;
    studentIdCode: string;
    studentName: string;
    className: string | null;
    primaryGuardianName: string | null;
    primaryGuardianPhone: string | null;
    outstandingKobo: number;
    overdueKobo: number;
    oldestOverdueDays: number;
    oldestDueDate: string | null;
    openInvoiceCount: number;
    lastReminderAt: string | null;
    agingBucket: 'CURRENT' | 'DUE_SOON' | 'OVERDUE_30' | 'OVERDUE_60' | 'OVERDUE_90' | 'SEVERE';
    reminderStaleness: 'NONE' | 'FRESH' | 'STALE' | 'UNATTENDED';
    daysSinceReminder: number | null;
  }>;
  totals: { outstandingKobo: number; overdueKobo: number; severeCount: number; debtorCount: number };
  asOf: string;
};

export const GET = withAuthorizedRoute(
  { action: 'debtor.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, ctx, query }) => {
    const filters = (query ?? {}) as z.infer<typeof QuerySchema>;
    const surface = SURFACE_LIMITS.debtors;
    const limit = resolveLimit(surface, filters.limit ?? null);
    try {
      const [{ rows, page }, totals, scope] = await Promise.all([
        reminderRepo.listDebtorsPage(db, ctx, { limit, cursor: filters.cursor ?? null }),
        reminderRepo.debtorTotals(db, ctx),
        scopingRepo.getInvoiceScopeDeclaration(db, ctx),
      ]);
      return NextResponse.json({
        students: rows,
        totals,
        page,
        thresholds: reminderRepo.debtorThresholdsPayload(),
        scope: {
          scope: 'ALL_TERM',
          label: scopingRepo.INVOICE_SCOPE_LABELS.ALL_TERM,
          termId: scope.termId,
          termName: scope.termName,
          cutoverOn: scope.cutoverOn,
          asOf: scope.asOf,
        },
        asOf: new Date().toISOString(),
      } satisfies DebtorSummary & { page: unknown; thresholds: unknown; scope: unknown });
    } catch (e: any) {
      if (e instanceof AuthzError) throw e;
      if (e?.message === 'Invalid cursor.' || String(e?.message ?? '').startsWith('Cursor does not belong')) {
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, String(e.message), 400);
      }
      throw e;
    }
  },
);
