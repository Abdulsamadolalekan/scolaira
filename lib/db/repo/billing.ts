/**
 * Controlled term billing repository.
 *
 * This is the only place that turns fee assignments + active enrollments into
 * issued obligations. It never writes total_kobo or paid_kobo directly: every
 * result is an ordinary invoice, ordinary invoice_lines, and (when applicable)
 * an ordinary immutable waiver attached to a draft line before issuance.
 */
import { sql } from 'drizzle-orm';
import { waivers } from '../schema';
import { waiverReasonEnum } from '../schema/enums';
import type { Term } from './terms';
import * as termRepo from './terms';
import * as invRepo from './invoices';
import * as lineRepo from './invoice-lines';
import * as auditRepo from './audit-events';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';

export type WaiverReason = (typeof waiverReasonEnum.enumValues)[number];

export interface WaiverOverrideInput {
  studentId: UUID;
  feeAssignmentId: UUID;
  amountKobo: number;
  reason: WaiverReason;
  note?: string | null;
}

export interface BillingPreviewLine {
  feeAssignmentId: UUID;
  feeDefinitionId: UUID;
  feeCode: string;
  feeName: string;
  classScope: string | null;
  unitRateKobo: number;
  assignmentAdjustmentKobo: number;
  dueDate: string | null;
  grossKobo: number;
  existingLineId: UUID | null;
  existingInvoiceId: UUID | null;
  existingInvoiceNumber: string | null;
  existingInvoiceStatus: string | null;
  existingAmountKobo: number | null;
  existingWaiverKobo: number | null;
  existingWaiverReason: WaiverReason | null;
  covered: boolean;
  blocked: boolean;
}

export interface BillingPreviewStudent {
  studentId: UUID;
  studentCode: string;
  studentName: string;
  classId: UUID;
  className: string;
  lines: BillingPreviewLine[];
  status: 'INCOMPLETE' | 'BLOCKED' | 'PENDING' | 'BILLED';
  grossKobo: number;
  billedKobo: number;
  toIssueKobo: number;
}

export interface BillingPreview {
  term: Pick<Term, 'id' | 'name' | 'label' | 'status' | 'billed' | 'dueDate' | 'sessionId'>;
  students: BillingPreviewStudent[];
  activeEnrollmentCount: number;
  billableKeyCount: number;
  coveredKeyCount: number;
  missingKeyCount: number;
  blockedKeyCount: number;
  activeAssignmentCount: number;
  grossKobo: number;
  billedKobo: number;
  toIssueKobo: number;
  incompleteStudentIds: UUID[];
  blockedStudentIds: UUID[];
  ready: boolean;
}

export interface BillResult {
  term: Pick<Term, 'id' | 'name' | 'label' | 'status' | 'billed' | 'dueDate' | 'sessionId'>;
  createdInvoices: number;
  createdLines: number;
  unchanged: number;
  totalKobo: number;
  waiversKobo: number;
  invoiceIds: UUID[];
}

export class BillingError extends RepoInvariantError {
  readonly billingCode: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    billingCode: string,
    message: string,
    status = 409,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingError';
    this.billingCode = billingCode;
    this.status = status;
    this.details = details;
  }
}

type PreviewRow = {
  student_id: UUID;
  student_code: string;
  student_first_name: string;
  student_last_name: string;
  class_id: UUID;
  class_name: string;
  fee_assignment_id: UUID | null;
  fee_definition_id: UUID | null;
  fee_code: string | null;
  fee_name: string | null;
  assignment_class_name: string | null;
  assignment_amount_kobo: string | number | null;
  assignment_adjustment_kobo: string | number | null;
  assignment_due_date: string | null;
  existing_line_id: UUID | null;
  existing_invoice_id: UUID | null;
  existing_invoice_number: string | null;
  existing_invoice_status: string | null;
  existing_amount_kobo: string | number | null;
  existing_waiver_kobo: string | number | null;
  existing_waiver_reason: WaiverReason | null;
};

