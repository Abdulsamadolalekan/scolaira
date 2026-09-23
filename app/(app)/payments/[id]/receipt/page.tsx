/**
 * Printable receipt of record.
 *
 * Server component: loads the payment, ensures the caller has receipt.read,
 * issues a receipt row on first visit (idempotent — returns existing ISSUED
 * receipt if one exists), then renders the receipt from the receipts table
 * rather than ad-hoc from the payment. This preserves receipt numbering,
 * auditability and immutability.
 */
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';

export const runtime = 'nodejs';

type ReceiptView = {
  receipt: { id:string; receiptNumber:string; status:string; amountKobo:number; issuedAt:string|null; voidedReason:string|null; paymentId:string };
  payment: { paymentNumber:string; method:string; reference:string|null; paidAt:string|null; recordedAt:string|null; payerName:string|null; notes:string|null; amountKobo:number; unallocatedKobo:number };
  allocations: Array<{ invoiceNumber:string; studentName:string; amountKobo:number }>;
  organization: { name:string; address:string|null; phone:string|null };
};

/**
 * Issue (or resolve) the receipt of record for a payment.
 *
 * R2/H-7: receipts are financial documents, so the API requires an
 * Idempotency-Key, and — like every client-side mutation — the double-submit
 * CSRF header, which the browser client normally supplies from the cs_csrf
 * cookie. This server component re-sends the caller's own cookie value as the
 * header. (It previously sent neither, and read a `receiptId` field the route
 * never returned, so the printable receipt page could not render at all.)
 */
