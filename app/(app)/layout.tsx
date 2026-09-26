/**
 * Authenticated application shell.
 *
 * Every route under (app) requires a valid session (middleware redirects
 * unauthenticated requests; each page also re-validates via getSession()).
 * The shell renders a quiet institutional navigation and a workspace that is
 * the same on desktop and mobile: a left rail from md up, and a compact band
 * (brand, workspace, one scrollable row of destinations, account row) below it.
 * A drawer was judged overkill for this scope; flat and immediate wins on the
 * inexpensive Android devices these schools actually use.
 *
 * H-8: the shell now resolves organization NAMES and the full switchable list.
 * It previously passed `(activeOrg as any)?.name ?? 'Workspace'`, and
 * `session.memberships` carries no name, so every school saw the literal word
 * "Workspace" in the chip. Names are read one organization at a time through
 * `withTenant` — the membership is the authority, so this is the ordinary tenant
 * door, not a cross-tenant lookup and not a bootstrap scope.
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, clearContext } from '@/lib/auth';
import { CSRF_COOKIE_NAME } from '@/lib/auth/config';
import { withTenant } from '@/lib/db/tenant';
import * as Org from '@/lib/db/repo/organizations';
import { AppShell } from '@/components/ui/app-shell';
import type { IconKey, OrgOption } from '@/components/ui/app-shell';

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
  {
    section: 'Operations',
    items: [
      {
        label: 'Command Center',
        href: '/dashboard',
        icon: 'dashboard',
        matchPrefix: '/dashboard',
        roles: null,
      },
      {
        label: 'Invoices',
        href: '/invoices',
        icon: 'invoices',
        matchPrefix: '/invoices',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Payments',
        href: '/payments',
        icon: 'payments',
        matchPrefix: '/payments',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Students',
        href: '/students',
        icon: 'students',
        matchPrefix: '/students',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Academic roster',
        href: '/academic',
        icon: 'students',
        matchPrefix: '/academic',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Reconcile',
        href: '/reconcile',
        icon: 'payments',
        matchPrefix: '/reconcile',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Collections',
        href: '/collections',
        icon: 'debtors',
        matchPrefix: '/collections',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Debtors',
        href: '/debtors',
        icon: 'debtors',
        matchPrefix: '/debtors',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Members',
        href: '/members',
        icon: 'members',
        matchPrefix: '/members',
        roles: ['OWNER', 'SCHOOL_ADMIN'],
      },
    ],
  },
  {
    section: 'Institution',
    items: [
      {
        label: 'Fee structure',
        href: '/settings/fees',
        icon: 'settings',
        matchPrefix: '/settings/fees',
        roles: ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'],
      },
      {
        label: 'Settings',
        href: '/settings',
        icon: 'settings',
        matchPrefix: '/settings',
        roles: ['OWNER', 'SCHOOL_ADMIN'],
        badge: 'soon',
      },
    ],
  },
];

function buildNav(role: string | null | undefined) {
  return ALL_NAV.map((section) => ({
    section: section.section,
    items: section.items.filter((item) => !item.roles || (role && item.roles.includes(role))),
  })).filter((section) => section.items.length > 0);
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

  // Organization labels, one tenant-scoped read per active membership. A failed
  // read degrades to a neutral label rather than taking the shell down with it.
  const organizations: OrgOption[] = await Promise.all(
    session.memberships
      .filter((m) => m.status === 'ACTIVE')
      .map(async (m): Promise<OrgOption> => {
        try {
          return await withTenant(
            { organizationId: m.organizationId, userId: session.user.id },
            async (db, ctx) => {
              const org = await Org.get(db, ctx);
              return { id: org.id, name: org.name };
            },
          );
        } catch {
          return { id: m.organizationId, name: 'Workspace' };
        }
      }),
  );
  await clearContext();

  const activeName =
    organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? 'Workspace';

  return (
    <AppShell
      user={{
        name: `${session.user.firstName} ${session.user.lastName}`.trim() || 'Account',
        email: session.user.email,
        initials:
          (session.user.firstName?.[0] ?? '').toUpperCase() +
          (session.user.lastName?.[0] ?? '').toUpperCase(),
        role: activeOrg?.role ?? null,
      }}
      org={{
        name: activeName,
        role: activeOrg?.role ?? null,
        organizations,
        activeOrganizationId: session.activeOrganizationId,
      }}
      nav={buildNav(activeOrg?.role)}
      sessionAction="/api/auth/logout"
      csrfToken={(await cookies()).get(CSRF_COOKIE_NAME)?.value ?? null}
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
