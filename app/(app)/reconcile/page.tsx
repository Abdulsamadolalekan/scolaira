import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import ReconciliationQueue from './reconciliation-queue';
import type { QueueRow } from '@/lib/db/repo/reconciliation';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

async function loadQueue(): Promise<{ rows: QueueRow[]; nextCursor: string | null }> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return { rows: [], nextCursor: null };
  const response = await fetch(`${base}/api/reconciliation/queue?limit=50`, {
    cache: 'no-store',
    headers: { cookie },
  }).catch(() => null);
  if (!response?.ok) return { rows: [], nextCursor: null };
  const data = await response.json().catch(() => ({}));
  return { rows: (data.queue ?? []) as QueueRow[], nextCursor: data.nextCursor ?? null };
}

export default async function ReconcilePage() {
  const gate = await checkPermission('reconciliation.read');
  if (!gate.allowed)
    return (
      <AccessDenied
        surface="Reconciliation"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  const { rows, nextCursor } = await loadQueue();
  const pending = rows.filter((row) => row.paymentStatus === 'PENDING');
  const flagged = rows.filter((row) => row.state === 'FLAGGED');
  const unallocatedKobo = rows.reduce((sum, row) => sum + row.unallocatedKobo, 0);
  const pendingKobo = pending.reduce((sum, row) => sum + row.amountKobo, 0);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Reconciliation"
        lede="Payment cases that need a human decision. Balances stay authoritative in payments, allocations and invoices."
        actions={
          <Link
            href="/payments/new"
            className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--color-forest-deep)] px-3 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            Record payment
          </Link>
        }
      />

      {/* The four figures, set as ruled measures.
          They were four bordered boxes with a fill, which gave the summary the
          same weight as the queue below it and made the top of the page read as
          a card row. The invoice register already renders this exact job as a
          ruled strip; the same job now looks the same on both surfaces. */}
      <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-4">
        <Stat
          label="Visible open cases"
          value={rows.length.toLocaleString('en-NG')}
          tone={rows.length ? 'warn' : 'muted'}
        />
        <Stat
          label="Pending confirmation"
          value={<Money kobo={pendingKobo} />}
          tone={pendingKobo ? 'warn' : 'muted'}
        />
        <Stat
          label="Unallocated credit"
          value={<Money kobo={unallocatedKobo} />}
          tone={unallocatedKobo ? 'warn' : 'muted'}
        />
        <Stat
          label="Flagged exceptions"
          value={flagged.length.toLocaleString('en-NG')}
          tone={flagged.length ? 'danger' : 'muted'}
        />
      </dl>

      <Card>
        <CardHeader
          title="Operational queue"
          description="Derived payment work is visible even before a case is opened. Expand a row to add evidence, establish context, and take a permitted action."
        />
        <ReconciliationQueue initialRows={rows} nextCursor={nextCursor} />
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'warn' | 'danger' | 'muted';
}) {
  const colors = {
    default: 'var(--color-text-primary)',
    warn: 'var(--color-gold-dark,#8a6b11)',
    danger: 'var(--color-danger,#a82a1c)',
    muted: 'var(--color-text-faint)',
  } as const;
  return (
    <div className="border-t border-ink-faint pt-3">
      <dt className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{label}</dt>
      <dd className="mt-1.5 tabular-nums" style={{ color: colors[tone] }}>
        {value}
      </dd>
    </div>
  );
}
