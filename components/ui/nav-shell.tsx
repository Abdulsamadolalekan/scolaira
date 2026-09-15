'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import {
  Bell,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileText,
  Home,
  Menu,
  Naira,
  Receipt,
  Search,
  Settings,
  Users,
} from './icons';

export interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: string | number;
  /** Match path prefix (e.g. /invoices matches /invoices/*) */
  matchPrefix?: string;
  section?: 'main' | 'ops' | 'settings';
}

export const defaultNav: NavItem[] = [
  {
    label: 'Command Center',
    href: '/preview/command-center',
    icon: <Home size={18} />,
    section: 'main',
  },
  {
    label: 'Students',
    href: '/preview/list/students',
    icon: <Users size={18} />,
    matchPrefix: '/preview/list/students',
    section: 'main',
  },
  {
    label: 'Invoices',
    href: '/preview/list/invoices',
    icon: <FileText size={18} />,
    matchPrefix: '/preview/list/invoices',
    section: 'main',
  },
  {
    label: 'Payments',
    href: '/preview/list/payments',
    icon: <Naira size={18} />,
    matchPrefix: '/preview/list/payments',
    badge: 4,
    section: 'ops',
  },
  {
    label: 'Receipts',
    href: '/preview/list/receipts',
    icon: <Receipt size={18} />,
    matchPrefix: '/preview/list/receipts',
    section: 'ops',
  },
  {
    label: 'Terms',
    href: '/preview/list/terms',
    icon: <Calendar size={18} />,
    matchPrefix: '/preview/list/terms',
    section: 'ops',
  },
  {
    label: 'Payment Links',
    href: '/preview/list/links',
    icon: <CreditCard size={18} />,
    matchPrefix: '/preview/list/links',
    section: 'ops',
  },
  {
    label: 'Settings',
    href: '/preview/settings',
    icon: <Settings size={18} />,
    section: 'settings',
  },
];

/**
 * Navigation shell.
 *
 * Desktop: fixed left sidebar (248px / 72px collapsed) + top bar + content area.
 * Mobile:  sidebar hidden behind a drawer triggered by menu icon; bottom nav
 *          for primary destinations.
 */