function numeric(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function isCovered(status: string | null): boolean {
  return status === 'ISSUED' || status === 'PARTIALLY_PAID' || status === 'PAID';
}

/**
 * Read-only preview. A school-wide assignment is suppressed for a student
 * when a class-specific assignment for the same fee definition exists.
 */
export async function previewTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
): Promise<BillingPreview> {
  const term = await termRepo.get(db, ctx, termId);
  if (!term) throw new BillingError('TERM_NOT_FOUND', 'Term not found', 404);

  const rows = await db.execute(sql`
    WITH active_enrollments AS (
      SELECT ce.student_id,
             ce.term_id,
             ce.class_id,
             s.student_id AS student_code,
             s.first_name AS student_first_name,
             s.last_name AS student_last_name,
             c.name AS class_name
        FROM class_enrollments ce
        JOIN students s
          ON s.id = ce.student_id
         AND s.organization_id = ce.organization_id
        JOIN classes c
          ON c.id = ce.class_id
         AND c.organization_id = ce.organization_id
       WHERE ce.organization_id = ${ctx.organizationId}::uuid
         AND ce.term_id = ${termId}::uuid
         AND ce.left_on IS NULL
         AND s.status = 'ACTIVE'
    ),
    applicable AS (
      SELECT ae.student_id,
             ae.term_id,
             ae.class_id,
             ae.student_code,
             ae.student_first_name,
             ae.student_last_name,
             ae.class_name,
             fa.id AS fee_assignment_id,
             fa.fee_definition_id,
             fa.amount_kobo AS assignment_amount_kobo,
             fa.adjustment_kobo AS assignment_adjustment_kobo,
             fa.due_date AS assignment_due_date,
             fd.code AS fee_code,
             fd.name AS fee_name,
             CASE WHEN fa.class_id IS NULL THEN NULL ELSE ae.class_name END AS assignment_class_name
        FROM active_enrollments ae
        JOIN fee_assignments fa
          ON fa.organization_id = ${ctx.organizationId}::uuid
         AND fa.term_id = ae.term_id
         AND fa.status = 'ACTIVE'
         AND (fa.class_id = ae.class_id OR fa.class_id IS NULL)
        JOIN fee_definitions fd
          ON fd.id = fa.fee_definition_id
         AND fd.organization_id = ${ctx.organizationId}::uuid
       WHERE NOT (
         fa.class_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM fee_assignments override_fa
            WHERE override_fa.organization_id = ${ctx.organizationId}::uuid
              AND override_fa.term_id = ae.term_id
              AND override_fa.status = 'ACTIVE'
              AND override_fa.fee_definition_id = fa.fee_definition_id
              AND override_fa.class_id = ae.class_id
         )
       )
    )
    SELECT ae.student_id,
           ae.student_code,
           ae.student_first_name,
           ae.student_last_name,
           ae.class_id,
           ae.class_name,
           a.fee_assignment_id,
           a.fee_definition_id,
           a.fee_code,
           a.fee_name,
           a.assignment_class_name,
             a.assignment_amount_kobo,
           a.assignment_adjustment_kobo,
           a.assignment_due_date,
           il.id AS existing_line_id,
           i.id AS existing_invoice_id,
           i.invoice_number AS existing_invoice_number,
           i.status AS existing_invoice_status,
           il.amount_kobo AS existing_amount_kobo,
           w.amount_kobo AS existing_waiver_kobo,
           w.reason AS existing_waiver_reason
      FROM active_enrollments ae
      LEFT JOIN applicable a
        ON a.student_id = ae.student_id
       AND a.term_id = ae.term_id
      LEFT JOIN invoice_lines il
        ON il.organization_id = ${ctx.organizationId}::uuid
       AND il.billing_student_id = ae.student_id
       AND il.billing_term_id = ae.term_id
       AND il.fee_assignment_id = a.fee_assignment_id
      LEFT JOIN invoices i
        ON i.id = il.invoice_id
       AND i.organization_id = ${ctx.organizationId}::uuid
      LEFT JOIN waivers w
        ON w.invoice_line_id = il.id
       AND w.organization_id = ${ctx.organizationId}::uuid
     ORDER BY ae.class_name, ae.student_last_name, ae.student_first_name,
              a.fee_code NULLS LAST
  `) as unknown as PreviewRow[];

  const students = new Map<string, BillingPreviewStudent>();
  for (const row of rows) {
    let student = students.get(row.student_id);
    if (!student) {
      student = {
        studentId: row.student_id,
        studentCode: row.student_code,
        studentName: [row.student_first_name, row.student_last_name].filter(Boolean).join(' ').trim(),
        classId: row.class_id,
        className: row.class_name,
        lines: [],
        status: 'INCOMPLETE',
        grossKobo: 0,
        billedKobo: 0,
        toIssueKobo: 0,
      };
      students.set(row.student_id, student);
    }

    if (!row.fee_assignment_id) continue;

    const unitRateKobo = numeric(row.assignment_amount_kobo);
    const assignmentAdjustmentKobo = numeric(row.assignment_adjustment_kobo);
    const grossKobo = unitRateKobo + assignmentAdjustmentKobo;
    const covered = isCovered(row.existing_invoice_status);
    const blocked = !!row.existing_line_id && !covered;
    const line: BillingPreviewLine = {
      feeAssignmentId: row.fee_assignment_id,
      feeDefinitionId: row.fee_definition_id!,
      feeCode: row.fee_code!,
      feeName: row.fee_name!,
      classScope: row.assignment_class_name,
      unitRateKobo,
      assignmentAdjustmentKobo,
      dueDate: row.assignment_due_date,
      grossKobo,
      existingLineId: row.existing_line_id,
      existingInvoiceId: row.existing_invoice_id,
      existingInvoiceNumber: row.existing_invoice_number,
      existingInvoiceStatus: row.existing_invoice_status,
      existingAmountKobo: row.existing_amount_kobo === null ? null : numeric(row.existing_amount_kobo),
      existingWaiverKobo: row.existing_waiver_kobo === null ? null : numeric(row.existing_waiver_kobo),
      existingWaiverReason: row.existing_waiver_reason,
      covered,
      blocked,
    };
    student.lines.push(line);
    student.grossKobo += grossKobo;
    if (covered) student.billedKobo += line.existingAmountKobo ?? grossKobo;
    if (!covered && !blocked) student.toIssueKobo += grossKobo;
  }

  const studentRows = Array.from(students.values());
  for (const student of studentRows) {
    const hasIncomplete = student.lines.length === 0;
    const hasBlocked = student.lines.some((line) => line.blocked);
    const hasMissing = student.lines.some((line) => !line.covered && !line.blocked);
    student.status = hasIncomplete
      ? 'INCOMPLETE'
      : hasBlocked
        ? 'BLOCKED'
        : hasMissing
          ? 'PENDING'
          : 'BILLED';
  }

  const lines = studentRows.flatMap((student) => student.lines);
  const incompleteStudentIds = studentRows.filter((s) => s.status === 'INCOMPLETE').map((s) => s.studentId);
  const blockedStudentIds = studentRows.filter((s) => s.status === 'BLOCKED').map((s) => s.studentId);
  const activeAssignmentCount = new Set(lines.map((line) => line.feeAssignmentId)).size;
  const missingKeyCount = lines.filter((line) => !line.covered && !line.blocked).length;
  const blockedKeyCount = lines.filter((line) => line.blocked).length;
  const coveredKeyCount = lines.filter((line) => line.covered).length;
  const grossKobo = lines.reduce((sum, line) => sum + line.grossKobo, 0);
  const billedKobo = lines.reduce((sum, line) => sum + (line.covered ? (line.existingAmountKobo ?? line.grossKobo) : 0), 0);
  const toIssueKobo = lines.reduce((sum, line) => sum + (!line.covered && !line.blocked ? line.grossKobo : 0), 0);

  return {
    term: {
      id: term.id,
      name: term.name,
      label: term.label,
      status: term.status,
      billed: term.billed,
      dueDate: term.dueDate,
      sessionId: term.sessionId,
    },
    students: studentRows,
    activeEnrollmentCount: studentRows.length,
    billableKeyCount: lines.length,
    coveredKeyCount,
    missingKeyCount,
    blockedKeyCount,
    activeAssignmentCount,
    grossKobo,
    billedKobo,
    toIssueKobo,
    incompleteStudentIds,
    blockedStudentIds,
    ready: studentRows.length > 0
      && activeAssignmentCount > 0
      && incompleteStudentIds.length === 0
      && blockedStudentIds.length === 0,
  };
}

