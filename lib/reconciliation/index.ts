import { and, eq, sql } from 'drizzle-orm';
import { AuthzError, AuthzErrorCode } from '@/lib/authz';
import {
  reconciliationCandidates,
  reconciliationCases,
  reconciliationEvidence,
} from '@/lib/db/schema';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import type { TenantCtx, TenantScopedDb, UUID } from '@/lib/db/repo/_context';
import type {
  ReconciliationCase,
  ReconciliationCaseKind,
  ReconciliationCandidate,
  ReconciliationEvidence,
  ReconciliationEvidenceKind,
  ReconciliationState,
} from '@/lib/db/repo/reconciliation';

export { listQueue, derivedKind } from '@/lib/db/repo/reconciliation';
export type {
  QueueRow,
  ReconciliationCaseKind,
  ReconciliationEvidenceKind,
  ReconciliationState,
} from '@/lib/db/repo/reconciliation';

function requireActor(ctx: TenantCtx): UUID {
  if (!ctx.userId)
    throw new AuthzError(AuthzErrorCode.UNAUTHENTICATED, 'A human actor is required.', 401);
  return ctx.userId;
}

export interface PaymentSnapshot {
  id: UUID;
  status: string;
  amountKobo: number;
  unallocatedKobo: number;
}

export async function lockPayment(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<PaymentSnapshot> {
  const rows = (await db.execute(sql`
    SELECT id, status, amount_kobo, unallocated_kobo
      FROM payments
     WHERE id = ${paymentId}::uuid
       AND organization_id = ${ctx.organizationId}::uuid
     FOR UPDATE
  `)) as unknown as Array<{
    id: string;
    status: string;
    amount_kobo: number;
    unallocated_kobo: number;
  }>;
  if (!rows[0]) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Payment not found.', 404);
  return {
    id: rows[0].id as UUID,
    status: rows[0].status,
    amountKobo: Number(rows[0].amount_kobo),
    unallocatedKobo: Number(rows[0].unallocated_kobo),
  };
}

export async function getOrCreateCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  payment: PaymentSnapshot,
  input?: { kind?: ReconciliationCaseKind; reason?: string | null },
): Promise<ReconciliationCase> {
  const existing = await reconciliationRepo.getOpenCaseForPayment(db, ctx, payment.id);
  if (existing) return existing;
  const hasDerivedWork =
    payment.status === 'PENDING' ||
    payment.status === 'DUPLICATE_SUSPECT' ||
    (payment.status === 'CONFIRMED' && payment.unallocatedKobo > 0);
  if (!hasDerivedWork)
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'No open reconciliation work remains for this payment.',
      409,
    );
  const kind =
    input?.kind ?? reconciliationRepo.derivedKind(payment.status, payment.unallocatedKobo);
  return reconciliationRepo.ensureOpenCase(db, ctx, {
    paymentId: payment.id,
    kind,
    state: 'UNMATCHED',
    reason: input?.reason ?? null,
  });
}

export async function getCaseOrThrow(
  db: TenantScopedDb,
  ctx: TenantCtx,
  paymentId: UUID,
): Promise<ReconciliationCase> {
  const payment = await lockPayment(db, ctx, paymentId);
  return getOrCreateCase(db, ctx, payment);
}

