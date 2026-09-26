/**
 * Platform console — the surface the authorization layer always described and
 * no page ever rendered (H-8).
 *
 * Deliberately outside the `(app)` group: the tenant shell belongs to a tenant,
 * and this console belongs to nobody's tenant. It carries a persistent, loud
 * banner so a platform administrator can never confuse support mode with their
 * own workspace — the single most consequential way this surface could be
 * misused.
 *
 * Guard: `session.user.isPlatformAdmin` as loaded from the database by
 * `getSession()`. A non-administrator gets `notFound()` — the console does not
 * advertise its existence.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession, clearContext } from '@/lib/auth';
import { readSupportClaim } from '@/lib/platform/support';

export const metadata: Metadata = {
  title: { default: 'Platform', template: '%s · SCOLAIRA Platform' },
  robots: { index: false, follow: false },
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.user.isPlatformAdmin) notFound();

  const support = await readSupportClaim(session.user.id);
  await clearContext();

  return (
    <div className="flex min-h-screen flex-col" style={{ backgroundColor: 'var(--color-bg-page)' }}>
      <header
        style={{
          backgroundColor: 'var(--color-forest-deepest)',
          color: 'var(--color-ivory)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
          <Link href="/platform" className="text-[14px] font-semibold tracking-tight">
            SCOLAIRA Platform
          </Link>
          <span className="text-[12px] opacity-70">Support &amp; operations</span>
          <div className="ml-auto flex items-center gap-3">
            <Link href="/dashboard" className="text-[12px] underline decoration-dotted">
              Back to workspace
            </Link>
            <span
              className="max-w-[45vw] truncate text-[12px] opacity-70"
              title={session.user.email}
            >
              {session.user.email}
            </span>
          </div>
        </div>
      </header>

      {support && (
        <div
          role="status"
          className="w-full"
          style={{
            backgroundColor: 'var(--color-gold-tint, #f6efdc)',
            color: 'var(--color-forest-deepest)',
          }}
        >
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-[12px] sm:px-6">
            <strong className="font-semibold">Support mode — read-only.</strong>
            <span>
              Viewing another organization. Nothing can be changed here; every entry is recorded in
              that organization&rsquo;s audit trail.
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
        {children}
      </main>
    </div>
  );
}
