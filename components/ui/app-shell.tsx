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
  badge?: string | number | 'soon';
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
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold"
        style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)' }}
      >
        {org.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[13px] font-medium"
          style={{ color: 'var(--color-forest-deepest)' }}
          title={org.name}
        >
          {org.name}
        </div>
        {org.role && (
          <div className="text-[11px]" style={{ color: 'var(--color-forest)' }}>
            {ROLE_LABEL[org.role] ?? org.role}
          </div>
        )}
      </div>
    </>
  );

  const chipStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-forest-tint)',
    border: '1px solid var(--color-border-subtle)',
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
            backgroundColor: 'var(--color-ivory)',
            border: '1px solid var(--color-border-subtle)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
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
                    color: 'var(--color-text-primary)',
                    backgroundColor: active ? 'var(--color-forest-tint)' : 'transparent',
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

  const isActive = (item: NavItem) => {
    const pfx = item.matchPrefix ?? item.href;
    return pathname === pfx || pathname.startsWith(pfx + '/');
  };

  return (
    <div
      className="flex min-h-screen w-full max-w-full flex-col md:flex-row"
      style={{ backgroundColor: 'var(--color-bg-page)' }}
    >
      {/* ——— Rail (desktop) / top band (mobile) ——— */}
      <aside
        className="flex w-full min-w-0 max-w-full flex-col md:sticky md:top-0 md:min-h-screen md:w-64 md:border-b-0"
        style={{
          backgroundColor: 'var(--color-ivory)',
          borderRight: '1px solid var(--color-border-subtle)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4 md:pb-4 md:pt-5">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor: 'var(--color-forest-deep)',
              color: 'var(--color-ivory)',
              border: '1px solid var(--color-gold)',
            }}
            aria-hidden
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7L12 3L20 7V17L12 21L4 17V7Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M12 3V12M12 12L20 7M12 12L4 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
            >
              SCOLAIRA
            </span>
            <span
              className="text-[10px] uppercase tracking-[0.14em]"
              style={{ color: 'var(--color-text-faint)' }}
            >
              School finance
            </span>
          </div>
        </div>

        {/* Workspace selector (live from H-8; static when there is one org) */}
        <div className="px-3 pb-2 md:pb-3">
          <WorkspaceChip org={org} onSwitched={() => router.refresh()} />
        </div>

        {/* Nav — one scrollable row on mobile, a vertical rail from md up */}
        <nav
          data-scroll-container="nav-strip"
          className="flex w-full min-w-0 max-w-full flex-row overflow-x-auto px-2 pb-1 md:block md:flex-1 md:overflow-y-auto md:overflow-x-visible md:pb-4"
        >
          {nav.map((section) => (
            <div key={section.section} className="shrink-0 md:mb-4 md:shrink">
              <div
                className="hidden px-3 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-[0.12em] md:block"
                style={{ color: 'var(--color-text-faint)' }}
              >
                {section.section}
              </div>
              {/* ONE scroll container on a phone: the <nav> above. The sections
                  and items inside it keep their natural width and travel
                  together, so the PAGE never becomes wider than the screen.
                  `data-scroll-container` marks the strip as deliberate scroll for
                  the page-overflow measurement in e2e/mobile-shell.spec.ts —
                  which measures the page, not this scroller. */}
              <ul className="flex flex-row gap-1 pb-1 md:flex-col md:pb-0">
                {section.items.map((item) => {
                  const Icon = ICONS[item.icon] ?? ICONS.dashboard;
                  const active = isActive(item);
                  return (
                    <li key={item.href} className="shrink-0 md:w-full">
                      <Link
                        href={item.href}
                        className="group flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] transition-colors md:whitespace-normal"
                        style={{
                          color: active
                            ? 'var(--color-forest-deepest)'
                            : 'var(--color-text-secondary)',
                          backgroundColor: active ? 'var(--color-forest-tint)' : 'transparent',
                          fontWeight: active ? 600 : 400,
                          border: active
                            ? '1px solid var(--color-border-subtle)'
                            : '1px solid transparent',
                        }}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span
                          className="inline-flex shrink-0"
                          style={{
                            color: active ? 'var(--color-forest)' : 'var(--color-text-muted)',
                          }}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="flex-1">{item.label}</span>
                        {item.badge === 'soon' ? (
                          <span
                            className="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
                            style={{
                              color: 'var(--color-text-faint)',
                              backgroundColor: 'var(--color-bg-page)',
                              border: '1px solid var(--color-border-subtle)',
                            }}
                          >
                            soon
                          </span>
                        ) : item.badge ? (
                          <span
                            className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold"
                            style={{
                              color: 'var(--color-ivory)',
                              backgroundColor: 'var(--color-danger, #a82a1c)',
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

        {/* User card — the ONE account row, at every breakpoint. */}
        <div
          className="mx-3 mb-3 mt-0 flex items-center gap-2.5 rounded-lg p-2 md:mt-auto md:p-3"
          style={{
            backgroundColor: 'var(--color-bg-page)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
            style={{
              backgroundColor: 'var(--color-forest-tint)',
              color: 'var(--color-forest-deep)',
            }}
          >
            {user.initials || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[13px] font-medium"
              style={{ color: 'var(--color-text-primary)' }}
              title={user.name}
            >
              {user.name}
            </div>
            <div
              className="truncate text-[11px]"
              style={{ color: 'var(--color-text-muted)' }}
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
              className="rounded-md p-1.5 opacity-60 transition-opacity hover:opacity-100"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <LogOut size={15} />
            </button>
          </form>
        </div>
      </aside>

      {/* ——— Main ——— */}
      <main className="w-full min-w-0 max-w-full flex-1">{children}</main>
    </div>
  );
}