function validateCohort(preview: BillingPreview, term: Term): void {
  if (term.status === 'PLANNED') {
    throw new BillingError('TERM_NOT_ACTIVE', 'A PLANNED term cannot be billed');
  }
  if (term.status === 'CLOSED') {
    throw new BillingError('TERM_CLOSED', 'A CLOSED term cannot be billed');
  }
  if (preview.activeEnrollmentCount === 0) {
    throw new BillingError('EMPTY_ENROLLMENT', 'This term has no active enrolled students');
  }
  if (preview.activeAssignmentCount === 0) {
    throw new BillingError('NO_ACTIVE_FEES', 'This term has no active fee assignments');
  }
  if (preview.incompleteStudentIds.length > 0) {
    throw new BillingError(
      'INCOMPLETE_COHORT',
      'Every active enrolled student must have at least one applicable active fee',
      409,
      { studentIds: preview.incompleteStudentIds },
    );
  }
  if (preview.blockedStudentIds.length > 0) {
    throw new BillingError(
      'BILLING_BLOCKED',
      'A prior draft or voided billing line blocks a safe retry; resolve it explicitly before billing',
      409,
      { studentIds: preview.blockedStudentIds },
    );
  }
}

function overrideKey(studentId: UUID, feeAssignmentId: UUID): string {
  return `${studentId}:${feeAssignmentId}`;
}

