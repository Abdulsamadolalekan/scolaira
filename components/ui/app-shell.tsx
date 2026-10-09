/**
 * Authenticated application shell.
 *
 * Design notes (SCOLAIRA principle level 4):
 *  - Top bar carries organization identity + user, NOT a brand billboard.
 *  - Left rail is calm, low-chrome, section-divided, uses SCOLAIRA icons.
 *  - Content area has generous whitespace; numbers and tables should breathe.
 *  - Gold appears only where it signals trust or selected state — never as noise.
 *  - On mobile (<md) the rail becomes a compact band at the top of the page:
 *    brand, workspace and one horizontally scrollable row of destinations, then
 *    a slim account row. No heavy drawer animation — it should feel immediate
 *    and reliable on inexpensive Android devices.
 *
 * H-8 changes (two, both about the shell actually working):
 *
 *  1. The workspace selector is live. `switchOrganization()` had no caller since
 *     H-4/F10 and the chip was a button-shaped div that did nothing. It now posts
 *     to the EXISTING `POST /api/auth/select-organization` (no second switcher
 *     API), which re-verifies membership server-side and writes the signed
 *     active-org cookie. With one organization the chip stays static.
 *
 *  2. The mobile band. Restructuring is limited to ordering and responsive
 *     classes so the frozen H-4 contract is untouched: exactly ONE
 *     `form[action="/api/auth/logout"]` with its `input[name="_csrf"]`, and
 *     exactly one sign-out submit button, in the DOM at every breakpoint.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { ScolairaLockup } from '@/components/brand';
import { usePathname, useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/ui/csrf';
import {
  LogOut,
  ChevronDown,
  Check,
  LayoutDashboard,
  FileText,
  Naira,
  Users,
  Settings,
  Shield,
  Bell,
  AlertTriangle,
  Menu,
  X as Close,
} from '@/components/ui/icons';

export type IconKey =
  'dashboard' | 'invoices' | 'payments' | 'students' | 'members' | 'settings' | 'bell' | 'debtors';

const ICONS: Record<IconKey, React.ComponentType<{ size?: number; className?: string }>> = {
  dashboard: LayoutDashboard,
  invoices: FileText,
  payments: Naira,
  students: Users,
  members: Shield,
  settings: Settings,
  bell: Bell,
  debtors: AlertTriangle,
};

export interface NavItem {
  label: string;
  href: string;
  icon: IconKey;
  matchPrefix?: string;
  badge?: string | number;
}
export interface NavSection {
  section: string;
  items: NavItem[];
}

/** One switchable organization. Ids and labels only — no tenant data. */
export interface OrgOption {
  id: string;
  name: string;
}

interface AppShellProps {
  user: { name: string; email: string; initials: string; role: string | null };
  org: {
    name: string;
    role: string | null;
    /** Every organization the user is an active member of. */
    organizations?: OrgOption[];
    activeOrganizationId?: string | null;
  };
  nav: NavSection[];
  sessionAction: string;
  /** Double-submit CSRF token for the no-JS sign-out form (H-4/F7). */
  csrfToken?: string | null;
  children: React.ReactNode;
}

/** Compact labels for the mobile tab bar, where width is counted in pixels. */
const TAB_LABEL: Record<string, string> = {
  Dashboard: 'Dashboard',
  Invoices: 'Invoices',
  Payments: 'Payments',
  Students: 'Students',
  Debtors: 'Debtors',
};

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Proprietor',
  SCHOOL_ADMIN: 'Administrator',
  FINANCE_OFFICER: 'Finance Officer',
  STAFF: 'Staff',
};

/**
 * Workspace chip. Static when the user belongs to one organization, a real menu
 * when they belong to several. Switching goes through the API so the server —
 * not the browser — decides whether the membership exists.
 */
