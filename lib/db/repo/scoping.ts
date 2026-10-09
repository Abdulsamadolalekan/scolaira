/**
 * H-2 — the declared aggregation scope, in one place.
 *
 * Measured defect: the dashboard headline was TERM-scoped while every queue was
 * ALL-TERM, and no payload said which convention it used, so the same word meant
 * two different numbers on one screen (measured: 250,000 vs 450,000 kobo on one
 * tenant). The fix is not "pick one" — both readings are legitimate. The fix is
 * that every surface DECLARES its scope, that the choice is auditable, and that
 * the default never hides carried-forward debt.
 */
import { eq } from 'drizzle-orm';
import { surfaceScopeSettings } from '@/lib/db/schema/platform';
import { getCurrent as getCurrentTerm } from './terms';
import type { TenantScopedDb, TenantCtx, UUID } from './_context';

export type InvoiceScope = 'TERM' | 'ALL_TERM';

/** Arrear visibility is the safe default (H-2 decision 2). */
export const DEFAULT_INVOICE_SCOPE: InvoiceScope = 'ALL_TERM';

export const INVOICE_SCOPE_LABELS: Record<InvoiceScope, string> = {
  ALL_TERM: 'All terms — includes any debt carried forward',
  TERM: 'This term only — excludes earlier terms',
};

export interface InvoiceScopeDeclaration {
  /** The scope every headline figure in the payload was computed with. */
  scope: InvoiceScope;
  /** Human label rendered next to the figures (never hardcoded in the UI). */
  label: string;
  /** True when no explicit choice is stored and the documented default applies. */
  isDefault: boolean;
  /** The setting this declaration comes from, so a client can link to it. */
  setting: 'invoice_scope';
  /** Active term used as the cut-over for prior/other-term classification. */
  termId: UUID | null;
  termName: string | null;
  /** = active term starts_on. Invoices due before this are carried-forward debt. */
  cutoverOn: string | null;
  /** Basis for "today" in overdue arithmetic (server clock, UTC date). */
  asOf: string;
}

function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The stored choice, or null when the organization has never expressed one. */
export async function getStoredInvoiceScope(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<InvoiceScope | null> {
  const rows = await db
    .select({ invoiceScope: surfaceScopeSettings.invoiceScope })
    .from(surfaceScopeSettings)
    .where(eq(surfaceScopeSettings.organizationId, ctx.organizationId))
    .limit(1);
  return (rows[0]?.invoiceScope as InvoiceScope | undefined) ?? null;
}

/** The effective scope plus everything a surface needs to declare itself. */
export async function getInvoiceScopeDeclaration(
  db: TenantScopedDb,
  ctx: TenantCtx,
): Promise<InvoiceScopeDeclaration> {
  const [stored, term] = await Promise.all([
    getStoredInvoiceScope(db, ctx),
    getCurrentTerm(db, ctx),
  ]);
  const scope: InvoiceScope = stored ?? DEFAULT_INVOICE_SCOPE;
  return {
    scope,
    label: INVOICE_SCOPE_LABELS[scope],
    isDefault: stored === null,
    setting: 'invoice_scope',
    termId: (term?.id as UUID | undefined) ?? null,
    termName: term?.name ?? null,
    cutoverOn: term?.startsOn ?? null,
    asOf: utcToday(),
  };
}

/**
 * Write the organization's choice. Returns the previous value so the caller can
 * audit the transition (before → after) rather than just the new state.
 */
export async function setInvoiceScope(
  db: TenantScopedDb,
  ctx: TenantCtx,
  scope: InvoiceScope,
): Promise<{ scope: InvoiceScope; previous: InvoiceScope | null; created: boolean }> {
  const previous = await getStoredInvoiceScope(db, ctx);
  const rows = await db
    .insert(surfaceScopeSettings)
    .values({
      organizationId: ctx.organizationId,
      invoiceScope: scope,
      updatedBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: surfaceScopeSettings.organizationId,
      set: { invoiceScope: scope, updatedBy: ctx.userId, updatedAt: new Date() },
    })
    .returning({ invoiceScope: surfaceScopeSettings.invoiceScope });
  return {
    scope: (rows[0]?.invoiceScope as InvoiceScope | undefined) ?? scope,
    previous,
    created: previous === null,
  };
}
