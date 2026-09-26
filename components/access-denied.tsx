import Link from 'next/link';
import { Shield } from '@/components/ui/icons';

/**
 * Calm access-denied state shown when a signed-in user lacks permission for a
 * surface (e.g. STAFF landing on /invoices). Not a security interstitial. Not
 * an error. Just: this part of SCOLAIRA is for a different role.
 */
export function AccessDenied({ surface, requiredRole }: { surface: string; requiredRole: string }) {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-24 text-center">
      <div
        className="mx-auto h-12 w-12 rounded-full flex items-center justify-center"
        style={{
          backgroundColor: 'var(--color-forest-tint)',
          color: 'var(--color-forest-deep)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        <Shield size={20} />
      </div>
      <h1
        className="mt-4 text-xl font-semibold tracking-tight"
        style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
      >
        {surface} is restricted to {requiredRole}.
      </h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Your current role does not have permission to view this part of SCOLAIRA. Your money and
        data are safe — you are seeing this message because access is controlled by role. If you
        believe you should have access, ask the school proprietor to update your permissions.
      </p>
      <div className="mt-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-md bg-[color:var(--color-forest)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-forest-deep)]"
        >
          Return to command center
        </Link>
      </div>
    </div>
  );
}
