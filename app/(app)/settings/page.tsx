import { Card, CardHeader } from '@/components/ui/nav-shell';
import { EmptyState } from '@/components/ui/empty';
import { Settings } from '@/components/ui/icons';

export const runtime = 'nodejs';

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1
          className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Settings
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          School profile, branding, bank details, terms, sessions, and access.
        </p>
      </div>
      <Card>
        <CardHeader title="Workspace settings" description="Scheduled for M5." />
        <div className="p-6">
          <EmptyState
            icon={<Settings size={20} />}
            title="Coming in this milestone"
            description="School profile, bank details, academic-session and term setup, branding, and audit-export surfaces."
          />
        </div>
      </Card>
    </div>
  );
}
