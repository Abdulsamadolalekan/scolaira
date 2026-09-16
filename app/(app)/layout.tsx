/**
 * Authenticated application shell.
 *
 * Every route under (app) requires a valid session (middleware redirects
 * unauthenticated requests; each page also re-validates via getSession()).
 * The shell renders a quiet institutional navigation and a workspace that
 * is the same on desktop and mobile: sidebar collapses to a bottom sheet
 * on small screens but we keep it simple here with a top header and a
 * left-side rail that hides under md breakpoints (a drawer is overkill for
 * M5 scope — we keep the interaction flat and obvious).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, clearContext } from '@/lib/auth';
import { AppShell } from '@/components/ui/app-shell';
import {
  LayoutDashboard,
  FileText,
  Naira,
  Users,
  Settings,
  Bell,
  Search,
  Shield,
} from '@/components/ui/icons';

export const metadata: Metadata = {
  title: {
    default: 'Workspace',
    template: '%s · SCOLAIRA',
  },
};

const NAV = [
  { section: 'Operations', items: [
    { label: 'Command Center', href: '/dashboard', icon: LayoutDashboard, matchPrefix: '/dashboard' },
    { label: 'Invoices',     href: '/invoices',  icon: FileText,        matchPrefix: '/invoices' },
    { label: 'Payments',     href: '/payments',  icon: Naira,           matchPrefix: '/payments' },
    { label: 'Students',     href: '/students',  icon: Users,           matchPrefix: '/students', badge: 'soon' as const },
    { label: 'Members',      href: '/members',   icon: Shield,          matchPrefix: '/members' },
  ]},
  { section: 'Institution', items: [
    { label: 'Settings', href: '/settings', icon: Settings, matchPrefix: '/settings', badge: 'soon' as const },
  ]},
];

export const runtime = 'nodejs';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }
  await clearContext();

  const activeOrg = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId,
  );

  return (
    <AppShell
      user={{
        name: `${session.user.firstName} ${session.user.lastName}`.trim() || 'Account',
        email: session.user.email,
        initials:
          ((session.user.firstName?.[0] ?? '').toUpperCase()) +
          ((session.user.lastName?.[0] ?? '').toUpperCase()),
        role: activeOrg?.role ?? null,
      }}
      org={{
        name: (activeOrg as any)?.name ?? 'Workspace',
        role: activeOrg?.role ?? null,
        switcherHref: null,
      }}
      nav={NAV}
      sessionAction="/api/auth/logout"
    >
      {/* Accessibility: a live region for future toasts/announcements. */}
      <div role="status" aria-live="polite" className="sr-only" />
      {children}
    </AppShell>
  );
}

// Exported for routes to reference.
export { NAV };
// Avoid unused import warnings when Search/Bell aren't in the nav yet.
export const _unused = { Search, Bell };
export { Link };