export function NavShell({
  children,
  items = defaultNav,
  appLabel = 'SCOLAIRA',
  orgLabel = 'Demo School',
  orgSubLabel = '2025/26 · Third Term',
}: {
  children: React.ReactNode;
  items?: NavItem[];
  appLabel?: string;
  orgLabel?: string;
  orgSubLabel?: string;
}) {
  const pathname = usePathname() ?? '';
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const isActive = (item: NavItem) =>
    item.href === pathname || (item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false);

  const mainItems = items.filter((i) => i.section !== 'ops' && i.section !== 'settings');
  const opsItems = items.filter((i) => i.section === 'ops');
  const settingsItems = items.filter((i) => i.section === 'settings');

  return (
    <div className="min-h-screen bg-surface-page text-text-primary">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[color:var(--color-overlay)] lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        data-ui="chrome"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-white transition-[width] duration-base ease-standard',
          collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
          'hidden lg:flex',
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="flex h-topbar items-center gap-3 border-b border-border px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-forest-deepest text-sm font-bold text-white">
            S
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight text-ink-deepest">
                {appLabel}
              </p>
              <p className="truncate text-xs leading-tight text-ink-muted">{orgLabel}</p>
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-surface-subtle hover:text-ink-primary focus-visible:shadow-focus-ring lg:inline-flex"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <NavGroup label="Workspace" items={mainItems} collapsed={collapsed} isActive={isActive} />
          <NavGroup label="Operations" items={opsItems} collapsed={collapsed} isActive={isActive} />
        </nav>

        {/* Bottom settings */}
        <div className="border-t border-border px-2 py-2">
          <NavGroup items={settingsItems} collapsed={collapsed} isActive={isActive} />
          {!collapsed && (
            <div className="px-3 py-2 text-2xs uppercase tracking-wider text-ink-subtle">
              v0.1.0-M1
            </div>
          )}
        </div>
      </aside>

      {/* Mobile sidebar drawer */}
      <aside
        data-ui="chrome"
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-sidebar flex-col border-r border-border bg-white transition-transform duration-base ease-standard lg:hidden',
          mobileOpen ? 'flex translate-x-0' : 'flex -translate-x-full',
        )}
        aria-label="Primary navigation"
        aria-hidden={!mobileOpen}
      >
        <div className="flex h-topbar items-center gap-3 border-b border-border px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-forest-deepest text-sm font-bold text-white">
            S
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight text-ink-deepest">
              {appLabel}
            </p>
            <p className="truncate text-xs leading-tight text-ink-muted">{orgLabel}</p>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:bg-surface-subtle"
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <NavGroup
            label="Workspace"
            items={mainItems}
            collapsed={false}
            isActive={isActive}
            onNav={() => setMobileOpen(false)}
          />
          <NavGroup
            label="Operations"
            items={opsItems}
            collapsed={false}
            isActive={isActive}
            onNav={() => setMobileOpen(false)}
          />
        </nav>
        <div className="border-t border-border px-2 py-2">
          <NavGroup
            items={settingsItems}
            collapsed={false}
            isActive={isActive}
            onNav={() => setMobileOpen(false)}
          />
        </div>
      </aside>

      {/* Main column */}
      <div
        className={cn(
          'flex min-h-screen flex-col transition-[padding] duration-base ease-standard',
          'lg:pl-sidebar',
          collapsed && 'lg:pl-sidebar-collapsed',
        )}
      >
        {/* Top bar */}
        <header
          data-ui="chrome"
          className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-border bg-white/90 px-4 backdrop-blur lg:px-6"
        >
          <button
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded text-ink-primary hover:bg-surface-subtle focus-visible:shadow-focus-ring lg:hidden"
            aria-label="Open navigation"
          >
            <Menu size={18} />
          </button>

          {/* Term switcher / context */}
          <div className="hidden cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-subtle md:flex">
            <span className="text-sm font-medium text-ink-primary">{orgLabel}</span>
            <span className="text-xs text-ink-muted">· {orgSubLabel}</span>
          </div>

          {/* Search (placeholder) */}
          <div className="ml-auto hidden max-w-md flex-1 sm:flex">
            <div className="relative w-full">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                aria-hidden
              />
              <input
                type="search"
                placeholder="Search students, invoices, receipts…"
                className="h-9 w-full rounded border border-transparent bg-surface-subtle pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-ink-muted focus:border-border-focus focus:bg-white focus:shadow-focus-ring"
                aria-label="Global search"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="ml-auto flex items-center gap-1 sm:ml-2">
            <button
              className="relative inline-flex h-9 w-9 items-center justify-center rounded text-ink-secondary hover:bg-surface-subtle focus-visible:shadow-focus-ring"
              aria-label="Notifications (4 pending)"
            >
              <Bell size={16} />
              <span
                className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger-fg ring-2 ring-white"
                aria-hidden
              />
            </button>
            <div className="mx-1 h-8 w-px bg-border" aria-hidden />
            <button
              className="inline-flex h-9 items-center gap-2 rounded px-1.5 hover:bg-surface-subtle focus-visible:shadow-focus-ring"
              aria-label="Account menu"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-forest-deep text-xs font-semibold text-white">
                AO
              </div>
              <span className="hidden text-sm text-ink-primary md:inline">Bursar</span>
            </button>
          </div>
        </header>

        {/* Page content */}
        <main id="main-content" className="flex-1">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav
        data-ui="chrome"
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch justify-around border-t border-border bg-white lg:hidden"
        aria-label="Bottom navigation"
      >
        {items
          .filter((i) => i.section === 'main' || i.href === '/preview/list/payments')
          .slice(0, 5)
          .map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]',
                  active ? 'text-forest-primary' : 'text-ink-muted',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <span>{item.icon}</span>
                <span>{item.label.split(' ')[0]}</span>
              </Link>
            );
          })}
      </nav>
    </div>
  );
}

function NavGroup({
  label,
  items,
  collapsed,
  isActive,
  onNav,
}: {
  label?: string;
  items: NavItem[];
  collapsed: boolean;
  isActive: (i: NavItem) => boolean;
  onNav?: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      {label && !collapsed && (
        <div className="px-3 py-1 text-2xs uppercase tracking-wider text-ink-subtle">{label}</div>
      )}
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = isActive(item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNav}
                title={collapsed ? item.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex items-center gap-3 rounded px-3 py-2 text-sm transition-colors',
                  collapsed && 'mx-auto w-10 justify-center px-0',
                  active
                    ? 'bg-forest-tint font-medium text-forest-deepest'
                    : 'text-ink-secondary hover:bg-surface-subtle hover:text-ink-primary',
                  'outline-none focus-visible:shadow-focus-ring',
                )}
              >
                {active && (
                  <span
                    className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-forest-primary"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    'shrink-0',
                    active ? 'text-forest-primary' : 'text-ink-muted group-hover:text-ink-primary',
                  )}
                >
                  {item.icon}
                </span>
                {!collapsed && (
                  <>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge !== undefined && (
                      <span
                        className={cn(
                          'inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm px-1.5 text-xs font-medium',
                          active ? 'bg-forest-primary text-white' : 'bg-neutral-bg text-ink-muted',
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Page container — consistent max-width + padding used by all templates.
 */
export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-content px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        'pb-24 lg:pb-8', // extra bottom padding for mobile bottom nav
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Page header — page title + description + action slot (right side).
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-tight text-ink-deepest lg:text-2xl">
          {title}
        </h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0">{actions}</div>}
    </div>
  );
}

/**
 * Section card — subtle surface for grouping content.
 */
export function Card({
  className,
  children,
  padded = true,
}: {
  className?: string;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-white shadow-xs',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-md font-semibold leading-tight text-ink-primary">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
