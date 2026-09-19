/**
 * GET /api/debtors — Aging workbench for the current tenant.
 *
 * Returns one row per ACTIVE student with an outstanding balance, ranked by
 * oldest overdue date then overdue amount. Financial numbers come from the
 * same trigger-maintained columns (invoices.total_kobo/paid_kobo) used on
 * the dashboard and invoice list — there is no parallel AR ledger.
 */
import { NextResponse } from 'next/server';
import { withAuthorizedRoute } from '@/lib/authz';
import * as reminderRepo from '@/lib/db/repo/reminders';

export const runtime = 'nodejs';

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
  }>;
  totals: { outstandingKobo: number; overdueKobo: number; severeCount: number; debtorCount: number };
};

export const GET = withAuthorizedRoute(
  { action: 'debtor.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const debtors = await reminderRepo.listDebtors(db, ctx);
    let outstandingKobo = 0, overdueKobo = 0, severeCount = 0;
    for (const d of debtors) {
      outstandingKobo += d.outstandingKobo;
      overdueKobo += d.overdueKobo;
      if (d.agingBucket === 'SEVERE' || d.agingBucket === 'OVERDUE_90') severeCount++;
    }
    return NextResponse.json({
      students: debtors,
      totals: {
        outstandingKobo,
        overdueKobo,
        severeCount,
        debtorCount: debtors.length,
      },
    } satisfies DebtorSummary);
  },
);
