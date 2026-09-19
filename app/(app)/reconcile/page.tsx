/**
 * Reconciliation workbench.
 *
 * Shows incoming funds (PENDING + recent CONFIRMED) alongside unallocated
 * credit on CONFIRMED payments so a finance officer can allocate, confirm, or
 * reverse without guessing. No silent balance fixes; no parallel ledger.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type PayRow = {
  id: string; paymentNumber: string; method: string; status: string;
  amountKobo: number; unallocatedKobo: number; reference: string | null; paidAt: string | null; payerName: string | null;
};
type InvoiceRow = { id: string; invoiceNumber: string; studentName: string; totalKobo: number; paidKobo: number; remainingKobo: number; status: string; dueDate: string | null; };

async function load(): Promise<{ pending: PayRow[]; unalloc: PayRow[]; openInvoices: InvoiceRow[]; totals: { unallocatedKobo: number; pendingKobo: number; overdueKobo: number } }> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return { pending:[], unalloc:[], openInvoices:[], totals:{unallocatedKobo:0,pendingKobo:0,overdueKobo:0} };
  const [p, i] = await Promise.all([
    fetch(`${proto}://${host}/api/payments`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({payments:[]})),
    fetch(`${proto}://${host}/api/invoices`, { cache:'no-store', headers:{cookie} }).then(r=>r.json()).catch(()=>({invoices:[]})),
  ]);
  const pays = p.payments ?? [] as PayRow[];
  const invs = i.invoices ?? [] as InvoiceRow[];
  const pending = pays.filter((x: PayRow) => x.status === 'PENDING');
  const unalloc = pays.filter((x: PayRow) => x.status === 'CONFIRMED' && x.unallocatedKobo > 0);
  const open = invs.filter((x: InvoiceRow) => x.status !== 'VOID' && x.status !== 'DRAFT' && x.remainingKobo > 0);
  const today = new Date();
  const overdue = open.filter((x: InvoiceRow) => x.dueDate && new Date(x.dueDate) < today);
  const totals = {
    unallocatedKobo: unalloc.reduce((s: number, x: PayRow) => s + x.unallocatedKobo, 0),
    pendingKobo: pending.reduce((s: number, x: PayRow) => s + x.amountKobo, 0),
    overdueKobo: overdue.reduce((s: number, x: InvoiceRow) => s + x.remainingKobo, 0),
  };
  return { pending, unalloc, openInvoices: open, totals };
}

export default async function ReconcilePage() {
  const g = await checkPermission('payment.confirm');
  if (!g.allowed) return <AccessDenied surface="Reconciliation" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  const { pending, unalloc, openInvoices, totals } = await load();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Reconciliation</h1>
          <p className="mt-1 text-sm" style={{color:'var(--color-text-secondary)'}}>Incoming funds awaiting confirmation and payments with credit not yet assigned to an invoice.</p>
        </div>
        <Link href="/payments/new" className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)]">Record payment</Link>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Pending confirmation" value={<Money kobo={totals.pendingKobo} />} tone={totals.pendingKobo>0?'warn':'muted'} />
        <Stat label="Unallocated credit" value={<Money kobo={totals.unallocatedKobo} />} tone={totals.unallocatedKobo>0?'warn':'muted'} />
        <Stat label="Overdue outstanding" value={<Money kobo={totals.overdueKobo} />} tone={totals.overdueKobo>0?'danger':'muted'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Awaiting confirmation" description={`${pending.length} payment${pending.length===1?'':'s'} recorded but not confirmed.`} />
          {pending.length === 0
            ? <div className="p-6 text-center text-sm" style={{color:'var(--color-text-faint)'}}>Nothing pending — all caught up.</div>
            : <ul className="divide-y" style={{borderColor:'var(--color-border-subtle)'}}>
                {pending.map(p => (
                  <li key={p.id} className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/payments/${p.id}`} className="font-medium tabular-nums text-[13px]" style={{color:'var(--color-forest)'}}>{p.paymentNumber}</Link>
                      <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>{p.method.replace('_',' ')} · ref {p.reference||'—'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] tabular-nums font-semibold"><Money kobo={p.amountKobo} size="sm" hideDecimals /></div>
                      <Badge variant="warning">Pending</Badge>
                    </div>
                  </li>
                ))}
              </ul>}
        </Card>

        <Card>
          <CardHeader title="Unallocated credit" description="Payments confirmed but with credit not yet applied to an invoice." />
          {unalloc.length === 0
            ? <div className="p-6 text-center text-sm" style={{color:'var(--color-text-faint)'}}>No unallocated credit sitting on payments.</div>
            : <ul className="divide-y" style={{borderColor:'var(--color-border-subtle)'}}>
                {unalloc.map(p => (
                  <li key={p.id} className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/payments/${p.id}`} className="font-medium tabular-nums text-[13px]" style={{color:'var(--color-forest)'}}>{p.paymentNumber}</Link>
                      <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>{p.method.replace('_',' ')} · {p.payerName||'payer'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] tabular-nums font-semibold" style={{color:'var(--color-gold-dark,#8a6b11)'}}><Money kobo={p.unallocatedKobo} size="sm" hideDecimals /></div>
                      <div className="text-[10px] mt-0.5 uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>unallocated</div>
                    </div>
                  </li>
                ))}
              </ul>}
        </Card>
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader title="Open invoices" description={`${openInvoices.length} invoice${openInvoices.length===1?'':'s'} awaiting payment.`} />
          {openInvoices.length === 0
            ? <div className="p-6 text-center text-sm" style={{color:'var(--color-text-faint)'}}>No open invoices — all paid up.</div>
            : <table className="w-full text-sm">
                <thead><tr style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                  <Th>Invoice</Th><Th>Student</Th><Th className="text-right">Total</Th><Th className="text-right">Paid</Th><Th className="text-right">Balance</Th><Th>Status</Th>
                </tr></thead>
                <tbody>
                  {openInvoices.map(i => {
                    const overdue = i.dueDate && new Date(i.dueDate) < new Date();
                    return (
                      <tr key={i.id} style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                        <td className="px-4 py-3"><Link href={`/invoices/${i.id}`} className="font-medium tabular-nums" style={{color:'var(--color-forest)'}}>{i.invoiceNumber}</Link></td>
                        <td className="px-3 py-3">{i.studentName}</td>
                        <td className="px-3 py-3 text-right tabular-nums" style={{color:'var(--color-text-secondary)'}}><Money kobo={i.totalKobo} size="sm" /></td>
                        <td className="px-3 py-3 text-right tabular-nums" style={{color:'var(--color-forest-deep)'}}><Money kobo={i.paidKobo} size="sm" /></td>
                        <td className="px-3 py-3 text-right tabular-nums font-medium" style={{color:overdue?'var(--color-danger,#a82a1c)':'var(--color-gold-dark,#8a6b11)'}}><Money kobo={i.remainingKobo} size="sm" /></td>
                        <td className="px-3 py-3">{overdue ? <Badge variant="danger">Overdue</Badge> : <Badge variant="warning">Open</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone='default' }:{label:string;value:React.ReactNode;tone?:'default'|'warn'|'danger'|'muted'}) {
  const colors = { default:'var(--color-text-primary)', warn:'var(--color-gold-dark,#8a6b11)', danger:'var(--color-danger,#a82a1c)', muted:'var(--color-text-faint)' } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{borderColor:'var(--color-border-subtle)',backgroundColor:'var(--color-bg-page)'}}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{color:colors[tone]}}>{value}</div>
    </div>
  );
}
function Th({ children, className='' }: { children?:React.ReactNode; className?:string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{color:'var(--color-text-faint)'}}>{children}</th>;
}
