/**
 * GET /api/p/[token]/view — public (no auth) link resolution.
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
 * R3 (H-3) — the payload says only what a payer needs to make one payment:
 *   - the amounts DUE (never the invoice's total or already-paid history),
 *   - the invoice number and the student's first name + last initial,
 *   - the school's name and a contact phone.
 * It deliberately no longer echoes the token, the student's internal
 * identifier, the student's full surname, the school's address, or the
 * invoice's total/paid amounts: holding the URL is not a licence to read a
 * family's financial history (measured before R3: all of those were returned).
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

  // (1) Bearer resolution with no tenant context, plus the single authoritative
  //     "what is due" rule (the same function the submission entry point uses).
  const resolved = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
    const rows = await sql<any[]>`
      select organization_id, id, invoice_id, student_id, note, expires_at
        from auth_resolve_public_link(${token})`;
    if (!rows[0]) return null;
    const due = (await sql<any[]>`select auth_public_amount_due(${token}) as due_kobo`) as any[];
    return { ...rows[0], due_kobo: due[0]?.due_kobo ?? null };
  });

  if (!resolved) {
    return missResponse(token);
  }
  const link = resolved;

  try {
    // (2) Public context derived from the bearer token itself.
    const payload = await withPublicScope(token, async (_db, sql) => {
      const [orgRows, invRows, stuRows] = await Promise.all([
        sql<{ name: string; phone: string | null }[]>`
          select name, phone from organizations where id = ${link.organization_id}::uuid limit 1`,
        link.invoice_id
          ? sql<any[]>`
              select i.invoice_number, s.first_name, s.last_name
                from invoices i left join students s on s.id = i.student_id
               where i.id = ${link.invoice_id}::uuid limit 1`
          : Promise.resolve([] as any[]),
        link.student_id
          ? sql<any[]>`
              select first_name, last_name from students
               where id = ${link.student_id}::uuid and status = 'ACTIVE' limit 1`
          : Promise.resolve([] as any[]),
      ]);
      const org = orgRows[0] ?? { name: 'SCOLAIRA', phone: null };
      const inv = invRows[0] ?? null;
      const stu = stuRows[0] ?? null;
      const initial = (name: string | null | undefined) =>
        name && name.length > 0 ? name.slice(0, 1).toUpperCase() : '';
      return {
        amountDueKobo: link.due_kobo === null ? null : Number(link.due_kobo),
        expiresAt: link.expires_at,
        note: link.note,
        organization: { name: org.name, phone: org.phone },
        invoice: inv
          ? {
              invoiceNumber: inv.invoice_number,
              studentFirstName: inv.first_name,
              studentInitial: initial(inv.last_name),
            }
          : null,
        student: stu
          ? { firstName: stu.first_name, initial: initial(stu.last_name) }
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
 * behaviour: revoked deliberately reports 404 to minimise disclosure. No
 * miss response carries any tenant, invoice or amount information.
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
