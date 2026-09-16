/**
 * Dashboard landing page (server component — protected at server boundary).
 *
 * Per M3 §15, the API must defend itself. This page is protected BOTH by
 * middleware (coarse cookie-presence redirect) AND by an explicit
 * getSession() check here (real trust boundary). Middleware can be bypassed;
 * server-side verification cannot.
 */
import { redirect } from 'next/navigation';
import { getSession, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }
  await clearContext();

  const initials =
    ((session.user.firstName?.[0] ?? '').toUpperCase()) +
    ((session.user.lastName?.[0] ?? '').toUpperCase());

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-bg-page)' }}>
      <header
        className="px-6 py-4 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--color-border-subtle)', backgroundColor: 'var(--color-ivory)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center text-xs font-semibold"
            style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)', border: '1px solid var(--color-gold)' }}
          >
            S
          </div>
          <span className="font-semibold tracking-tight" style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>SCOLAIRA</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span style={{ color: 'var(--color-text-muted)' }}>
            {session.user.firstName} {session.user.lastName}
          </span>
          <div
            className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ backgroundColor: 'var(--color-forest-tint)', color: 'var(--color-forest-deep)' }}
            title={session.user.email}
          >
            {initials || 'U'}
          </div>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="text-sm px-3 py-1.5 rounded-md"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div
          className="rounded-xl p-8 mb-6"
          style={{
            backgroundColor: 'var(--color-ivory)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <p className="text-sm mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Active workspace
          </p>
          <h1
            className="text-2xl tracking-tight mb-2"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            Welcome{session.user.firstName ? `, ${session.user.firstName}` : ''}.
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Organization:{' '}
            <code className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-forest-tint)', color: 'var(--color-forest-deep)' }}>
              {session.activeOrganizationId}
            </code>
          </p>
        </div>

        <div
          className="rounded-xl p-6"
          style={{
            backgroundColor: 'rgba(191,155,79,0.06)',
            border: '1px dashed var(--color-gold-soft, var(--color-gold))',
          }}
        >
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--color-forest-deepest)' }}>
            M3 — Identity foundation active
          </h2>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Authentication, sessions, password recovery, CSRF protection, and tenant-context
            handoff are in place. Core school operations, full RBAC, financial workflows,
            and production hardening follow in M4+.
          </p>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Metric label="Memberships" value={String(session.memberships.length)} />
            <Metric label="Role" value={session.memberships[0]?.role ?? '—'} />
            <Metric label="Session ID" value={session.sessionId.slice(0, 8) + '…'} />
            <Metric label="Platform admin" value={session.user.isPlatformAdmin ? 'yes' : 'no'} />
          </div>
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--color-ivory)', border: '1px solid var(--color-border-subtle)' }}>
      <div className="text-xs" style={{ color: 'var(--color-text-faint)' }}>{label}</div>
      <div className="text-sm font-mono" style={{ color: 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );
}
