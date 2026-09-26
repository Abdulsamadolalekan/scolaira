/**
 * H-2 — the declared invoice aggregation scope.
 *
 *   GET  — the effective declaration (scope, human label, default flag, the
 *          active term used as the cut-over, and the as-of date).
 *   PUT  — set it. Deliberately gated on `org.settings.update`, NOT on any
 *          finance action: changing what "Outstanding" means is an ownership
 *          decision, and a finance officer must not be able to hide carried
 *          forward debt from the headline.
 *
 * Idempotent by construction: writing the same value twice changes nothing and
 * records no second audit event.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute } from '@/lib/authz';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as scopingRepo from '@/lib/db/repo/scoping';

export const runtime = 'nodejs';

const PutSchema = z.object({ invoiceScope: z.enum(['TERM', 'ALL_TERM']) });

export const GET = withAuthorizedRoute(
  { action: 'org.settings.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const scope = await scopingRepo.getInvoiceScopeDeclaration(db, ctx);
    return NextResponse.json({
      scope,
      options: [
        { value: 'ALL_TERM', label: scopingRepo.INVOICE_SCOPE_LABELS.ALL_TERM },
        { value: 'TERM', label: scopingRepo.INVOICE_SCOPE_LABELS.TERM },
      ],
      default: scopingRepo.DEFAULT_INVOICE_SCOPE,
    });
  },
);

export const PUT = withAuthorizedRoute(
  { action: 'org.settings.update', method: 'PUT', bodySchema: PutSchema },
  async (_req, { db, ctx, requestId, body }) => {
    const data = body as z.infer<typeof PutSchema>;
    return db.transaction(async (tx) => {
      const result = await scopingRepo.setInvoiceScope(tx, ctx, data.invoiceScope);
      const changed = result.previous !== result.scope;
      if (changed) {
        await auditRepo.record(tx, ctx, {
          action: 'scope.invoice_scope.update',
          entityType: 'organization',
          entityId: ctx.organizationId as any,
          before: { invoiceScope: result.previous ?? scopingRepo.DEFAULT_INVOICE_SCOPE },
          after: { invoiceScope: result.scope },
          reason: `Headline invoice scope set to ${result.scope}.`,
          requestId,
        });
      }
      const scope = await scopingRepo.getInvoiceScopeDeclaration(tx, ctx);
      return NextResponse.json({ scope, changed });
    });
  },
);
