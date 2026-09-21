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
import type { IconKey } from '@/components/ui/app-shell';

export const metadata: Metadata = {
  title: {
    default: 'Workspace',
    template: '%s · SCOLAIRA',
  },
};

interface ItemDef {
  label: string;
  href: string;
  icon: IconKey;
  matchPrefix?: string;
  roles: null | string[];
  badge?: 'soon';
}

const ALL_NAV: { section: string; items: ItemDef[] }[] = [
  { section: 'Operations', items: [
    { label: 'Command Center', href: '/dashboard', icon: 'dashboard', matchPrefix: '/dashboard', roles: null },
    { label: 'Invoices',     href: '/invoices',   icon: 'invoices',  matchPrefix: '/invoices',   roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Payments',     href: '/payments',   icon: 'payments',  matchPrefix: '/payments',   roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Students',     href: '/students',   icon: 'students',  matchPrefix: '/students',   roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Academic roster', href: '/academic', icon: 'students', matchPrefix: '/academic', roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Reconcile',    href: '/reconcile',  icon: 'payments',  matchPrefix: '/reconcile',  roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Debtors',      href: '/debtors',    icon: 'debtors',   matchPrefix: '/debtors',    roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Members',      href: '/members',    icon: 'members',   matchPrefix: '/members',    roles: ['OWNER','SCHOOL_ADMIN'] },
  ]},
  { section: 'Institution', items: [
    { label: 'Fee structure', href: '/settings/fees', icon: 'settings', matchPrefix: '/settings/fees', roles: ['OWNER','SCHOOL_ADMIN','FINANCE_OFFICER'] },
    { label: 'Settings', href: '/settings', icon: 'settings', matchPrefix: '/settings', roles: ['OWNER','SCHOOL_ADMIN'], badge: 'soon' },
  ]},
];

function buildNav(role: string | null | undefined) {
  return ALL_NAV.map(section => ({
    section: section.section,
    items: section.items.filter(item => !item.roles || (role && item.roles.includes(role))),
  })).filter(section => section.items.length > 0);
}

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
      nav={buildNav(activeOrg?.role)}
      sessionAction="/api/auth/logout"
    >
      {/* Accessibility: a live region for future toasts/announcements. */}
      <div role="status" aria-live="polite" className="sr-only" />
      {children}
    </AppShell>
  );
}

// Exported for routes to reference.
export { buildNav as getNav };
export { Link };
