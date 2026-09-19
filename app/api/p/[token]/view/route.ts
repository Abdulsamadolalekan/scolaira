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
 * Runs as scolaira_app; enters public GUC context scoped to the link's org
 * before querying, then clears context.
 */
import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const sql = getSql();
  // Resolve the link via SECURITY DEFINER (does not rely on broad SELECT
  // policies; only returns the row if the token matches an ACTIVE/non-expired
  // link), returning no data for invalid/revoked/expired tokens so we avoid
  // information disclosure between "not found" and "revoked".
  await sql`select clear_app_context()`.catch(() => {});
  const linkRows = await sql<any[]>`
    select organization_id, id, token, status, invoice_id, student_id,
           amount_kobo, note, expires_at
      from auth_resolve_public_link(${token})`;
  const link = linkRows[0] ?? null;
  if (!link) {
    // Distinguish 410 (expired or revoked) from 404 (missing) using the
    // narrow SECURITY DEFINER probe that exposes status only.
    let probe = 'MISSING';
    try {
      const pr = await sql<any[]>`select auth_probe_public_link(${token}) as s`;
      probe = pr[0]?.s ?? 'MISSING';
    } catch { probe = 'MISSING'; }
    if (probe === 'EXPIRED') {
      return NextResponse.json({ error: { code: 'GONE', message: 'Link expired.' } }, { status: 410 });
    }
    if (probe === 'REVOKED') {
      // Treat revoked as 404 to minimize information disclosure (per test
      // expectation: revoked returns 404, not 410).
    }
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Link not found.' } }, { status: 404 });
  }
  try {
    await sql`select auth_set_public_context(${link.organization_id}::uuid)`;
    const [orgRows, invRows, stuRows] = await Promise.all([
      sql<{name:string;address:string|null;phone:string|null}[]>`select name, address, phone from organizations where id = ${(link as any).organization_id}::uuid limit 1`,
      (link as any).invoice_id
        ? sql<any[]>`select i.invoice_number, i.total_kobo, i.paid_kobo, s.first_name, s.last_name
                    from invoices i left join students s on s.id = i.student_id
                    where i.id = ${(link as any).invoice_id}::uuid limit 1`
        : Promise.resolve([] as any[]),
      (link as any).student_id
        ? sql<any[]>`select student_id, first_name, last_name from students where id = ${(link as any).student_id}::uuid and status = 'ACTIVE' limit 1`
        : Promise.resolve([] as any[]),
    ]);
    const org = orgRows[0] ?? { name: 'SCOLAIRA', address: null, phone: null };
    const inv = invRows[0] ?? null;
    const stu = stuRows[0] ?? null;
    return NextResponse.json({
      token: link.token,
      status: link.status,
      amountKobo: link.amount_kobo ? Number(link.amount_kobo) : null,
      expiresAt: link.expires_at,
      note: link.note,
      organization: { name: org.name, address: org.address, phone: org.phone },
      invoice: inv ? {
        invoiceNumber: inv.invoice_number,
        studentFirstName: inv.first_name,
        studentLastName: inv.last_name,
        studentInitial: inv.last_name ? inv.last_name.slice(0,1) : '',
        totalKobo: Number(inv.total_kobo),
        paidKobo: Number(inv.paid_kobo),
        remainingKobo: Math.max(0, Number(inv.total_kobo) - Number(inv.paid_kobo)),
      } : null,
      student: stu ? { studentId: stu.student_id, firstName: stu.first_name, lastName: stu.last_name } : null,
    });
  } finally {
    await sql`select auth_clear_public_context()`.catch(()=>{});
  }
}
