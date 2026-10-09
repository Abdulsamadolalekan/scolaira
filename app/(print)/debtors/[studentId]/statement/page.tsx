/**
 * Printable statement of account for one student — server-rendered,
 * authenticated, minimal chrome (no nav shell). The page is also
 * print-styled: `window.print()` produces a clean document ready for
 * a printer or PDF.
 */
import { notFound } from 'next/navigation';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { StatementActions } from '@/components/ui/print-actions';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';

export const runtime = 'nodejs';

type Detail = {
  student: { id: string; studentId: string; name: string };
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    dueDate: string | null;
    remainingKobo: number;
    daysOverdue: number;
  }>;
  summary: { outstandingKobo: number };
};

async function load(id: string): Promise<Detail | null> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return null;
  const res = await fetch(`${base}/api/debtors/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

function fmt(k: number) {
  return (
    '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export default async function StatementPage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const { studentId } = await params;
  const read = await checkPermission('debtor.read');
  if (!read.allowed)
    return (
      <AccessDenied
        surface="Statement of account"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const d = await load(studentId);
  if (!d) notFound();
  const open = d.invoices.filter((i) => i.remainingKobo > 0);
  const now = new Date().toLocaleString();

  return (
    <>
      <style>{`
        /* The statement is a document the school hands to a family and the family
           keeps, so it is set as an institutional record: warm paper, a serif
           statement header, ruled rows, tabular figures, and the school's name
           carried as a small-caps imprint rather than a coloured label. */
        body{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff;color:#17201c;margin:0}
        .wrap{max-width:720px;margin:0 auto;padding:36px 32px}
        .eyebrow{color:#5c6b64;font-size:10px;letter-spacing:.18em;text-transform:uppercase;font-weight:600}
        h1{font-family:'Source Serif 4',Georgia,Cambria,'Times New Roman',serif;font-size:27px;margin:8px 0 2px;font-weight:400;letter-spacing:-.01em;color:#0b3d2e}
        .sub{color:#5c6b64;font-size:12px;margin:0 0 28px}
        .org{font-size:11px;color:#0b3d2e;font-weight:600;letter-spacing:.14em;text-transform:uppercase;margin:0 0 26px;padding-bottom:10px;border-bottom:1px solid #0b3d2e}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th,td{padding:9px 6px;border-bottom:1px solid #e6eae7;text-align:left}
        th{font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#5c6b64;border-bottom:1px solid #b7c0bb}
        td{font-variant-numeric:tabular-nums}
        .r{text-align:right}
        .total{font-weight:600;border-top:1.5px solid #17201c;border-bottom:0;padding-top:12px;font-size:14px}
        .cta{margin-top:28px;display:flex;gap:8px}
        .btn{padding:9px 16px;background:#0b3d2e;color:#fdfbf6;border:0;border-radius:2px;cursor:pointer;font-size:13px}
        .btn.secondary{background:transparent;color:#17201c;border:1px solid #b7c0bb}
        @media print{
          .no-print{display:none!important}
          .wrap{padding:16mm}
          body{background:#fff}
        }
      `}</style>
      <div className="wrap">
        <div className="eyebrow">Statement of account</div>
        <h1>{d.student.name}</h1>
        <p className="sub">
          {d.student.studentId} · Generated {now}
        </p>

        <h2
          style={{
            fontSize: 13,
            textTransform: 'uppercase',
            letterSpacing: '.08em',
            color: '#666',
            margin: '20px 0 8px',
          }}
        >
          Outstanding Invoices
        </h2>
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Due</th>
              <th>Overdue</th>
              <th className="r">Balance</th>
            </tr>
          </thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.id}>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                  {i.invoiceNumber}
                </td>
                <td style={{ color: '#555' }}>{i.dueDate ?? '—'}</td>
                <td
                  style={{
                    color: i.daysOverdue > 90 ? '#a82a1c' : i.daysOverdue > 0 ? '#8a6b11' : '#666',
                  }}
                >
                  {i.daysOverdue > 0 ? `${i.daysOverdue} days` : ''}
                </td>
                <td className="r" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                  {fmt(i.remainingKobo)}
                </td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: '#666', padding: '24px 6px' }}>
                  No outstanding balance.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="r total">
                Total outstanding
              </td>
              <td className="r total">{fmt(d.summary.outstandingKobo)}</td>
            </tr>
          </tfoot>
        </table>

        <StatementActions />
      </div>
    </>
  );
}
