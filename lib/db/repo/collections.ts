/**
 * M11 Collections Workbench repository.
 *
 * The repository owns operational case workflow only. It reads current debt,
 * payment/allocation, receipt, reversal, and reconciliation data from the
 * existing authoritative tables and never writes a financial balance.
 */
import { and, desc, eq } from 'drizzle-orm';
import { SURFACE_LIMITS, assertCursorKeys, decodeCursor, encodeCursor } from './pagination';
import { sql } from 'drizzle-orm';
import { AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { collectionsCases, collectionsCaseEvents, reminders } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
import { asUUID } from './_context';

export type CollectionsState = 'OPEN' | 'IN_PROGRESS' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';
export type CollectionsPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type CollectionsEventType =
  | 'CREATED'
  | 'ASSIGNED'
  | 'UNASSIGNED'
  | 'NOTE'
  | 'ACTION'
  | 'STATE_CHANGE'
  | 'RESOLVED'
  | 'CLOSED'
  | 'REOPENED';

export type CollectionsCase = typeof collectionsCases.$inferSelect;
export type CollectionsCaseEvent = typeof collectionsCaseEvents.$inferSelect;

const TRANSITIONS: Record<CollectionsState, readonly CollectionsState[]> = {
  OPEN: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED'],
  IN_PROGRESS: ['OPEN', 'ESCALATED', 'RESOLVED'],
  ESCALATED: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

function actorId(ctx: TenantCtx): UUID {
  if (!ctx.userId) {
    throw new AuthzError(AuthzErrorCode.UNAUTHENTICATED, 'A human actor is required.', 401);
  }
  return ctx.userId;
}

function notFound(): AuthzError {
  return new AuthzError(AuthzErrorCode.NOT_FOUND, 'Collections case not found.', 404);
}

function conflict(message: string): AuthzError {
  return new AuthzError(AuthzErrorCode.CONFLICT, message, 409);
}

function invalid(message: string): AuthzError {
  return new AuthzError(AuthzErrorCode.BAD_REQUEST, message, 400);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

interface QueueDbRow {
  id: string;
  studentId: string;
  state: CollectionsState;
  priority: CollectionsPriority;
  reason: string;
  assignedTo: string | null;
  nextActionAt: unknown;
  version: number;
  createdAt: unknown;
  updatedAt: unknown;
  studentIdCode: string;
  studentName: string;
  studentOutstandingKobo: unknown;
  openInvoiceCount: unknown;
}

export interface CollectionsQueueRow {
  id: string;
  studentId: string;
  studentIdCode: string;
  studentName: string;
  state: CollectionsState;
  priority: CollectionsPriority;
  reason: string;
  assignedTo: string | null;
  nextActionAt: string | null;
  outstandingKobo: number;
  studentOutstandingKobo: number;
  openInvoiceCount: number;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface QueueFilters {
  state?: CollectionsState;
  priority?: CollectionsPriority;
  assignee?: UUID;
  includeClosed?: boolean;
  limit?: number;
}

/**
 * Queue rows join live invoice columns. `outstandingKobo` is calculated from
 * trigger-maintained invoice totals/paid values at read time, never copied to
 * collections_cases.
 */
/**
 * H-2/M-6 — the queue with a declared window.
 *
 * The workbench orders by (priority rank, next action, created, id); a keyset
 * cursor has to reproduce that ordering exactly, so the rank and the NULLS-LAST
 * next-action key are materialised in a CTE and compared in the same shape. The
 * filter total comes from the database, never from the page.
 */
/**
 * The queue's compound ordering, expressed once so the keyset predicate and the
 * ORDER BY cannot drift: priority rank, next-action key (NULLS LAST via the
 * max-bigint sentinel), then created-at and id as final tie-breakers. All
 * timestamp comparisons are microsecond integers.
 */
const RANK_SQL = sql`CASE c.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END`;
const NEXT_ACTION_US_SQL =
  sql`(CASE WHEN c.next_action_at IS NULL THEN 9223372036854775807::bigint
            ELSE floor(extract(epoch from c.next_action_at) * 1000000)::bigint END)`;
const CREATED_US_SQL = sql`floor(extract(epoch from c.created_at) * 1000000)::bigint`;

export async function listQueuePage(
  db: TenantScopedDb,
  ctx: TenantCtx,
  filters: QueueFilters = {},
  window: { limit: number; cursor?: string | null } = { limit: 50 },
): Promise<{ rows: CollectionsQueueRow[]; total: number; hasMore: boolean; nextCursor: string | null }> {
  const limit = Math.min(Math.max(window.limit, 1), 100);
  const after = window.cursor ? decodeCursor(SURFACE_LIMITS.collections.surface, window.cursor) : null;

  const conditions = [sql`c.organization_id = ${ctx.organizationId}::uuid`];
  if (!filters.includeClosed) conditions.push(sql`c.state <> 'CLOSED'`);
  if (filters.state) conditions.push(sql`c.state = ${filters.state}`);
  if (filters.priority) conditions.push(sql`c.priority = ${filters.priority}`);
  if (filters.assignee) conditions.push(sql`c.assigned_to = ${filters.assignee}::uuid`);
  if (after) {
    // The cursor carries the SAME keys the ordering is expressed on: rank,
    // next-action microsecond key (max-bigint sentinel for NULL, i.e. NULLS
    // LAST), created microsecond key, id. Timestamps are microseconds, not ISO
    // strings — a millisecond cursor cannot separate rows created in the same
    // millisecond, and would drop them from the walk.
    assertCursorKeys(after, ['rank', 'bigint', 'bigint', 'uuid']);
    conditions.push(sql`(
      ${RANK_SQL} > ${Number(after[0])}
      OR (${RANK_SQL} = ${Number(after[0])} AND ${NEXT_ACTION_US_SQL} > ${after[1]}::bigint)
      OR (${RANK_SQL} = ${Number(after[0])} AND ${NEXT_ACTION_US_SQL} = ${after[1]}::bigint
          AND ${CREATED_US_SQL} < ${after[2]}::bigint)
      OR (${RANK_SQL} = ${Number(after[0])} AND ${NEXT_ACTION_US_SQL} = ${after[1]}::bigint
          AND ${CREATED_US_SQL} = ${after[2]}::bigint
          AND c.id < ${after[3]}::uuid)
    )`);
  }

  const countRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM collections_cases c
     WHERE ${sql.join(conditions, sql` AND `)}
  `)) as unknown as Array<{ n: number }>;
  const total = Number(countRows?.[0]?.n ?? 0);

  const rows = (await db.execute(sql`
    WITH queue AS (
      SELECT
        c.id,
        c.student_id AS "studentId",
        c.state,
        c.priority,
        c.reason,
        c.assigned_to AS "assignedTo",
        c.next_action_at AS "nextActionAt",
        c.version,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        ${RANK_SQL} AS rank,
        ${NEXT_ACTION_US_SQL} AS na_us,
        ${CREATED_US_SQL} AS created_us,
        s.student_id AS "studentIdCode",
        trim(coalesce(s.first_name, '') || ' ' || coalesce(s.middle_name, '') || ' ' || coalesce(s.last_name, '')) AS "studentName",
        coalesce(debt.student_outstanding_kobo, 0) AS "studentOutstandingKobo",
        coalesce(debt.open_invoice_count, 0)::int AS "openInvoiceCount"
      FROM collections_cases c
      JOIN students s
        ON s.id = c.student_id
       AND s.organization_id = c.organization_id
      LEFT JOIN LATERAL (
        SELECT
          coalesce(sum(greatest(0, i2.total_kobo - i2.paid_kobo)), 0) AS student_outstanding_kobo,
          count(*)::int AS open_invoice_count
        FROM invoices i2
        WHERE i2.organization_id = c.organization_id
          AND i2.student_id = c.student_id
          AND i2.status IN ('ISSUED', 'PARTIALLY_PAID')
          AND greatest(0, i2.total_kobo - i2.paid_kobo) > 0
      ) debt ON true
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY rank, na_us, created_us DESC, c.id DESC
      LIMIT ${limit + 1}
    )
    SELECT * FROM queue
  `)) as unknown as QueueDbRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = (page[page.length - 1] as any) ?? null;
  return {
    rows: page.map((row) => ({
      id: row.id,
      studentId: row.studentId,
      studentIdCode: row.studentIdCode,
      studentName: row.studentName.replace(/\s+/g, ' ').trim(),
      state: row.state,
      priority: row.priority,
      reason: row.reason,
      assignedTo: row.assignedTo,
      nextActionAt: iso(row.nextActionAt),
      outstandingKobo: numberValue(row.studentOutstandingKobo),
      studentOutstandingKobo: numberValue(row.studentOutstandingKobo),
      openInvoiceCount: numberValue(row.openInvoiceCount),
      version: Number(row.version),
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string,
    })),
    total,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(SURFACE_LIMITS.collections.surface, [
            String(Number(last.rank)),
            String(last.na_us),
            String(last.created_us),
            String(last.id),
          ])
        : null,
  };
}

export async function listQueue(
  db: TenantScopedDb,
  ctx: TenantCtx,
  filters: QueueFilters = {},
): Promise<CollectionsQueueRow[]> {
  const conditions = [sql`c.organization_id = ${ctx.organizationId}::uuid`];
  if (!filters.includeClosed) conditions.push(sql`c.state <> 'CLOSED'`);
  if (filters.state) conditions.push(sql`c.state = ${filters.state}`);
  if (filters.priority) conditions.push(sql`c.priority = ${filters.priority}`);
  if (filters.assignee) conditions.push(sql`c.assigned_to = ${filters.assignee}::uuid`);

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const rows = (await db.execute(sql`
    SELECT
      c.id,
      c.student_id AS "studentId",
      c.state,
      c.priority,
      c.reason,
      c.assigned_to AS "assignedTo",
      c.next_action_at AS "nextActionAt",
      c.version,
      c.created_at AS "createdAt",
      c.updated_at AS "updatedAt",
      s.student_id AS "studentIdCode",
      trim(coalesce(s.first_name, '') || ' ' || coalesce(s.middle_name, '') || ' ' || coalesce(s.last_name, '')) AS "studentName",
      coalesce(debt.student_outstanding_kobo, 0) AS "studentOutstandingKobo",
      coalesce(debt.open_invoice_count, 0)::int AS "openInvoiceCount"
    FROM collections_cases c
    JOIN students s
      ON s.id = c.student_id
     AND s.organization_id = c.organization_id
    LEFT JOIN LATERAL (
      SELECT
        coalesce(sum(greatest(0, i2.total_kobo - i2.paid_kobo)), 0) AS student_outstanding_kobo,
        count(*)::int AS open_invoice_count
      FROM invoices i2
      WHERE i2.organization_id = c.organization_id
        AND i2.student_id = c.student_id
        AND i2.status IN ('ISSUED', 'PARTIALLY_PAID')
        AND greatest(0, i2.total_kobo - i2.paid_kobo) > 0
    ) debt ON true
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY
      CASE c.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
      c.next_action_at NULLS LAST,
      c.created_at DESC,
      c.id DESC
    LIMIT ${limit}
  `)) as unknown as QueueDbRow[];

  return rows.map((row) => ({
    id: row.id,
    studentId: row.studentId,
    studentIdCode: row.studentIdCode,
    studentName: row.studentName.replace(/\s+/g, ' ').trim(),
    state: row.state,
    priority: row.priority,
    reason: row.reason,
    assignedTo: row.assignedTo,
    nextActionAt: iso(row.nextActionAt),
    outstandingKobo: numberValue(row.studentOutstandingKobo),
    studentOutstandingKobo: numberValue(row.studentOutstandingKobo),
    openInvoiceCount: numberValue(row.openInvoiceCount),
    version: Number(row.version),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

interface LockedCaseRow {
  id: string;
  organization_id: string;
  student_id: string;
  state: CollectionsState;
  priority: CollectionsPriority;
  reason: string;
  assigned_to: string | null;
  next_action_at: unknown;
  resolved_by: string | null;
  resolved_at: unknown;
  closed_by: string | null;
  closed_at: unknown;
  created_by: string;
  version: number;
  created_at: unknown;
  updated_at: unknown;
}

async function lockCase(db: TenantScopedDb, ctx: TenantCtx, caseId: UUID): Promise<LockedCaseRow> {
  const rows = (await db.execute(sql`
    SELECT id, organization_id, student_id, state, priority, reason,
           assigned_to, next_action_at, resolved_by, resolved_at,
           closed_by, closed_at, created_by, version, created_at, updated_at
      FROM collections_cases
     WHERE id = ${caseId}::uuid
       AND organization_id = ${ctx.organizationId}::uuid
     FOR UPDATE
  `)) as unknown as LockedCaseRow[];
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function insertEvent(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    caseId: UUID;
    eventType: CollectionsEventType;
    previousState?: CollectionsState | null;
    nextState?: CollectionsState | null;
    previousAssignee?: UUID | null;
    nextAssignee?: UUID | null;
    note?: string | null;
    reminderId?: UUID | null;
  },
): Promise<CollectionsCaseEvent> {
  const rows = await db
    .insert(collectionsCaseEvents)
    .values({
      organizationId: ctx.organizationId,
      caseId: input.caseId,
      eventType: input.eventType,
      previousState: input.previousState ?? null,
      nextState: input.nextState ?? null,
      previousAssignee: input.previousAssignee ?? null,
      nextAssignee: input.nextAssignee ?? null,
      note: input.note ?? null,
      reminderId: input.reminderId ?? null,
      createdBy: actorId(ctx),
    })
    .returning();
  return rows[0]!;
}

async function verifyStudentAndObligation(
  db: TenantScopedDb,
  ctx: TenantCtx,
  studentId: UUID,
): Promise<void> {
  const studentRows = (await db.execute(sql`
    SELECT id
      FROM students
     WHERE id = ${studentId}::uuid
       AND organization_id = ${ctx.organizationId}::uuid
       AND status = 'ACTIVE'
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!studentRows[0]) throw notFound();

  const debtRows = (await db.execute(sql`
    SELECT coalesce(sum(greatest(0, total_kobo - paid_kobo)), 0) AS outstanding
      FROM invoices
     WHERE organization_id = ${ctx.organizationId}::uuid
       AND student_id = ${studentId}::uuid
       AND status IN ('ISSUED', 'PARTIALLY_PAID')
       AND greatest(0, total_kobo - paid_kobo) > 0
  `)) as unknown as Array<{ outstanding: unknown }>;
  if (numberValue(debtRows[0]?.outstanding) <= 0) {
    throw invalid('The student has no outstanding obligation.');
  }
}

function auditCaseSnapshot(row: LockedCaseRow): Record<string, unknown> {
  return {
    state: row.state,
    priority: row.priority,
    assignedTo: row.assigned_to,
    nextActionAt: iso(row.next_action_at),
    resolvedBy: row.resolved_by,
    resolvedAt: iso(row.resolved_at),
    closedBy: row.closed_by,
    closedAt: iso(row.closed_at),
    version: Number(row.version),
  };
}

export async function createCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    studentId: UUID;
    priority: CollectionsPriority;
    reason: string;
    nextActionAt?: Date | null;
    requestId?: string;
  },
): Promise<CollectionsCase> {
  const actor = actorId(ctx);
  await verifyStudentAndObligation(db, ctx, input.studentId);
  return db.transaction(async (tx) => {
    // Re-check inside the transaction immediately before insert. The financial
    // columns are authoritative and may change between a queue read and create.
    await verifyStudentAndObligation(tx, ctx, input.studentId);
    const rows = await tx
      .insert(collectionsCases)
      .values({
        organizationId: ctx.organizationId,
        studentId: input.studentId,
        state: 'OPEN',
        priority: input.priority,
        reason: input.reason.trim(),
        nextActionAt: input.nextActionAt ?? null,
        createdBy: actor,
        version: 0,
      })
      .returning();
    const created = rows[0]!;
    await insertEvent(tx, ctx, {
      caseId: created.id,
      eventType: 'CREATED',
      note: created.reason,
    });
    await auditRepo.record(tx, ctx, {
      action: 'collections.case.created',
      entityType: 'collections_case',
      entityId: created.id,
      after: {
        state: created.state,
        priority: created.priority,
        studentId: created.studentId,
        version: created.version,
      },
      reason: created.reason,
      requestId: input.requestId,
    });
    return created;
  });
}

export async function assignCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
  input: { assigneeId: UUID | null; expectedVersion: number; requestId?: string },
): Promise<CollectionsCase> {
  return db.transaction(async (tx) => {
    const current = await lockCase(tx, ctx, caseId);
    if (current.version !== input.expectedVersion) {
      throw conflict('The case changed before assignment. Refresh and retry.');
    }
    if (current.state === 'CLOSED') throw conflict('Closed cases cannot be reassigned.');
    if (input.assigneeId) {
      const memberRows = (await tx.execute(sql`
        SELECT 1 FROM organization_members
         WHERE organization_id = ${ctx.organizationId}::uuid
           AND user_id = ${input.assigneeId}::uuid
           AND status = 'ACTIVE'
         LIMIT 1
      `)) as unknown as Array<{ '?column?': number }>;
      if (!memberRows[0])
        throw invalid('The assignee is not an active member of this organization.');
    }
    if (current.assigned_to === input.assigneeId) {
      const rows = await tx
        .select()
        .from(collectionsCases)
        .where(eq(collectionsCases.id, caseId))
        .limit(1);
      if (!rows[0]) throw notFound();
      return rows[0];
    }

    const updatedRows = await tx
      .update(collectionsCases)
      .set({ assignedTo: input.assigneeId, version: current.version + 1 })
      .where(
        and(
          eq(collectionsCases.id, caseId),
          eq(collectionsCases.organizationId, ctx.organizationId),
          eq(collectionsCases.version, input.expectedVersion),
        ),
      )
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw conflict('The case changed before assignment. Refresh and retry.');
    await insertEvent(tx, ctx, {
      caseId,
      eventType: input.assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
      previousAssignee: current.assigned_to ? asUUID(current.assigned_to) : null,
      nextAssignee: input.assigneeId,
    });
    await auditRepo.record(tx, ctx, {
      action: input.assigneeId ? 'collections.case.assigned' : 'collections.case.unassigned',
      entityType: 'collections_case',
      entityId: caseId,
      before: auditCaseSnapshot(current),
      after: auditCaseSnapshot({
        ...current,
        assigned_to: input.assigneeId,
        version: current.version + 1,
      }),
      requestId: input.requestId,
    });
    return updated;
  });
}

