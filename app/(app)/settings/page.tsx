import Link from 'next/link';
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
        <CardHeader title="Workspace settings" description="School profile, branding, bank details, and access remain separate settings surfaces." />
        <div className="p-6 space-y-4">
          <EmptyState
            icon={<Settings size={20} />}
            title="Academic setup is now a working surface"
            description="Create sessions, terms, classes, students, and term-specific enrollment from the academic roster workspace."
          />
          <Link href="/academic" className="inline-flex rounded-md px-3 py-2 text-[13px] font-medium text-white" style={{ backgroundColor: 'var(--color-forest)' }}>Open academic roster</Link>
        </div>
      </Card>
    </div>
  );
}