function validateOverrides(
  preview: BillingPreview,
  overrides: ReadonlyArray<WaiverOverrideInput>,
): Map<string, WaiverOverrideInput> {
  const available = new Map<string, BillingPreviewLine>();
  for (const student of preview.students) {
    for (const line of student.lines) {
      if (!line.covered && !line.blocked) available.set(overrideKey(student.studentId, line.feeAssignmentId), line);
    }
  }

  const map = new Map<string, WaiverOverrideInput>();
  for (const override of overrides) {
    if (!Number.isSafeInteger(override.amountKobo) || override.amountKobo <= 0) {
      throw new BillingError('INVALID_WAIVER', 'Waiver amount must be a positive safe kobo integer', 400);
    }
    if (override.note && override.note.length > 500) {
      throw new BillingError('INVALID_WAIVER', 'Waiver note must be 500 characters or fewer', 400);
    }
    const key = overrideKey(override.studentId, override.feeAssignmentId);
    if (map.has(key)) throw new BillingError('INVALID_WAIVER', 'A fee line can have only one waiver in a bill run', 400);
    const line = available.get(key);
    if (!line) {
      throw new BillingError('INVALID_WAIVER', 'Waiver must target an unbilled applicable fee line', 400);
    }
    if (override.amountKobo > line.grossKobo) {
      throw new BillingError('INVALID_WAIVER', 'Waiver cannot exceed the fee line amount', 400);
    }
    map.set(key, { ...override, note: override.note?.trim() || null });
  }

  for (const student of preview.students) {
    const pending = student.lines.filter((line) => !line.covered && !line.blocked);
    const finalTotal = pending.reduce((sum, line) => {
      const waiver = map.get(overrideKey(student.studentId, line.feeAssignmentId));
      return sum + line.grossKobo - (waiver?.amountKobo ?? 0);
    }, 0);
    if (pending.length > 0 && finalTotal <= 0) {
      throw new BillingError(
        'ZERO_INVOICE_TOTAL',
        `Concessions would make ${student.studentName}'s invoice total zero; M8 requires a positive ordinary invoice`,
        400,
        { studentId: student.studentId },
      );
    }
  }
  return map;
}

function earliestDueDate(termDueDate: string | null, lines: BillingPreviewLine[]): string | undefined {
  const dates = [termDueDate, ...lines.map((line) => line.dueDate)].filter(Boolean) as string[];
  return dates.sort()[0];
}

/**
 * Execute one complete bill/top-up transaction. The caller must supply a
 * transactional Drizzle handle (the API does); the term row is locked again
 * here so repository callers cannot accidentally skip serialization.
 */
