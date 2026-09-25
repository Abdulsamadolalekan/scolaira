/**
 * Printable statement of account for one student — server-rendered,
 * authenticated, minimal chrome (no nav shell). The page is also
 * print-styled: `window.print()` produces a clean document ready for
 * a printer or PDF.
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type Detail = {
  student: { id: string; studentId: string; name: string };
  invoices: Array<{ id: string; invoiceNumber: string; dueDate: string|null; remainingKobo: number; daysOverdue: number }>;
  summary: { outstandingKobo: number };
};

async function load(id: string): Promise<Detail | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/debtors/${encodeURIComponent(id)}`, { cache: 'no-store', headers: { cookie } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

function fmt(k: number) {
  return '₦' + (k/100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function StatementPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const read = await checkPermission('debtor.read');
  if (!read.allowed) return <AccessDenied surface="Statement of account" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const d = await load(studentId);
  if (!d) notFound();
  const open = d.invoices.filter(i => i.remainingKobo > 0);
  const now = new Date().toLocaleString();

  return (
    <>
      <style>{`
        body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fff;color:#111;margin:0}
        .wrap{max-width:720px;margin:0 auto;padding:32px}
        .eyebrow{color:#666;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
        h1{font-size:24px;margin:4px 0 4px;font-weight:600}
        .sub{color:#666;font-size:12px;margin:0 0 24px}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th,td{padding:8px 6px;border-bottom:1px solid #e5e5e5;text-align:left}
        th{background:#f6f2e7;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555}
        .r{text-align:right}.total{font-weight:700}
        .cta{margin-top:24px;display:flex;gap:8px}
        .btn{padding:8px 16px;background:#2f4f3b;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:13px}
        .btn.secondary{background:#eee;color:#111}
        .org{font-size:14px;color:#2f4f3b;font-weight:600;margin-bottom:24px;letter-spacing:.02em}
        @media print{
          .no-print{display:none!important}
          .wrap{padding:16mm}
          body{background:#fff}
        }
      `}</style>
      <div className="wrap">
        <div className="eyebrow">Statement of Account</div>
        <h1>{d.student.name}</h1>
        <p className="sub">{d.student.studentId} · Generated {now}</p>

        <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', color: '#666', margin: '20px 0 8px' }}>Outstanding Invoices</h2>
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
            {open.map(i => (
              <tr key={i.id}>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{i.invoiceNumber}</td>
                <td style={{ color: '#555' }}>{i.dueDate ?? '—'}</td>
                <td style={{ color: i.daysOverdue > 90 ? '#a82a1c' : (i.daysOverdue > 0 ? '#8a6b11' : '#666') }}>
                  {i.daysOverdue > 0 ? `${i.daysOverdue} days` : ''}
                </td>
                <td className="r" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt(i.remainingKobo)}</td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: '#666', padding: '24px 6px' }}>No outstanding balance.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="r total">Total outstanding</td>
              <td className="r total">{fmt(d.summary.outstandingKobo)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="cta no-print">
          <button className="btn" onClick={() => window.print()}>Print / Save as PDF</button>
          <button className="btn secondary" onClick={() => history.back()}>Back</button>
        </div>
      </div>
    </>
  );
}