export async function countEvidence(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(reconciliationEvidence)
    .where(
      and(
        eq(reconciliationEvidence.organizationId, ctx.organizationId),
        eq(reconciliationEvidence.caseId, caseId),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

export async function addEvidence(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    caseId: UUID;
    kind: ReconciliationEvidenceKind;
    reference?: string | null;
    observedAt?: Date | null;
    note?: string | null;
    contentHash?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ReconciliationEvidence> {
  const actorId = requireActor(ctx);
  const caseRows = await db
    .select({ closedAt: reconciliationCases.closedAt })
    .from(reconciliationCases)
    .where(
      and(
        eq(reconciliationCases.id, input.caseId),
        eq(reconciliationCases.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  if (!caseRows[0])
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Reconciliation case not found.', 404);
  if (caseRows[0].closedAt)
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'This reconciliation case is already closed.',
      409,
    );
  const rows = await db
    .insert(reconciliationEvidence)
    .values({
      organizationId: ctx.organizationId,
      caseId: input.caseId,
      kind: input.kind,
      reference: input.reference ?? null,
      observedAt: input.observedAt ?? null,
      note: input.note ?? null,
      contentHash: input.contentHash ?? null,
      metadata: (input.metadata ?? null) as any,
      createdBy: actorId,
    })
    .returning();
  return rows[0]!;
}

export async function listEvidenceAndCandidates(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<{ evidence: ReconciliationEvidence[]; candidates: ReconciliationCandidate[] }> {
  const [evidence, candidates] = await Promise.all([
    reconciliationRepo.listEvidence(db, ctx, caseId),
    reconciliationRepo.listCandidates(db, ctx, caseId),
  ]);
  return { evidence, candidates };
}

export async function acceptedCandidate(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<ReconciliationCandidate | null> {
  const rows = await db
    .select()
    .from(reconciliationCandidates)
    .where(
      and(
        eq(reconciliationCandidates.organizationId, ctx.organizationId),
        eq(reconciliationCandidates.caseId, caseId),
        eq(reconciliationCandidates.state, 'ACCEPTED'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function requireEvidence(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseId: UUID,
): Promise<void> {
  if ((await countEvidence(db, ctx, caseId)) === 0) {
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'Add evidence before making a reconciliation decision.',
      409,
    );
  }
}

export async function updateCaseState(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    caseId: UUID;
    state: ReconciliationState;
    kind?: ReconciliationCaseKind;
    reason?: string | null;
    resolutionCode?: string | null;
    resolutionNote?: string | null;
    close?: boolean;
    previousState?: ReconciliationState | null;
    requestId?: string;
    auditAction: string;
    beforeExtra?: Record<string, unknown>;
    afterExtra?: Record<string, unknown>;
  },
): Promise<ReconciliationCase> {
  const actorId = requireActor(ctx);
  const currentRows = await db
    .select()
    .from(reconciliationCases)
    .where(
      and(
        eq(reconciliationCases.id, input.caseId),
        eq(reconciliationCases.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  const current = currentRows[0];
  if (!current)
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Reconciliation case not found.', 404);
  if (current.closedAt)
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'This reconciliation case is already closed.',
      409,
    );
  if (
    (input.state === 'RECONCILED' || input.state === 'ALLOCATED') &&
    (await countEvidence(db, ctx, input.caseId)) === 0
  ) {
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'Add evidence before making a reconciliation decision.',
      409,
    );
  }

  const now = new Date();
  const rows = await db
    .update(reconciliationCases)
    .set({
      state: input.state,
      kind: input.kind ?? current.kind,
      previousState:
        input.previousState === undefined ? current.previousState : input.previousState,
      reason: input.reason === undefined ? current.reason : input.reason,
      resolutionCode:
        input.resolutionCode === undefined ? current.resolutionCode : input.resolutionCode,
      resolutionNote:
        input.resolutionNote === undefined ? current.resolutionNote : input.resolutionNote,
      resolvedBy: input.close ? actorId : current.resolvedBy,
      resolvedAt: input.close ? now : current.resolvedAt,
      closedAt: input.close ? now : current.closedAt,
      version: current.version + 1,
    })
    .where(
      and(
        eq(reconciliationCases.id, current.id),
        eq(reconciliationCases.organizationId, ctx.organizationId),
        eq(reconciliationCases.version, current.version),
        sql`${reconciliationCases.closedAt} is null`,
      ),
    )
    .returning();
  if (!rows[0])
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'The reconciliation case changed; refresh and retry.',
      409,
    );
  await auditRepo.record(db, ctx, {
    action: input.auditAction,
    entityType: 'reconciliation_case',
    entityId: rows[0].id,
    before: {
      state: current.state,
      kind: current.kind,
      closedAt: current.closedAt,
      ...input.beforeExtra,
    },
    after: {
      state: rows[0].state,
      kind: rows[0].kind,
      closedAt: rows[0].closedAt,
      ...input.afterExtra,
    },
    reason: input.reason ?? undefined,
    metadata: { requestId: input.requestId ?? null, paymentId: current.paymentId },
  });
  return rows[0];
}

export async function createAcceptedCandidate(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: {
    caseId: UUID;
    studentId?: UUID | null;
    invoiceId?: UUID | null;
    basis: string;
    requestId?: string;
  },
): Promise<ReconciliationCandidate> {
  const actorId = requireActor(ctx);
  if (!input.studentId && !input.invoiceId) {
    throw new AuthzError(
      AuthzErrorCode.BAD_REQUEST,
      'A student or invoice candidate is required.',
      400,
    );
  }
  const caseRows = await db
    .select({ state: reconciliationCases.state, closedAt: reconciliationCases.closedAt })
    .from(reconciliationCases)
    .where(
      and(
        eq(reconciliationCases.id, input.caseId),
        eq(reconciliationCases.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  const caseRow = caseRows[0];
  if (!caseRow)
    throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Reconciliation case not found.', 404);
  if (caseRow.closedAt || caseRow.state !== 'UNMATCHED')
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'Only an open, unflagged reconciliation case can accept a candidate.',
      409,
    );
  const existing = await acceptedCandidate(db, ctx, input.caseId);
  if (existing)
    throw new AuthzError(
      AuthzErrorCode.CONFLICT,
      'This case already has an accepted candidate.',
      409,
    );
  let rows: ReconciliationCandidate[];
  try {
    // Insert the decision atomically. A create-then-update sequence can leave
    // a stray PROPOSED candidate behind when concurrent callers race for the
    // one-accepted-candidate partial unique index outside an HTTP transaction.
    rows = await db
      .insert(reconciliationCandidates)
      .values({
        organizationId: ctx.organizationId,
        caseId: input.caseId,
        studentId: input.studentId ?? null,
        invoiceId: input.invoiceId ?? null,
        basis: input.basis,
        state: 'ACCEPTED',
        createdBy: actorId,
        decidedBy: actorId,
        decidedAt: new Date(),
      })
      .returning();
  } catch (error: any) {
    if (error?.code === '23505')
      throw new AuthzError(
        AuthzErrorCode.CONFLICT,
        'This case already has an accepted candidate.',
        409,
      );
    throw error;
  }
  if (!rows[0])
    throw new AuthzError(AuthzErrorCode.CONFLICT, 'The candidate changed; refresh and retry.', 409);
  await auditRepo.record(db, ctx, {
    action: 'reconciliation.match.accept',
    entityType: 'reconciliation_candidate',
    entityId: rows[0].id,
    after: {
      caseId: input.caseId,
      studentId: input.studentId ?? null,
      invoiceId: input.invoiceId ?? null,
      basis: input.basis,
    },
    metadata: { requestId: input.requestId ?? null },
  });
  return rows[0];
}

export async function serializeCase(
  db: TenantScopedDb,
  ctx: TenantCtx,
  caseRow: ReconciliationCase | null,
): Promise<{
  case: ReconciliationCase | null;
  evidence: ReconciliationEvidence[];
  candidates: ReconciliationCandidate[];
}> {
  if (!caseRow) return { case: null, evidence: [], candidates: [] };
  const related = await listEvidenceAndCandidates(db, ctx, caseRow.id);
  return { case: caseRow, ...related };
}
