/**
 * Payment links repository.
 *
 * Payment links are publicly shareable URLs that allow unauthenticated payers
 * to settle an invoice. Token is generated outside the repo (use nanoid);
 * uniqueness is enforced at DB level (unique index on token).
 */
import { eq, and, sql } from 'drizzle-orm';
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

/** H-5: rotate the bearer token of an ACTIVE link.
 *
 * Rotation is the operational remedy for a leaked URL: the old token stops
 * authorizing anything (the link row it resolved to now carries a different
 * token), while the link's identity — id, invoice/student binding, amount,
 * expiry and the provenance of every payment that points at it — is preserved.
 *
 * The token is minted by the CALLER for the same reason creation works that
 * way: the value is only ever generated in the application process, never read
 * back from the database. The database still owns the invariants
 * (`trg_payment_link_token_rotation_guard`): an ACTIVE link, a fresh opaque
 * token, and provenance (timestamp + incremented count) recorded in the same
 * statement — so no future call site can rotate by accident.
 */
export async function rotateToken(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
  newToken: string,
): Promise<PaymentLink> {
  const rows = await db
    .update(paymentLinks)
    .set({
      token: newToken,
      tokenRotatedAt: new Date(),
      tokenRotationCount: sql`${paymentLinks.tokenRotationCount} + 1`,
    } as unknown as Partial<typeof paymentLinks.$inferInsert>)
    .where(and(eq(paymentLinks.id, id), eq(paymentLinks.organizationId, ctx.organizationId)))
    .returning();
  const row = rows[0];
  if (!row) throw new RepoInvariantError(`Payment link ${id} not found`);
  return row;
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