export async function billTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
  overrides: ReadonlyArray<WaiverOverrideInput> = [],
  requestId?: string,
): Promise<BillResult> {
  const lockedTerm = await termRepo.lockForBilling(db, ctx, termId);
  if (!lockedTerm) throw new BillingError('TERM_NOT_FOUND', 'Term not found', 404);

  const before = await previewTerm(db, ctx, termId);
  validateCohort(before, lockedTerm);
  const waiverMap = validateOverrides(before, overrides);

  const missing = before.students.flatMap((student) =>
    student.lines
      .filter((line) => !line.covered && !line.blocked)
      .map((line) => ({ student, line })),
  );
  const grouped = new Map<string, Array<{ student: BillingPreviewStudent; line: BillingPreviewLine }>>();
  for (const item of missing) {
    const group = grouped.get(item.student.studentId) ?? [];
    group.push(item);
    grouped.set(item.student.studentId, group);
  }

  const invoiceIds: UUID[] = [];
  let createdInvoices = 0;
  let createdLines = 0;
  let totalKobo = 0;
  let waiversKobo = 0;
  const waiverAudit: Array<Record<string, unknown>> = [];

  for (const [studentId, items] of grouped) {
    const grossTotal = items.reduce((sum, item) => sum + item.line.grossKobo, 0);
    const studentWaivers = items.reduce(
      (sum, item) => sum + (waiverMap.get(overrideKey(studentId, item.line.feeAssignmentId))?.amountKobo ?? 0),
      0,
    );
    if (grossTotal - studentWaivers <= 0) {
      throw new BillingError('ZERO_INVOICE_TOTAL', 'A generated invoice must have a positive total', 400, { studentId });
    }

    const draft = await invRepo.createDraft(db, ctx, {
      studentId: studentId as UUID,
      termId: lockedTerm.id,
      sessionId: lockedTerm.sessionId,
      memo: `Term billing · ${lockedTerm.name}`,
    });

    const insertedLines = await lineRepo.addLines(
      db,
      ctx,
      draft.id,
      items.map(({ line }) => ({
        feeAssignmentId: line.feeAssignmentId,
        billingStudentId: studentId as UUID,
        billingTermId: lockedTerm.id,
        description: `${line.feeCode} — ${line.feeName}`,
        quantity: 1,
        unitRateKobo: line.grossKobo as any,
        adjustmentKobo: 0,
        amountKobo: line.grossKobo as any,
      })),
    );
    createdLines += insertedLines.length;

    for (let i = 0; i < items.length; i += 1) {
      const { line } = items[i]!;
      const override = waiverMap.get(overrideKey(studentId as UUID, line.feeAssignmentId));
      const insertedLine = insertedLines[i]!;
      if (!override) continue;
      await db.insert(waivers).values({
        organizationId: ctx.organizationId,
        invoiceLineId: insertedLine.id,
        reason: override.reason,
        amountKobo: override.amountKobo as any,
        note: override.note ?? null,
        approvedBy: ctx.userId!,
      });
      waiversKobo += override.amountKobo;
      waiverAudit.push({
        studentId,
        feeAssignmentId: line.feeAssignmentId,
        amountKobo: override.amountKobo,
        reason: override.reason,
      });
    }

    const currentDraft = await invRepo.get(db, ctx, draft.id);
    if (!currentDraft || Number(currentDraft.totalKobo) <= 0) {
      throw new BillingError('ZERO_INVOICE_TOTAL', 'A generated invoice must have a positive total', 400, { studentId });
    }

    const issued = await invRepo.issue(db, ctx, draft.id, {
      dueDate: earliestDueDate(lockedTerm.dueDate, items.map((item) => item.line)),
    });
    if (issued.status !== 'ISSUED' || Number(issued.totalKobo) <= 0) {
      throw new BillingError('ISSUE_FAILED', 'Generated invoice did not reach ISSUED with a positive total');
    }

    invoiceIds.push(issued.id);
    createdInvoices += 1;
    totalKobo += Number(issued.totalKobo);

    await auditRepo.record(db, ctx, {
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: issued.id,
      after: {
        invoiceNumber: issued.invoiceNumber,
        totalKobo: Number(issued.totalKobo),
        studentId: issued.studentId,
        termId: issued.termId,
        source: 'term.billing',
      },
      metadata: { requestId, source: 'term.billing', termId: lockedTerm.id },
    });
    await auditRepo.record(db, ctx, {
      action: 'invoice.issue',
      entityType: 'invoice',
      entityId: issued.id,
      after: { invoiceNumber: issued.invoiceNumber, status: issued.status },
      metadata: { requestId, source: 'term.billing', termId: lockedTerm.id },
    });
  }

  // Re-read through the same transaction after all writes. This is the proof
  // that the term can move to BILLED; if anything is missing, throw and roll
  // back every invoice/line/waiver/audit write above.
  const after = await previewTerm(db, ctx, termId);
  validateCohort(after, lockedTerm);
  if (after.missingKeyCount !== 0 || after.blockedKeyCount !== 0) {
    throw new BillingError('INCOMPLETE_BILL_RUN', 'Billing did not cover every applicable fee key', 409, {
      missingKeyCount: after.missingKeyCount,
      blockedKeyCount: after.blockedKeyCount,
    });
  }

  let finalTerm = lockedTerm;
  if (lockedTerm.status === 'ACTIVE' && !lockedTerm.billed) {
    const marked = await termRepo.markBilled(db, ctx, termId);
    if (!marked) throw new BillingError('TERM_STATE_RACE', 'Term could not be moved to BILLED');
    finalTerm = marked;
  }

  await auditRepo.record(db, ctx, {
    action: 'term.bill',
    entityType: 'term',
    entityId: termId,
    after: {
      status: finalTerm.status,
      billed: finalTerm.billed,
      invoicesCreated: createdInvoices,
      linesCreated: createdLines,
      totalKobo,
      waiversKobo,
    },
    metadata: {
      requestId,
      source: 'term.billing',
      termId,
      unchangedKeys: before.coveredKeyCount,
      waiverCount: waiverAudit.length,
      waivers: waiverAudit,
    },
  });

  return {
    term: {
      id: finalTerm.id,
      name: finalTerm.name,
      label: finalTerm.label,
      status: finalTerm.status,
      billed: finalTerm.billed,
      dueDate: finalTerm.dueDate,
      sessionId: finalTerm.sessionId,
    },
    createdInvoices,
    createdLines,
    unchanged: before.coveredKeyCount,
    totalKobo,
    waiversKobo,
    invoiceIds,
  };
}