export async function addCaseEvent(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
  input: {
    eventType: 'NOTE' | 'ACTION';
    note: string;
    reminderId?: UUID | null;
    nextActionAt?: Date | null;
    expectedVersion: number;
    requestId?: string;
  },
): Promise<{ case: CollectionsCase; event: CollectionsCaseEvent }> {
  actorId(ctx);
  return db.transaction(async (tx) => {
    const current = await lockCase(tx, ctx, caseId);
    if (current.version !== input.expectedVersion) {
      throw conflict('The case changed before the note was added. Refresh and retry.');
    }
    if (current.state === 'CLOSED') throw conflict('Closed cases cannot receive new actions.');
    if (!input.note.trim()) throw invalid('A note or action description is required.');

    const updatedRows = await tx
      .update(collectionsCases)
      .set({
        nextActionAt:
          input.nextActionAt === undefined
            ? dateOrNull(current.next_action_at)
            : input.nextActionAt,
        version: current.version + 1,
      })
      .where(
        and(
          eq(collectionsCases.id, caseId),
          eq(collectionsCases.organizationId, ctx.organizationId),
          eq(collectionsCases.version, input.expectedVersion),
        ),
      )
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw conflict('The case changed before the note was added. Refresh and retry.');
    const event = await insertEvent(tx, ctx, {
      caseId,
      eventType: input.eventType,
      note: input.note.trim(),
      reminderId: input.reminderId ?? null,
    });
    await auditRepo.record(tx, ctx, {
      action:
        input.eventType === 'ACTION'
          ? 'collections.case.action_added'
          : 'collections.case.note_added',
      entityType: 'collections_case',
      entityId: caseId,
      before: auditCaseSnapshot(current),
      after: auditCaseSnapshot({
        ...current,
        next_action_at:
          input.nextActionAt === undefined ? current.next_action_at : input.nextActionAt,
        version: current.version + 1,
      }),
      reason: input.note.trim(),
      metadata: input.reminderId ? { reminderId: input.reminderId } : undefined,
      requestId: input.requestId,
    });
    return { case: updated, event };
  });
}

