import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Money } from '@/components/ui/money';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import ReconciliationQueue from './reconciliation-queue';
import type { QueueRow } from '@/lib/db/repo/reconciliation';

export const runtime = 'nodejs';

async function loadQueue(): Promise<{ rows: QueueRow[]; nextCursor: string | null }> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return { rows: [], nextCursor: null };
  const response = await fetch(`${proto}://${host}/api/reconciliation/queue?limit=50`, {
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
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1
            className="text-[22px] font-semibold tracking-tight sm:text-2xl"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            Reconciliation control plane
          </h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Human-reviewed payment cases with durable evidence and explicit decisions. Financial
            balances remain authoritative in payments, allocations, invoices, reversals, refunds,
            and receipts.
          </p>
        </div>
        <Link
          href="/payments/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)]"
        >
          Record payment
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Open cases"
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
      </div>

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
    <div
      className="rounded-md border px-3 py-3"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--color-text-faint)' }}
      >
        {label}
      </div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colors[tone] }}>
        {value}
      </div>
    </div>
  );
}
