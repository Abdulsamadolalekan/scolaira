/**
 * Invoice lines repository.
 *
 * Lines can only be inserted/updated/deleted while the parent invoice is
 * DRAFT (enforced by trg_invoice_lines_change, which also recomputes
 * invoices.total_kobo). After issuance, line mutation raises check_violation.
 */
import { eq, and } from 'drizzle-orm';
import { invoiceLines, invoices } from '../schema';
import { RepoInvariantError, type TenantCtx, type TenantScopedDb, type UUID } from './_context';

export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = Omit<typeof invoiceLines.$inferInsert, 'organizationId'>;

async function assertDraftInvoice(
  db: TenantScopedDb,
  ctx: TenantCtx,
  invoiceId: UUID,
): Promise<void> {
  const invs = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
    .limit(1);
  const inv = invs[0];
  if (!inv) throw new RepoInvariantError(`Invoice ${invoiceId} not found in tenant`);
  if (inv.status !== 'DRAFT') {
    throw new RepoInvariantError(
      `Cannot modify lines on invoice ${invoiceId} (status=${inv.status}); only DRAFT invoices allow line edits.`,
    );
  }
}

export async function addLine(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: NewInvoiceLine,
): Promise<InvoiceLine> {
  await assertDraftInvoice(db, ctx, input.invoiceId);
  const rows = await db
    .insert(invoiceLines)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

/**
 * Add multiple lines to a DRAFT invoice in one round-trip. Useful during
 * invoice creation so total_kobo is recomputed once after the final insert
 * (the trigger recomputes per statement).
 */
export async function addLines(
  db: TenantScopedDb,
  ctx: TenantCtx,
  invoiceId: UUID,
  lines: ReadonlyArray<Omit<NewInvoiceLine, 'invoiceId' | 'organizationId'>>,
): Promise<InvoiceLine[]> {
  await assertDraftInvoice(db, ctx, invoiceId);
  if (lines.length === 0) return [];
  const rows = await db
    .insert(invoiceLines)
    .values(
      lines.map((l) => ({
        ...l,
        invoiceId,
        organizationId: ctx.organizationId,
      })),
    )
    .returning();
  return rows;
}

export async function listForInvoice(
  db: TenantScopedDb,
  ctx: TenantCtx,
  invoiceId: UUID,
): Promise<InvoiceLine[]> {
  return db
    .select()
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.organizationId, ctx.organizationId),
        eq(invoiceLines.invoiceId, invoiceId),
      ),
    );
}