function WorkspaceChip({
  org,
  onSwitched,
}: {
  org: AppShellProps['org'];
  onSwitched?: () => void;
}) {
  const options = org.organizations ?? [];
  const switchable = options.length > 1;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function choose(organizationId: string) {
    if (organizationId === org.activeOrganizationId) {
      setOpen(false);
      return;
    }
    setBusy(organizationId);
    setError(null);
    try {
      const res = await fetch('/api/auth/select-organization', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? 'That workspace could not be opened.');
      }
      setOpen(false);
      onSwitched?.();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'That workspace could not be opened.');
    } finally {
      setBusy(null);
    }
  }

  const chip = (
    <>
      {/* The institution's seal: your school's initial, on the rail. */}
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold"
        style={{
          backgroundColor: 'rgba(212, 175, 55, 0.16)',
          color: 'var(--color-gold-reference)',
          border: '1px solid rgba(212, 175, 55, 0.35)',
        }}
      >
        {org.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ivory" title={org.name}>
          {org.name}
        </div>
        {org.role && (
          <div
            className="hidden truncate text-[10px] uppercase tracking-[0.12em] sm:block"
            style={{ color: 'rgba(253, 251, 246, 0.55)' }}
            title={ROLE_LABEL[org.role] ?? org.role}
          >
            {ROLE_LABEL[org.role] ?? org.role}
          </div>
        )}
      </div>
    </>
  );

  const chipStyle: React.CSSProperties = {
    backgroundColor: 'rgba(253, 251, 246, 0.05)',
    border: '1px solid rgba(253, 251, 246, 0.10)',
  };

  if (!switchable) {
    return (
      <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2" style={chipStyle}>
        {chip}
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch workspace (currently ${org.name})`}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left"
        style={chipStyle}
      >
        {chip}
        <ChevronDown size={14} className="shrink-0 opacity-50" aria-hidden />
      </button>

      {open && (
        <ul
          role="menu"
          className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg py-1"
          style={{
            backgroundColor: 'var(--color-forest-deep)',
            border: '1px solid rgba(253, 251, 246, 0.14)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          }}
        >
          {options.map((o) => {
            const active = o.id === org.activeOrganizationId;
            return (
              <li key={o.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => choose(o.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] disabled:opacity-60"
                  style={{
                    color: 'var(--color-ivory)',
                    backgroundColor: active ? 'rgba(253, 251, 246, 0.10)' : 'transparent',
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {active && <Check size={14} aria-hidden />}
                </button>
              </li>
            );
          })}
          {error && (
            <li
              role="alert"
              className="px-3 py-2 text-[11px]"
              style={{ color: 'var(--color-danger, #a82a1c)' }}
            >
              {error}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function AppShell({ user, org, nav, sessionAction, csrfToken, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const isActive = (item: NavItem) => {
    const pfx = item.matchPrefix ?? item.href;
    return pathname === pfx || pathname.startsWith(pfx + '/');
  };

  // Close the mobile sheet whenever the route changes — a menu that survives
  // navigation is a menu that traps the user behind the page they asked for.
  React.useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  const allItems = nav.flatMap((s) => s.items);
  // The five destinations a bursar reaches for constantly. Everything else
  // lives one tap away in the sheet rather than being hidden entirely.
  const TAB_HREFS = ['/dashboard', '/invoices', '/payments', '/students', '/debtors'];
  const tabs = TAB_HREFS.map((h) => allItems.find((i) => i.href === h)).filter(
    Boolean,
  ) as NavItem[];
  const hasMore = allItems.length > tabs.length;

  return (
    <div
      className="flex min-h-screen w-full max-w-full flex-col md:flex-row"
      style={{ backgroundColor: 'var(--color-bg-page)' }}
    >
      {/* ————————————————————————————————————————————————————————————————
          THE RAIL.
          One element, two compositions: an institutional spine on desktop and
          a compact identity bar on a phone. It is never "the desktop sidebar
          squeezed small" — the phone gets its own chrome below.
         ———————————————————————————————————————————————————————————————— */}
      <aside
        className="sticky top-0 z-30 flex w-full min-w-0 max-w-full shrink-0 flex-row flex-wrap items-center gap-3 px-4 py-3 md:h-screen md:w-[264px] md:flex-col md:flex-nowrap md:items-stretch md:gap-0 md:overflow-hidden md:px-0 md:py-0"
        style={{ backgroundColor: 'var(--color-forest-deepest)' }}
      >
        {/* Brand. Rendered from the frozen lockup, on its approved `onDark` tone. */}
        <div className="flex shrink-0 items-center md:border-b md:border-white/10 md:px-5 md:py-6">
          <ScolairaLockup
            size={24}
            tone="onDark"
            descriptor="School finance"
            descriptorClassName="hidden md:block"
          />
        </div>

        {/* Workspace — on a phone it takes the middle of the bar. */}
        <div className="min-w-[132px] flex-1 md:mt-3 md:min-w-0 md:flex-none md:px-3">
          <WorkspaceChip org={org} onSwitched={() => router.refresh()} />
        </div>

        {/* Destinations — the spine, desktop only. */}
        <nav
          aria-label="Workspace"
          className="hidden min-w-0 md:mt-4 md:flex md:flex-1 md:flex-col md:overflow-y-auto md:px-3"
        >
          {nav.map((section) => (
            <div key={section.section} className="mb-5 last:mb-0">
              <div
                className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: 'rgba(253, 251, 246, 0.42)' }}
              >
                {section.section}
              </div>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = isActive(item);
                  const Icon = ICONS[item.icon];
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className="group relative flex items-center gap-3 rounded-sm py-2 pl-3 pr-2 text-[13px] transition-colors duration-150"
                        style={{
                          // Selection is a gold seal on the spine, not a filled pill.
                          color: active ? 'var(--color-ivory)' : 'rgba(253, 251, 246, 0.72)',
                          backgroundColor: active ? 'rgba(253, 251, 246, 0.07)' : 'transparent',
                          fontWeight: active ? 500 : 400,
                        }}
                      >
                        {active && (
                          <span
                            aria-hidden
                            className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full"
                            style={{ backgroundColor: 'var(--color-gold-reference)' }}
                          />
                        )}
                        <span
                          className="inline-flex shrink-0 transition-opacity"
                          style={{ opacity: active ? 1 : 0.65 }}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.badge != null ? (
                          <span
                            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                            style={{
                              backgroundColor: 'rgba(212, 175, 55, 0.18)',
                              color: 'var(--color-gold-reference)',
                            }}
                          >
                            {item.badge}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* ── THE ONE ACCOUNT ROW, at every breakpoint (H-4 contract). ──
            On a phone only the sign-out control shows; the identity of the
            operator is already carried by the workspace block beside it. */}
        <div className="flex shrink-0 items-center gap-2 md:mt-auto md:border-t md:border-white/10 md:px-4 md:py-4">
          <div
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold md:flex"
            style={{
              backgroundColor: 'rgba(253, 251, 246, 0.08)',
              color: 'var(--color-ivory)',
              border: '1px solid rgba(253, 251, 246, 0.12)',
            }}
          >
            {user.initials || 'U'}
          </div>
          <div className="hidden min-w-0 flex-1 md:block">
            <div className="truncate text-[12px] font-medium text-ivory" title={user.name}>
              {user.name}
            </div>
            <div
              className="truncate text-[10px]"
              style={{ color: 'rgba(253, 251, 246, 0.5)' }}
              title={user.email}
            >
              {user.email}
            </div>
          </div>
          <form action={sessionAction} method="post">
            {/* The same double-submit token the fetch callers send as a
                header; keeps sign-out working without JavaScript. */}
            <input type="hidden" name="_csrf" value={csrfToken ?? ''} />
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="rounded-sm p-2 transition-colors hover:bg-white/10"
              style={{ color: 'rgba(253, 251, 246, 0.7)' }}
            >
              <LogOut size={16} />
            </button>
          </form>
        </div>
      </aside>

      {/* ————————————————————————————————————————————————————————————————
          MOBILE SHEET — always in the DOM, hidden when closed, so the shell
          has exactly one account row and one sign-out form at every
          breakpoint. Behind a translucent scrim, closing on outside tap.
         ———————————————————————————————————————————————————————————————— */}
      {hasMore && (
        <div id="app-more" className={sheetOpen ? 'md:hidden' : 'hidden'} aria-hidden={!sheetOpen}>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close destinations"
            onClick={() => setSheetOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
            style={{ backgroundColor: 'rgba(11, 31, 22, 0.45)' }}
          />
          <div
            className="fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-y-auto rounded-t-md pb-24"
            style={{ backgroundColor: 'var(--color-forest-deepest)' }}
          >
            <div className="flex items-center justify-between px-5 pb-3 pt-5">
              <span
                className="text-[10px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: 'rgba(253, 251, 246, 0.5)' }}
              >
                All destinations
              </span>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="rounded-sm p-2"
                style={{ color: 'rgba(253, 251, 246, 0.7)' }}
              >
                <Close size={16} aria-hidden />
                <span className="sr-only">Close</span>
              </button>
            </div>
            {nav.map((section) => (
              <div key={section.section} className="px-3 pb-4">
                <div
                  className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
                  style={{ color: 'rgba(253, 251, 246, 0.42)' }}
                >
                  {section.section}
                </div>
                <ul>
                  {section.items.map((item) => {
                    const active = isActive(item);
                    const Icon = ICONS[item.icon];
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className="flex items-center gap-3 rounded-sm px-2 py-2.5 text-[14px]"
                          style={{
                            color: active ? 'var(--color-ivory)' : 'rgba(253, 251, 246, 0.78)',
                          }}
                        >
                          <Icon size={17} />
                          <span className="flex-1">{item.label}</span>
                          {active && (
                            <span
                              aria-hidden
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: 'var(--color-gold-reference)' }}
                            />
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ————————————————————————————————————————————————————————————————
          MOBILE TAB BAR — the five destinations a school reaches for daily.
          Fixed, thumb-reachable, and labelled (an icon alone is a guess).
         ———————————————————————————————————————————————————————————————— */}
      {tabs.length > 0 && (
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-30 flex border-t md:hidden"
          style={{
            backgroundColor: 'var(--color-ivory)',
            borderColor: 'rgba(11, 31, 22, 0.10)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          {tabs.map((item) => {
            const active = isActive(item);
            const Icon = ICONS[item.icon];
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="flex flex-1 flex-col items-center gap-1 pb-2 pt-2.5"
                style={{ color: active ? 'var(--color-forest-deepest)' : 'var(--color-ink-muted)' }}
              >
                <span className="relative">
                  <Icon size={19} />
                  {active && (
                    <span
                      aria-hidden
                      className="absolute -top-2.5 left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-full"
                      style={{ backgroundColor: 'var(--color-gold-reference)' }}
                    />
                  )}
                </span>
                <span className="text-[10px] font-medium tracking-[0.01em]">
                  {TAB_LABEL[item.label] ?? item.label}
                </span>
              </Link>
            );
          })}
          {hasMore && (
            <button
              type="button"
              onClick={() => setSheetOpen((v) => !v)}
              aria-expanded={sheetOpen}
              aria-controls="app-more"
              className="flex flex-1 flex-col items-center gap-1 pb-2 pt-2.5"
              style={{
                color: sheetOpen ? 'var(--color-forest-deepest)' : 'var(--color-ink-muted)',
              }}
            >
              <Menu size={19} aria-hidden />
              <span className="text-[10px] font-medium tracking-[0.01em]">More</span>
            </button>
          )}
        </nav>
      )}

      {/* ——— Main ——— */}
      <main className="w-full min-w-0 max-w-full flex-1 pb-[76px] md:pb-0">{children}</main>
    </div>
  );
}
