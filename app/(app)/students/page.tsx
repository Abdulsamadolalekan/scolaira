import { Card, CardHeader } from '@/components/ui/nav-shell';
import { EmptyState } from '@/components/ui/empty';
import { Users } from '@/components/ui/icons';

export const runtime = 'nodejs';

export default function StudentsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1
          className="text-[22px] sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Students
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          The student roster and their guardian contacts.
        </p>
      </div>
      <Card>
        <CardHeader title="Student directory" description="Scheduled for M5." />
        <div className="p-6">
          <EmptyState
            icon={<Users size={20} />}
            title="Coming in this milestone"
            description="The student roster with class/term/guardian contacts and financial summary per student is in progress."
          />
        </div>
      </Card>
    </div>
  );
}
