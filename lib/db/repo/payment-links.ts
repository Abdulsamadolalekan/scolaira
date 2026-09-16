/**
 * Payment links repository.
 *
 * Payment links are publicly shareable URLs that allow unauthenticated payers
 * to settle an invoice. Token is generated outside the repo (use nanoid);
 * uniqueness is enforced at DB level (unique index on token).
 */
import { eq, and } from 'drizzle-orm';
import { paymentLinks } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';
import type { Kobo } from '@/lib/money';

export type PaymentLink = typeof paymentLinks.$inferSelect;

export interface CreatePaymentLinkInput {
  token: string;
  invoiceId?: UUID;
  studentId?: UUID;
  amountKobo?: Kobo | null;
  expiresAt?: Date | null;
  note?: string;
}

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: CreatePaymentLinkInput,
): Promise<PaymentLink> {
  if (!input.invoiceId && !input.studentId && !input.amountKobo) {
    throw new RepoInvariantError(
      'Payment link must reference an invoice, a student, or specify an amount.',
    );
  }
  const rows = await db
    .insert(paymentLinks)
    .values({
      organizationId: ctx.organizationId,
      token: input.token,
      invoiceId: input.invoiceId ?? null,
      studentId: input.studentId ?? null,
      amountKobo: input.amountKobo ?? null,
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId ?? undefined,
      status: 'ACTIVE',
    } as unknown as typeof paymentLinks.$inferInsert)
    .returning();
  return rows[0]!;
}

/** Lookup by public token (does not require tenant context; used by the public
 *  payment page). RLS on payment_links enforces that only the matching
 *  organization sees the row once context is set, but public pre-lookup uses
 *  a direct token equality. **IMPORTANT**: public endpoints must re-establish
 *  context from the resolved organization_id before performing any mutation. */
export async function findByTokenPublic(
  db: TenantScopedDb,
  token: string,
): Promise<PaymentLink | null> {
  const rows = await db
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.token, token))
    .limit(1);
  return rows[0] ?? null;
}

export async function revoke(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<PaymentLink> {
  const rows = await db
    .update(paymentLinks)
    .set({
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedBy: ctx.userId ?? undefined,
    })
    .where(and(eq(paymentLinks.id, id), eq(paymentLinks.organizationId, ctx.organizationId)))
    .returning();
  const row = rows[0];
  if (!row) throw new RepoInvariantError(`Payment link ${id} not found`);
  return row;
}
