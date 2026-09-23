/**
 * POST /api/p/[token]/submit — public teller submission for a payment link.
 *
 * The ONLY unauthenticated mutation in M6. R1 (C-3) flow:
 *
 *   1. Resolve the link by token with NO tenant context (bearer lookup).
 *   2. Enter public context derived FROM THE TOKEN (`withPublicScope`) to
 *      validate the linked invoice/amount against the link's own tenant. There
 *      is no caller-supplied organization anywhere in this path.
 *   3. Record the submission through `auth_public_submit_payment(token, …)` —
 *      a SECURITY DEFINER entry point whose ONLY authority is the bearer token.
 *      It re-resolves the link, validates the invoice, and writes the PENDING
 *      payment plus its audit row through the same proof-gated public policies.
 *
 * Why the write is not a plain INSERT here: under row-level security an
 * `INSERT … RETURNING` also requires the inserted row to be SELECT-visible, and
 * a public bearer deliberately has no SELECT policy on `payments` (a link must
 * not be able to enumerate other parents' submissions). The entry point
 * therefore produces the identifier and document number itself and returns
 * them explicitly, so the public surface needs no read access to the ledger at
 * all. Public context has NO direct write privilege on any table.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isPublicLinkUnusable,
  probePublicLinkStatus,
  withPublicScope,
  withScopedDb,
} from '@/lib/db/tenant';

export const runtime = 'nodejs';

const Schema = z.object({
  payerName: z.string().min(1).max(160),
  payerPhone: z.string().max(32).optional(),
  payerEmail: z.string().email().max(255).optional().or(z.literal('')),
  reference: z.string().min(1).max(128),
  amountKobo: z.number().int().positive().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON.' } },
      { status: 400 },
    );
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request.' } },
      { status: 400 },
    );
  }
  const data = parsed.data;

  const link = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
    const rows = await sql<any[]>`
      select organization_id, id, token, status, invoice_id, student_id,
             amount_kobo, note, expires_at
        from auth_resolve_public_link(${token})`;
    return rows[0] ?? null;
  });

  if (!link) {
    const status = await probePublicLinkStatus(token);
    if (status === 'EXPIRED') {
      return NextResponse.json(
        { error: { code: 'GONE', message: 'This payment link has expired.' } },
        { status: 410 },
      );
    }
    // REVOKED maps to 404 to minimize information disclosure.
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'This payment link is no longer available.' } },
      { status: 404 },
    );
  }

  try {
    return await withPublicScope(token, async (_db, sql) => {
      // (a) Validate the amount the payer is settling, inside the link's own
      //     tenant scope. This is a read-through policy check, not a decision:
      //     the entry point below re-derives the organization from the token.
      const orgId: string = link.organization_id;
      const invId: string | null = link.invoice_id ?? null;
      let invoiceRemaining: number | null = null;
      if (invId) {
        const invRows = await sql<any[]>`select total_kobo, paid_kobo from invoices
          where id = ${invId}::uuid and organization_id = ${orgId}::uuid
            and status in ('ISSUED','PARTIALLY_PAID','PAID') limit 1`;
        invoiceRemaining = invRows[0]
          ? Math.max(0, Number(invRows[0].total_kobo) - Number(invRows[0].paid_kobo))
          : null;
      }
      const linkAmount: number | null = link.amount_kobo ? Number(link.amount_kobo) : null;
      const amountKobo = Math.round(data.amountKobo ?? linkAmount ?? invoiceRemaining ?? 0);
      if (!amountKobo || amountKobo <= 0) {
        return NextResponse.json(
          { error: { code: 'BAD_REQUEST', message: 'Could not determine payment amount.' } },
          { status: 400 },
        );
      }

      // (b) The credential-gated write. Returns the generated identifiers
      //     without exposing any read access to payments.
      const rows = await sql<{ payment_id: string; payment_number: string; amount_kobo: bigint; status: string }[]>`
        select payment_id, payment_number, amount_kobo, status
          from auth_public_submit_payment(
                 ${token}, ${amountKobo}::bigint, ${data.reference.trim()},
                 ${data.payerName.trim()}, ${data.payerPhone?.trim() || null},
                 ${data.payerEmail?.trim() || null})`;
      const pay = rows[0];
      if (!pay) {
        return NextResponse.json(
          { error: { code: 'BAD_REQUEST', message: 'Could not record payment.' } },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          payment: {
            paymentNumber: pay.payment_number,
            amountKobo: Number(pay.amount_kobo),
            status: pay.status,
          },
        },
        { status: 201 },
      );
    });
  } catch (e: any) {
    if (isPublicLinkUnusable(e)) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'This payment link is no longer available.' } },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: e?.message ?? 'Could not record payment.' } },
      { status: 400 },
    );
  }
}
