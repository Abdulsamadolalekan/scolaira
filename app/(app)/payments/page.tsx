import { Card, CardHeader } from '@/components/ui/nav-shell';
import { EmptyState } from '@/components/ui/empty';
import { Naira } from '@/components/ui/icons';

export const runtime = 'nodejs';

export default function PaymentsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1
          className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Payments
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Cash, bank transfers, card payments, and their allocations to invoices.
        </p>
      </div>
      <Card>
        <CardHeader title="Payments register" description="Full list surfaces next in M5." />
        <div className="p-6">
          <EmptyState
            icon={<Naira size={20} />}
            title="Coming in this milestone"
            description="The payments list with allocation status, reconciliation state, filters, and drill-down is in progress."
          />
        </div>
      </Card>
    </div>
  );
}