async function issueReceipt(host: string, proto: string, cookie: string, paymentId: string): Promise<string | null> {
  const csrf = /(?:^|;\s*)sc_csrf=([^;]+)/.exec(cookie)?.[1];
  const res = await fetch(`${proto}://${host}/api/receipts`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      cookie,
      'content-type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
    },
    body: JSON.stringify({ paymentId }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.receipt?.id ?? null;
}

async function fetchReceipt(host: string, proto: string, cookie: string, receiptId: string): Promise<ReceiptView | null> {
  const res = await fetch(`${proto}://${host}/api/receipts/${receiptId}`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return null;
  return res.json();
}

async function findIssuedReceipt(host: string, proto: string, cookie: string, paymentId: string): Promise<string | null> {
  // Use existing payment detail; but to avoid duplicating logic, issue-then-fetch
  // is the idempotent path (POST returns existing id if one is ISSUED).
  return issueReceipt(host, proto, cookie, paymentId);
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: paymentId } = await params;
  const g = await checkPermission('receipt.read');
  if (!g.allowed) {
    return (
      <main className="p-8 text-center">
        <p>You do not have permission to view receipts.</p>
        <Link href={`/payments/${paymentId}`} className="text-sm" style={{color:'var(--color-forest)'}}>Back to payment</Link>
      </main>
    );
  }
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return notFound();

  // Must confirm the payment is in a receipt-able state.
  const payRes = await fetch(`${proto}://${host}/api/payments/${paymentId}`, { cache:'no-store', headers:{cookie} });
  if (!payRes.ok) return notFound();
  const payData = await payRes.json();
  const p = payData.payment;
  if (!p || p.status !== 'CONFIRMED') {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-lg font-semibold">Receipt not available</h1>
        <p className="mt-2 text-sm" style={{color:'var(--color-text-secondary)'}}>
          Payment {p?.paymentNumber ?? paymentId} is {p?.status?.toLowerCase() ?? 'not confirmed'}. Receipts are only issued for confirmed payments with at least one allocation.
        </p>
        <Link href={`/payments/${paymentId}`} className="mt-4 inline-block text-sm" style={{color:'var(--color-forest)'}}>Back to payment</Link>
      </main>
    );
  }

  const receiptId = await findIssuedReceipt(host, proto, cookie, paymentId);
  if (!receiptId) {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-lg font-semibold">Could not issue receipt</h1>
        <p className="mt-2 text-sm" style={{color:'var(--color-text-secondary)'}}>
          A receipt can only be issued once at least one allocation exists. Allocate the payment to an invoice first.
        </p>
        <Link href={`/payments/${paymentId}`} className="mt-4 inline-block text-sm" style={{color:'var(--color-forest)'}}>Back to payment</Link>
      </main>
    );
  }
  const r = await fetchReceipt(host, proto, cookie, receiptId);
  if (!r) return notFound();
  if (r.receipt.status === 'VOID') {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-lg font-semibold">This receipt has been voided.</h1>
        <Link href={`/payments/${paymentId}`} className="mt-4 inline-block text-sm" style={{color:'var(--color-forest)'}}>Back to payment</Link>
      </main>
    );
  }

  const totalAllocated = r.allocations.reduce((s, a) => s + a.amountKobo, 0);
  const unallocated = Math.max(0, r.payment.amountKobo - totalAllocated);
  const paidAt = r.payment.paidAt ? new Date(r.payment.paidAt) : (r.payment.recordedAt ? new Date(r.payment.recordedAt) : new Date(r.receipt.issuedAt!));

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 print:py-4">
      <div className="flex items-center justify-between mb-6 print:hidden">
        <Link href={`/payments/${paymentId}`} className="text-sm" style={{color:'var(--color-text-secondary)'}}>← Back to payment</Link>
        <button onClick={()=>window.print()} className="rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white">Print receipt</button>
      </div>
      <article className="rounded-lg border bg-white px-8 py-8 shadow-sm print:border-0 print:shadow-none" style={{borderColor:'var(--color-border-subtle)'}}>
        <header className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-widest" style={{color:'var(--color-text-faint)'}}>{r.organization.name}</div>
            {r.organization.address && <div className="mt-0.5 text-xs" style={{color:'var(--color-text-secondary)'}}>{r.organization.address}</div>}
            {r.organization.phone && <div className="text-xs" style={{color:'var(--color-text-secondary)'}}>{r.organization.phone}</div>}
          </div>
          <div className="text-right">
            <h2 className="text-xl font-semibold" style={{fontFamily:'var(--font-serif)',color:'var(--color-forest-deepest)'}}>Receipt</h2>
            <div className="mt-1 text-xs tabular-nums" style={{color:'var(--color-text-secondary)'}}>No. {r.receipt.receiptNumber}</div>
            <div className="text-xs" style={{color:'var(--color-text-secondary)'}}>{paidAt.toLocaleDateString('en-NG',{year:'numeric',month:'long',day:'numeric'})}</div>
          </div>
        </header>

        <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Received from</div>
            <div className="mt-1 font-medium">{r.payment.payerName || 'Payer'}</div>
            <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>Payment {r.payment.paymentNumber}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-medium" style={{color:'var(--color-text-faint)'}}>Method</div>
            <div className="mt-1 font-medium">{r.payment.method.replace('_',' ')}</div>
            {r.payment.reference && <div className="text-[11px] mt-0.5" style={{color:'var(--color-text-faint)'}}>Ref {r.payment.reference}</div>}
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
            {r.allocations.map((a, i) => (
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
              <td className="pt-3 text-right text-lg font-semibold tabular-nums"><Money kobo={r.receipt.amountKobo} /></td>
            </tr>
          </tbody>
        </table>

        {r.payment.notes && (
          <div className="mt-6 text-[11px]" style={{color:'var(--color-text-faint)'}}>Note: {r.payment.notes}</div>
        )}
        <footer className="mt-8 pt-4 text-[10px] text-center" style={{borderTop:'1px dashed var(--color-border-subtle)',color:'var(--color-text-faint)'}}>
          Generated by Scolaira · Thank you.
        </footer>
      </article>
      <style>{`@media print{@page{margin:16mm;}body{background:white;}}`}</style>
    </main>
  );
}