export async function transitionCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
  input: {
    toState: CollectionsState;
    note: string;
    expectedVersion: number;
    requestId?: string;
  },
): Promise<CollectionsCase> {
  const actor = actorId(ctx);
  if (!input.note.trim()) throw invalid('A transition note is required.');
  return db.transaction(async (tx) => {
    const current = await lockCase(tx, ctx, caseId);
    if (current.version !== input.expectedVersion) {
      throw conflict('The case changed before transition. Refresh and retry.');
    }
    if (!TRANSITIONS[current.state].includes(input.toState)) {
      throw invalid(`Invalid collections case transition ${current.state}->${input.toState}.`);
    }

    const now = new Date();
    const update: Partial<typeof collectionsCases.$inferInsert> = {
      state: input.toState,
      version: current.version + 1,
    };
    if (input.toState === 'RESOLVED') {
      update.resolvedBy = actor;
      update.resolvedAt = now;
      update.closedBy = null;
      update.closedAt = null;
    } else if (input.toState === 'CLOSED') {
      update.closedBy = actor;
      update.closedAt = now;
    } else {
      update.resolvedBy = null;
      update.resolvedAt = null;
      update.closedBy = null;
      update.closedAt = null;
    }

    const updatedRows = await tx
      .update(collectionsCases)
      .set(update)
      .where(
        and(
          eq(collectionsCases.id, caseId),
          eq(collectionsCases.organizationId, ctx.organizationId),
          eq(collectionsCases.version, input.expectedVersion),
        ),
      )
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw conflict('The case changed before transition. Refresh and retry.');

    const eventType: CollectionsEventType =
      input.toState === 'CLOSED'
        ? 'CLOSED'
        : input.toState === 'RESOLVED'
          ? 'RESOLVED'
          : current.state === 'RESOLVED'
            ? 'REOPENED'
            : 'STATE_CHANGE';
    await insertEvent(tx, ctx, {
      caseId,
      eventType,
      previousState: current.state,
      nextState: input.toState,
      note: input.note.trim(),
    });
    await auditRepo.record(tx, ctx, {
      action: 'collections.case.transitioned',
      entityType: 'collections_case',
      entityId: caseId,
      before: auditCaseSnapshot(current),
      after: {
        ...auditCaseSnapshot(current),
        state: updated.state,
        resolvedBy: updated.resolvedBy,
        resolvedAt: iso(updated.resolvedAt),
        closedBy: updated.closedBy,
        closedAt: iso(updated.closedAt),
        version: updated.version,
      },
      reason: input.note.trim(),
      requestId: input.requestId,
    });
    return updated;
  });
}

