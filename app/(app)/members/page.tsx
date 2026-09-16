import { Card, CardHeader } from '@/components/ui/nav-shell';
import { EmptyState } from '@/components/ui/empty';
import { Shield } from '@/components/ui/icons';

export const runtime = 'nodejs';

export default function MembersPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1
          className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Members
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          The people who run the school with you, and what they are permitted to do.
        </p>
      </div>
      <Card>
        <CardHeader title="Team directory" description="Full list surfaces next in M5." />
        <div className="p-6">
          <EmptyState
            icon={<Shield size={20} />}
            title="Coming in this milestone"
            description="The members list with role, status, last activity, invitation state, and role management is in progress."
          />
        </div>
      </Card>
    </div>
  );
}
