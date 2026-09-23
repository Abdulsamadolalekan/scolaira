/**
 * GET /api/p/[token]/view — public (no auth) link resolution.
 *
 * Returns enough information to render the payment-link landing page:
 *   - link status/amount/note/expiry
 *   - related invoice (number + student first name + last initial + balances)
 *   - related student (if link is student-scoped rather than invoice-scoped)
 *   - organization name/address/phone
 *
 * The response is PII-minimized by design (first name + last initial only).
 *
 * R1 (C-3) — the bearer token is the ONLY thing that establishes tenant scope:
 *
 *   1. the token is resolved with NO tenant context (the resolver is a
 *      SECURITY DEFINER that returns a row only for the exact token it was
 *      given, and only while that link is ACTIVE and unexpired);
 *   2. the protected reads then run inside `withPublicScope(token, …)`, which
 *      derives the organization FROM THE LINK ROW — never from the caller —
 *      and mints a proof bound to (token, organization, backend);
 *   3. the RLS policies that expose invoice/student/organization rows to
 *      public traffic require that proof, so a forged `app.public_context`
 *      marker or a caller-chosen `app.organization_id` authorizes nothing.
 *
 * The scope re-resolves the token, so a link revoked or expired between (1)
 * and (2) fails closed.
 */
import { NextResponse } from 'next/server';
import {
  isPublicLinkUnusable,
  probePublicLinkStatus,
  withPublicScope,
  withScopedDb,
} from '@/lib/db/tenant';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // (1) Bearer resolution with no tenant context.
  const link = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
    const rows = await sql<any[]>`
      select organization_id, id, token, status, invoice_id, student_id,
             amount_kobo, note, expires_at
        from auth_resolve_public_link(${token})`;
    return rows[0] ?? null;
  });

  if (!link) {
    return missResponse(token);
  }

  try {
    // (2) Public context derived from the bearer token itself.
    const payload = await withPublicScope(token, async (_db, sql) => {
      const [orgRows, invRows, stuRows] = await Promise.all([
        sql<{ name: string; address: string | null; phone: string | null }[]>`
          select name, address, phone from organizations where id = ${link.organization_id}::uuid limit 1`,
        link.invoice_id
          ? sql<any[]>`
              select i.invoice_number, i.total_kobo, i.paid_kobo, s.first_name, s.last_name
                from invoices i left join students s on s.id = i.student_id
               where i.id = ${link.invoice_id}::uuid limit 1`
          : Promise.resolve([] as any[]),
        link.student_id
          ? sql<any[]>`
              select student_id, first_name, last_name from students
               where id = ${link.student_id}::uuid and status = 'ACTIVE' limit 1`
          : Promise.resolve([] as any[]),
      ]);
      const org = orgRows[0] ?? { name: 'SCOLAIRA', address: null, phone: null };
      const inv = invRows[0] ?? null;
      const stu = stuRows[0] ?? null;
      return {
        token: link.token,
        status: link.status,
        amountKobo: link.amount_kobo ? Number(link.amount_kobo) : null,
        expiresAt: link.expires_at,
        note: link.note,
        organization: { name: org.name, address: org.address, phone: org.phone },
        invoice: inv
          ? {
              invoiceNumber: inv.invoice_number,
              studentFirstName: inv.first_name,
              studentLastName: inv.last_name,
              studentInitial: inv.last_name ? inv.last_name.slice(0, 1) : '',
              totalKobo: Number(inv.total_kobo),
              paidKobo: Number(inv.paid_kobo),
              remainingKobo: Math.max(0, Number(inv.total_kobo) - Number(inv.paid_kobo)),
            }
          : null,
        student: stu
          ? { studentId: stu.student_id, firstName: stu.first_name, lastName: stu.last_name }
          : null,
      };
    });
    return NextResponse.json(payload);
  } catch (error) {
    // Revoked/expired between resolution and scope entry: fail closed exactly
    // as if the link had been unusable from the start.
    if (isPublicLinkUnusable(error)) {
      return missResponse(token);
    }
    throw error;
  }
}

/**
 * 404 for missing/revoked and 410 for expired, matching the historical
 * behaviour: revoked deliberately reports 404 to minimise disclosure.
 */
async function missResponse(token: string): Promise<NextResponse> {
  const status = await probePublicLinkStatus(token);
  if (status === 'EXPIRED') {
    return NextResponse.json(
      { error: { code: 'GONE', message: 'Link expired.' } },
      { status: 410 },
    );
  }
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'Link not found.' } },
    { status: 404 },
  );
}
