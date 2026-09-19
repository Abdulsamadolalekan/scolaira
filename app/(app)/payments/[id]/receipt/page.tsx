/**
 * Printable receipt for a CONFIRMED payment.
 *
 * Only CONFIRMED payments produce a receipt. PENDING/REVERSED payments return
 * 403 with an explanation. We render server-side with a print stylesheet so a
 * finance officer can Cmd/Ctrl-P directly.
 */
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';

export const runtime = 'nodejs';

type PaymentView = {
  payment: { id:string; paymentNumber:string; method:string; status:string; amountKobo:number; reference:string|null; paidAt:string|null; recordedAt:string|null; payerName:string|null; notes:string|null };
  organization: { name:string; address:string|null; phone:string|null };
  allocations: Array<{ invoiceNumber:string; studentName:string; amountKobo:number }>;
};

async function load(id: string): Promise<PaymentView | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  const res = await fetch(`${proto}://${host}/api/payments/${id}`, { cache:'no-store', headers:{cookie} });
  if (!res.ok) return null;
  return res.json();
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await checkPermission('payment.read');
  if (!g.allowed) return <main className="p-8 text-center text-sm">You do not have permission to view receipts.</main>;
  const p = await load(id);
  if (!p) notFound();
  if (p.payment.status !== 'CONFIRMED') {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-lg font-semibold">Receipt not available</h1>
        <p className="mt-2 text-sm" style={{color:'var(--color-text-secondary)'}}>
          Payment {p.payment.paymentNumber} is {p.payment.status.toLowerCase()}. Receipts are only issued for confirmed payments.
        </p>
        <Link href={`/payments/${id}`} className="mt-4 inline-block text-sm" style={{color:'var(--color-forest)'}}>Back to payment</Link>
      </main>
    );
  }
  const allocated = p.allocations.reduce((s, a) => s + a.amountKobo, 0);
  const unallocated = p.payment.amountKobo - allocated;
  const paidAt = p.payment.paidAt ? new Date(p.payment.paidAt) : (p.payment.recordedAt ? new Date(p.payment.recordedAt) : new Date());

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 print:py-4">
      <div className="flex items-center justify-between mb-6 print:hidden">
        <Link href={`/payments/${id}`} className="text-sm" style={{color:'var(--color-text-secondary)'}}>← Back to payment</Link>
        <button onClick={()=>window.print()} className="rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white">Print receipt</button>
      </div>
      <article className="rounded-lg border bg-white px-8 py-8 shadow-sm print:border-0 print:shadow-none" style={{borderColor:'var(--color-border-subtle)'}}>
        <header className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-widest" style={{color:'var(--color-text-faint)'}}>{p.organization.name}</div>
            {p.organization.address && <div className="mt-0.5 text-xs" style={{color:'var(--color-text-secondary)'}}>{p.organization.address}</div>}
            {p.organization.phone && <div className="text-xs" style={{color:'var(--color-text-secondary)'}}>{p.organization.phone}</div>}
          </div>
          <div className="text-right">
            <h2 className="text-xl font-semibold" style={{fontFamily:'var(--font-serif)',color:'var(--color-forest-deepest)'}}>Receipt</h2>
            <div className="mt-1 text-xs tabular-nums" style={{color:'var(--color-text-secondary)'}}>No. {p.payment.paymentNumber}</div>
            <div className="text-xs" style={{color:'var(--color-text-secondary)'}}>{paidAt.toLocaleDateString('en-NG',{year:'numeric',month:'long',day:'numeric'})}</div>
          </div>
        </header>
        <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Received from</div>
            <div className="mt-1 font-medium">{p.payment.payerName || 'Payer'}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Method</div>
            <div className="mt-1 font-medium">{p.payment.method.replace('_',' ')}</div>
            {p.payment.reference && <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>Ref {p.payment.reference}</div>}
          </div>
        </div>

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr style={{borderBottom:'1px solid var(--color-border)'}}>
              <th className="py-2 text-left text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Description</th>
              <th className="py-2 text-right text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.allocations.map((a, i) => (
              <tr key={i} style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                <td className="py-2">Payment applied to {a.invoiceNumber} — {a.studentName}</td>
                <td className="py-2 text-right tabular-nums"><Money kobo={a.amountKobo} /></td>
              </tr>
            ))}
            {unallocated > 0 && (
              <tr style={{borderBottom:'1px solid var(--color-border-subtle)'}}>
                <td className="py-2" style={{color:'var(--color-text-secondary)'}}>Unallocated credit (held on account)</td>
                <td className="py-2 text-right tabular-nums" style={{color:'var(--color-text-secondary)'}}><Money kobo={unallocated} /></td>
              </tr>
            )}
            <tr>
              <td className="pt-3 text-right text-[11px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Total received</td>
              <td className="pt-3 text-right text-lg font-semibold tabular-nums"><Money kobo={p.payment.amountKobo} /></td>
            </tr>
          </tbody>
        </table>

        {p.payment.notes && (
          <div className="mt-6 text-[11px]" style={{color:'var(--color-text-faint)'}}>Note: {p.payment.notes}</div>
        )}
        <footer className="mt-8 pt-4 text-[10px] text-center" style={{borderTop:'1px dashed var(--color-border-subtle)',color:'var(--color-text-faint)'}}>
          Generated by Scolaira · Thank you.
        </footer>
      </article>
      <style>{`
        @media print { @page { margin: 16mm; } body { background: white; } }
      `}</style>
    </main>
  );
}