interface DetailCaseDbRow extends QueueDbRow {
  resolvedBy: string | null;
  resolvedAt: unknown;
  closedBy: string | null;
  closedAt: unknown;
  createdBy: string;
}

function normalizeCase(row: DetailCaseDbRow) {
  return {
    id: row.id,
    studentId: row.studentId,
    studentIdCode: row.studentIdCode,
    studentName: row.studentName.replace(/\s+/g, ' ').trim(),
    state: row.state,
    priority: row.priority,
    reason: row.reason,
    assignedTo: row.assignedTo,
    nextActionAt: iso(row.nextActionAt),
    resolvedBy: row.resolvedBy,
    resolvedAt: iso(row.resolvedAt),
    closedBy: row.closedBy,
    closedAt: iso(row.closedAt),
    createdBy: row.createdBy,
    outstandingKobo: numberValue(row.studentOutstandingKobo),
    studentOutstandingKobo: numberValue(row.studentOutstandingKobo),
    openInvoiceCount: numberValue(row.openInvoiceCount),
    version: Number(row.version),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function getCaseDetail(db: TenantScopedDb, ctx: TenantCtx, caseId: UUID) {
  const caseRows = (await db.execute(sql`
    SELECT
      c.id,
      c.student_id AS "studentId",
      c.state,
      c.priority,
      c.reason,
      c.assigned_to AS "assignedTo",
      c.next_action_at AS "nextActionAt",
      c.resolved_by AS "resolvedBy",
      c.resolved_at AS "resolvedAt",
      c.closed_by AS "closedBy",
      c.closed_at AS "closedAt",
      c.created_by AS "createdBy",
      c.version,
      c.created_at AS "createdAt",
      c.updated_at AS "updatedAt",
      s.student_id AS "studentIdCode",
      trim(coalesce(s.first_name, '') || ' ' || coalesce(s.middle_name, '') || ' ' || coalesce(s.last_name, '')) AS "studentName",
      coalesce(debt.student_outstanding_kobo, 0) AS "studentOutstandingKobo",
      coalesce(debt.open_invoice_count, 0)::int AS "openInvoiceCount"
    FROM collections_cases c
    JOIN students s ON s.id = c.student_id AND s.organization_id = c.organization_id
    LEFT JOIN LATERAL (
      SELECT
        coalesce(sum(greatest(0, i2.total_kobo - i2.paid_kobo)), 0) AS student_outstanding_kobo,
        count(*)::int AS open_invoice_count
      FROM invoices i2
      WHERE i2.organization_id = c.organization_id
        AND i2.student_id = c.student_id
        AND i2.status IN ('ISSUED', 'PARTIALLY_PAID')
        AND greatest(0, i2.total_kobo - i2.paid_kobo) > 0
    ) debt ON true
    WHERE c.id = ${caseId}::uuid
      AND c.organization_id = ${ctx.organizationId}::uuid
    LIMIT 1
  `)) as unknown as DetailCaseDbRow[];
  const current = caseRows[0];
  if (!current) throw notFound();

  const caseReminders = await db
    .select({
      id: reminders.id,
      invoiceId: reminders.invoiceId,
      channel: reminders.channel,
      status: reminders.status,
      balanceKobo: reminders.balanceKobo,
      agingBucket: reminders.agingBucket,
      sentAt: reminders.sentAt,
      createdAt: reminders.createdAt,
    })
    .from(reminders)
    .where(
      and(
        eq(reminders.organizationId, ctx.organizationId),
        sql`(reminders.student_id = ${current.studentId}::uuid OR EXISTS (
          SELECT 1 FROM invoices reminder_invoice
           WHERE reminder_invoice.id = reminders.invoice_id
             AND reminder_invoice.organization_id = reminders.organization_id
             AND reminder_invoice.student_id = ${current.studentId}::uuid
        ))`,
      ),
    )
    .orderBy(desc(reminders.createdAt))
    .limit(25);

  const events = await db
    .select()
    .from(collectionsCaseEvents)
    .where(
      and(
        eq(collectionsCaseEvents.organizationId, ctx.organizationId),
        eq(collectionsCaseEvents.caseId, caseId),
      ),
    )
    .orderBy(desc(collectionsCaseEvents.createdAt), desc(collectionsCaseEvents.id));

  const obligations = (await db.execute(sql`
    SELECT i.id, i.invoice_number AS "invoiceNumber", i.status, i.issue_date AS "issueDate",
           i.due_date AS "dueDate", i.total_kobo AS "totalKobo", i.paid_kobo AS "paidKobo",
           greatest(0, i.total_kobo - i.paid_kobo) AS "outstandingKobo"
      FROM invoices i
     WHERE i.organization_id = ${ctx.organizationId}::uuid
       AND i.student_id = ${current.studentId}::uuid
     ORDER BY i.due_date NULLS LAST, i.created_at DESC, i.id DESC
  `)) as unknown as Array<Record<string, unknown>>;

  const payments = (await db.execute(sql`
    SELECT p.id AS "paymentId", p.payment_number AS "paymentNumber", p.status AS "paymentStatus",
           p.method, p.amount_kobo AS "amountKobo", p.unallocated_kobo AS "unallocatedKobo",
           p.reference, p.payer_name AS "payerName", p.paid_at AS "paidAt",
           pa.id AS "allocationId", pa.invoice_id AS "invoiceId", i.invoice_number AS "invoiceNumber",
           pa.amount_kobo AS "allocationAmountKobo", pa.status AS "allocationStatus",
           pa.allocated_at AS "allocatedAt", pa.note AS "allocationNote"
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id AND p.organization_id = pa.organization_id
      JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = pa.organization_id
     WHERE pa.organization_id = ${ctx.organizationId}::uuid
       AND i.student_id = ${current.studentId}::uuid
     ORDER BY coalesce(pa.allocated_at, p.created_at) DESC, pa.id DESC
  `)) as unknown as Array<Record<string, unknown>>;

  const paymentIds = (await db.execute(sql`
    SELECT DISTINCT pa.payment_id AS id
      FROM payment_allocations pa
      JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = pa.organization_id
     WHERE pa.organization_id = ${ctx.organizationId}::uuid
       AND i.student_id = ${current.studentId}::uuid
  `)) as unknown as Array<{ id: string }>;
  const paymentIdList = paymentIds.map((row) => row.id);
  const reversals =
    paymentIdList.length === 0
      ? []
      : ((await db.execute(sql`
        SELECT r.id, r.reversal_number AS "reversalNumber", r.type, r.payment_id AS "paymentId",
               r.amount_kobo AS "amountKobo", r.reason, r.reference,
               r.reversed_at AS "reversedAt", r.reversed_by AS "reversedBy"
          FROM reversals r
         WHERE r.organization_id = ${ctx.organizationId}::uuid
           AND r.payment_id IN (${sql.join(
             paymentIdList.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
         ORDER BY r.reversed_at DESC, r.id DESC
      `)) as unknown as Array<Record<string, unknown>>);
  const receipts =
    paymentIdList.length === 0
      ? []
      : ((await db.execute(sql`
        SELECT r.id, r.receipt_number AS "receiptNumber", r.payment_id AS "paymentId",
               r.amount_kobo AS "amountKobo", r.status, r.issued_at AS "issuedAt",
               r.voided_at AS "voidedAt", r.issued_by AS "issuedBy"
          FROM receipts r
         WHERE r.organization_id = ${ctx.organizationId}::uuid
           AND r.payment_id IN (${sql.join(
             paymentIdList.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
         ORDER BY r.issued_at DESC, r.id DESC
      `)) as unknown as Array<Record<string, unknown>>);
  const reconciliation = (await db.execute(sql`
    SELECT DISTINCT
           rc.id,
           rc.payment_id AS "paymentId",
           p.payment_number AS "paymentNumber",
           p.status AS "paymentStatus",
           p.amount_kobo AS "amountKobo",
           p.unallocated_kobo AS "unallocatedKobo",
           rc.kind,
           rc.state,
           rc.reason,
           rc.assigned_to AS "assignedTo",
           rc.created_at AS "createdAt",
           rc.resolved_at AS "resolvedAt",
           rc.closed_at AS "closedAt",
           candidate.state AS "candidateState"
      FROM reconciliation_cases rc
      LEFT JOIN payments p
        ON p.id = rc.payment_id
       AND p.organization_id = rc.organization_id
      LEFT JOIN reconciliation_candidates candidate
        ON candidate.case_id = rc.id
       AND candidate.organization_id = rc.organization_id
      LEFT JOIN invoices candidate_invoice
        ON candidate_invoice.id = candidate.invoice_id
       AND candidate_invoice.organization_id = candidate.organization_id
      LEFT JOIN payment_allocations pa
        ON pa.payment_id = rc.payment_id
       AND pa.organization_id = rc.organization_id
      LEFT JOIN invoices allocated_invoice
        ON allocated_invoice.id = pa.invoice_id
       AND allocated_invoice.organization_id = pa.organization_id
     WHERE rc.organization_id = ${ctx.organizationId}::uuid
       AND (
         allocated_invoice.student_id = ${current.studentId}::uuid
         OR candidate.student_id = ${current.studentId}::uuid
         OR candidate_invoice.student_id = ${current.studentId}::uuid
       )
     ORDER BY rc.created_at DESC, rc.id DESC
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    case: normalizeCase(current),
    events,
    reminders: caseReminders.map((row) => ({
      ...row,
      balanceKobo: numberValue(row.balanceKobo),
      sentAt: iso(row.sentAt),
      createdAt: iso(row.createdAt),
    })),
    obligations: obligations.map((row) => ({
      ...row,
      totalKobo: numberValue(row.totalKobo),
      paidKobo: numberValue(row.paidKobo),
      outstandingKobo: numberValue(row.outstandingKobo),
      issueDate: iso(row.issueDate),
      dueDate: iso(row.dueDate),
    })),
    payments: payments.map((row) => ({
      ...row,
      amountKobo: numberValue(row.amountKobo),
      unallocatedKobo: numberValue(row.unallocatedKobo),
      allocationAmountKobo: numberValue(row.allocationAmountKobo),
      paidAt: iso(row.paidAt),
      allocatedAt: iso(row.allocatedAt),
    })),
    reversals: reversals.map((row) => ({
      ...row,
      amountKobo: numberValue(row.amountKobo),
      reversedAt: iso(row.reversedAt),
    })),
    receipts: receipts.map((row) => ({
      ...row,
      amountKobo: numberValue(row.amountKobo),
      issuedAt: iso(row.issuedAt),
      voidedAt: iso(row.voidedAt),
    })),
    reconciliation: reconciliation.map((row) => ({
      ...row,
      amountKobo: numberValue(row.amountKobo),
      unallocatedKobo: numberValue(row.unallocatedKobo),
      createdAt: iso(row.createdAt),
      resolvedAt: iso(row.resolvedAt),
      closedAt: iso(row.closedAt),
    })),
  };
}

export function isValidState(value: string): value is CollectionsState {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, value);
}

export function isValidPriority(value: string): value is CollectionsPriority {
  return ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(value);
}
