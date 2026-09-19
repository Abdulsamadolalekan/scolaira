/**
 * POST /api/p/[token]/submit — public teller submission for a payment link.
 *
 * The ONLY unauthenticated mutation in M6. Flow:
 *   1. Look up the link by token with NO tenant context (public bearer lookup).
 *   2. Validate ACTIVE + not expired.
 *   3. Enter public GUC context scoped to the link's organization.
 *   4. Validate the linked invoice/amount within that RLS scope.
 *   5. Insert a PENDING payment (no allocations; bursar reconciles).
 *   6. Clear context and return paymentNumber.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSql } from '@/lib/db';

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
  try { body = await req.json(); } catch { return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON.' } }, { status: 400 }); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request.' } }, { status: 400 });
  const data = parsed.data;

  const sql = getSql();
  await sql`select clear_app_context()`.catch(() => {});
  const linkRows = await sql<any[]>`
    select organization_id, id, token, status, invoice_id, student_id,
           amount_kobo, note, expires_at
      from auth_resolve_public_link(${token})`;
  const link: any = linkRows[0] ?? null;
  if (!link) {
    // Distinguish 410 (expired/revoked) from 404 via the narrow SECURITY
    // DEFINER probe, which returns 'MISSING' | 'EXPIRED' | 'REVOKED' | 'ACTIVE'
    // without exposing other columns.
    let probe = 'MISSING';
    try {
      const pr = await sql<any[]>`select auth_probe_public_link(${token}) as s`;
      probe = pr[0]?.s ?? 'MISSING';
    } catch { probe = 'MISSING'; }
    if (probe === 'EXPIRED') {
      return NextResponse.json({ error: { code: 'GONE', message: 'This payment link has expired.' } }, { status: 410 });
    }
    // REVOKED maps to 404 to minimize information disclosure.
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'This payment link is no longer available.' } }, { status: 404 });
  }

  try {
    await sql`select auth_set_public_context(${link.organization_id}::uuid)`;
    const orgId: string = link.organization_id;
    const invId: string | null = link.invoice_id ?? null;
    let invoiceRemaining: number | null = null;
    if (invId) {
      const invRows = await sql<any[]>`select total_kobo, paid_kobo from invoices
        where id = ${invId}::uuid and organization_id = ${orgId}::uuid
          and status in ('ISSUED','PARTIALLY_PAID','PAID') limit 1`;
      invoiceRemaining = invRows[0] ? Math.max(0, Number(invRows[0].total_kobo) - Number(invRows[0].paid_kobo)) : null;
    }
    const linkAmount: number | null = link.amount_kobo ? Number(link.amount_kobo) : null;
    const amountKobo = Math.round(data.amountKobo ?? linkAmount ?? invoiceRemaining ?? 0);
    if (!amountKobo || amountKobo <= 0) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Could not determine payment amount.' } }, { status: 400 });
    }

    // Insert PENDING payment. Omit payment_number (trigger assigns via
    // next_doc_number('PMT')) and timestamps (managed by defaults/triggers).
    // unallocated_kobo starts at 0; the seeding trigger only sets
    // unallocated_kobo=amount_kobo on transition to CONFIRMED.
    const ins = await sql<any[]>`
      insert into payments (organization_id, method, status, amount_kobo,
                            reference, payer_name, payer_phone, payer_email, notes)
      values (${orgId}::uuid, 'BANK_TRANSFER', 'PENDING', ${amountKobo}::bigint,
              ${data.reference.trim()}, ${data.payerName.trim()},
              ${data.payerPhone?.trim() || null}, ${data.payerEmail?.trim() || null},
              ${'Submitted via payment link ' + token})
      returning id, payment_number, amount_kobo, status`;
    const pay = ins[0]!;
    await sql`
      insert into audit_events (organization_id, actor_type, action, entity_type, entity_id, after, metadata, request_id)
      values (${orgId}::uuid, 'USER'::audit_actor_type, 'payment.pending', 'payment', ${pay.id}::uuid,
              coalesce(${JSON.stringify({paymentNumber:pay.payment_number,amountKobo:Number(pay.amount_kobo),channel:'payment_link'})}::jsonb, '{}'::jsonb),
              coalesce(${JSON.stringify({linkToken:token,invoiceId:invId})}::jsonb, '{}'::jsonb),
              null)`;
    return NextResponse.json({
      payment: { paymentNumber: pay.payment_number, amountKobo: Number(pay.amount_kobo), status: pay.status },
    }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: e?.message ?? 'Could not record payment.' } }, { status: 400 });
  } finally {
    await sql`select auth_clear_public_context()`.catch(()=>{});
  }
}
