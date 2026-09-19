/**
 * Public payment-link landing page (/p/[token]).
 *
 * No authentication required; the token is a bearer secret (128-bit nanoid).
 * Shows what is being paid, the school name, bank-transfer instructions, and
 * a form for the payer to record a teller reference. Submission creates a
 * PENDING payment for the bursar to reconcile — NO fake PSP, NO silent
 * allocation, NO confirmation on the payer's behalf.
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import SubmitForm from './submit-form';

export const runtime = 'nodejs';

type LinkView = {
  token: string; status: string; amountKobo: number|null; expiresAt: string|null; note: string|null;
  invoice: { invoiceNumber: string; studentFirstName: string; studentLastName: string; studentInitial: string; totalKobo: number; paidKobo: number; remainingKobo: number } | null;
  student: { studentId: string; firstName: string; lastName: string } | null;
  organization: { name: string; address: string|null; phone: string|null };
};

async function loadLink(token: string): Promise<LinkView | null> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return null;
  // Internal server-side fetch to an internal JSON endpoint would be complex
  // with public context; instead run via a single direct SQL query that sets
  // public context only for this request. To keep this a server component we
  // call a lightweight internal API route that performs the public-context
  // resolution and returns JSON.
  try {
    const res = await fetch(`${proto}://${host}/api/p/${token}/view`, { cache: 'no-store', headers: { cookie } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export default async function PublicPaymentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await loadLink(token);
  if (!link) notFound();
  const studentName = link.invoice?.studentFirstName
    ? `${link.invoice.studentFirstName} ${link.invoice.studentInitial || ''}.`
    : (link.student ? `${link.student.firstName} ${link.student.lastName.slice(0,1)}.` : 'a student');
  const due = link.invoice ? link.invoice.remainingKobo : (link.amountKobo ?? 0);
  const amount = due;
  return (
    <main className="min-h-screen" style={{ background: 'var(--color-ivory, #faf7f1)' }}>
      <div className="mx-auto max-w-xl px-4 py-10">
        <div className="rounded-xl bg-white p-8 shadow-sm" style={{ border: '1px solid var(--color-border-subtle)' }}>
          <div className="text-[11px] uppercase tracking-widest" style={{ color: 'var(--color-text-faint)' }}>{link.organization.name}</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>
            Make a payment
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Pay {link.organization.name} directly via bank transfer and tell us your teller number. The school will confirm your payment shortly.
          </p>

          <div className="mt-6 rounded-md p-4" style={{ backgroundColor: 'var(--color-forest-tint)', border: '1px solid var(--color-border-subtle)' }}>
            <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-forest-deep)' }}>Amount due</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--color-forest-deepest)' }}>
              ₦{(amount/100).toLocaleString('en-NG',{minimumFractionDigits:0})}
            </div>
            {link.invoice && (
              <div className="mt-2 text-sm" style={{ color: 'var(--color-forest-deep)' }}>
                Invoice <span className="font-mono tabular-nums">{link.invoice.invoiceNumber}</span> · {studentName}
              </div>
            )}
            {!link.invoice && link.student && (
              <div className="mt-2 text-sm" style={{ color: 'var(--color-forest-deep)' }}>
                For {link.student.firstName} {link.student.lastName} ({link.student.studentId})
              </div>
            )}
            {link.note && <div className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{link.note}</div>}
          </div>

          <div className="mt-6 text-sm space-y-2">
            <div>
              <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--color-text-faint)' }}>How to pay</div>
              <ol className="mt-1 list-decimal pl-5 space-y-1" style={{ color: 'var(--color-text-secondary)' }}>
                <li>Transfer the exact amount to the school&apos;s bank account (contact the school for account details).</li>
                <li>Use your invoice/payment reference in the transfer narration if possible.</li>
                <li>Fill in the form below with your name, email/phone, and the bank teller/transfer reference.</li>
                <li>Keep your receipt; the bursar will confirm your payment during reconciliation.</li>
              </ol>
            </div>
            {link.organization.phone && (
              <div className="text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
                Need help? Contact the school at {link.organization.phone}.
              </div>
            )}
          </div>

          <SubmitForm token={token} />
        </div>
        <div className="mt-4 text-center text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
          Secured by Scolaira · This link expires if revoked by the school.
        </div>
      </div>
    </main>
  );
}
