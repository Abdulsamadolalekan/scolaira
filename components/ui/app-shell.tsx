/**
 * Authenticated application shell.
 *
 * Design notes (SCOLAIRA principle level 4):
 *  - Top bar carries organization identity + user, NOT a brand billboard.
 *  - Left rail is calm, low-chrome, section-divided, uses SCOLAIRA icons.
 *  - Content area has generous whitespace; numbers and tables should breathe.
 *  - Gold appears only where it signals trust or selected state — never as noise.
 *  - On mobile (<md) rail collapses above content (single-column stacking);
 *    no heavy drawer animation — it should feel immediate and reliable on
 *    inexpensive Android devices.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import {
  LogOut, ChevronDown,
  LayoutDashboard, FileText, Naira, Users, Settings, Shield, Bell, AlertTriangle,
} from '@/components/ui/icons';

export type IconKey = 'dashboard' | 'invoices' | 'payments' | 'students' | 'members' | 'settings' | 'bell' | 'debtors';

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
interface AppShellProps {
  user: { name: string; email: string; initials: string; role: string | null };
  org: { name: string; role: string | null; switcherHref: string | null };
  nav: NavSection[];
  sessionAction: string;
  children: React.ReactNode;
}

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Proprietor',
  SCHOOL_ADMIN: 'Administrator',
  FINANCE_OFFICER: 'Finance Officer',
  STAFF: 'Staff',
};

export function AppShell({ user, org, nav, sessionAction, children }: AppShellProps) {
  const pathname = usePathname();
  const roleLabel = org.role ? (ROLE_LABEL[org.role] ?? org.role) : null;

  const isActive = (item: NavItem) => {
    const pfx = item.matchPrefix ?? item.href;
    return pathname === pfx || pathname.startsWith(pfx + '/');
  };

  return (
    <div
      className="min-h-screen flex flex-col md:flex-row"
      style={{ backgroundColor: 'var(--color-bg-page)' }}
    >
      {/* ——— Sidebar ——— */}
      <aside
        className="md:w-64 md:min-h-screen md:sticky md:top-0 md:border-b-0 flex flex-col"
        style={{
          backgroundColor: 'var(--color-ivory)',
          borderRight: '1px solid var(--color-border-subtle)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        {/* Brand */}
        <div className="px-4 pt-5 pb-4 flex items-center gap-2.5">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              backgroundColor: 'var(--color-forest-deep)',
              color: 'var(--color-ivory)',
              border: '1px solid var(--color-gold)',
            }}
            aria-hidden
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 7L12 3L20 7V17L12 21L4 17V7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 3V12M12 12L20 7M12 12L4 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex flex-col leading-tight">
            <span
              className="font-semibold tracking-tight text-[15px]"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
            >
              SCOLAIRA
            </span>
            <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--color-text-faint)' }}>
              School finance
            </span>
          </div>
        </div>

        {/* Workspace selector (read-only for M5) */}
        <div className="px-3 pb-3">
          <div
            className="rounded-lg px-3 py-2 text-left w-full flex items-center gap-2"
            style={{
              backgroundColor: 'var(--color-forest-tint)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            <div
              className="h-6 w-6 rounded-md text-[10px] font-semibold flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--color-forest-deep)', color: 'var(--color-ivory)' }}
            >
              {org.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="text-[13px] font-medium truncate"
                style={{ color: 'var(--color-forest-deepest)' }}
                title={org.name}
              >
                {org.name}
              </div>
              {roleLabel && (
                <div className="text-[11px]" style={{ color: 'var(--color-forest)' }}>
                  {roleLabel}
                </div>
              )}
            </div>
            <ChevronDown size={14} className="opacity-50" aria-hidden />
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 pb-4 overflow-y-auto">
          {nav.map((section) => (
            <div key={section.section} className="mb-4">
              <div
                className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.12em] font-medium"
                style={{ color: 'var(--color-text-faint)' }}
              >
                {section.section}
              </div>
              <ul className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
                {section.items.map((item) => {
                  const Icon = ICONS[item.icon] ?? ICONS.dashboard;
                  const active = isActive(item);
                  return (
                    <li key={item.href} className="shrink-0 md:w-full">
                      <Link
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                          'whitespace-nowrap md:whitespace-normal',
                        )}
                        style={{
                          color: active
                            ? 'var(--color-forest-deepest)'
                            : 'var(--color-text-secondary)',
                          backgroundColor: active
                            ? 'var(--color-forest-tint)'
                            : 'transparent',
                          fontWeight: active ? 600 : 400,
                          border: active
                            ? '1px solid var(--color-border-subtle)'
                            : '1px solid transparent',
                        }}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span
                          className="shrink-0 inline-flex"
                          style={{ color: active ? 'var(--color-forest)' : 'var(--color-text-muted)' }}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="flex-1">{item.label}</span>
                        {item.badge === 'soon' ? (
                          <span
                            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
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
                            className="text-[10px] font-semibold h-5 min-w-[20px] px-1.5 rounded-full inline-flex items-center justify-center"
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

        {/* User card */}
        <div
          className="m-3 mt-auto rounded-lg p-3 flex items-center gap-2.5"
          style={{
            backgroundColor: 'var(--color-bg-page)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <div
            className="h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0"
            style={{ backgroundColor: 'var(--color-forest-tint)', color: 'var(--color-forest-deep)' }}
          >
            {user.initials || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[13px] font-medium truncate"
              style={{ color: 'var(--color-text-primary)' }}
              title={user.name}
            >
              {user.name}
            </div>
            <div
              className="text-[11px] truncate"
              style={{ color: 'var(--color-text-muted)' }}
              title={user.email}
            >
              {user.email}
            </div>
          </div>
          <form action={sessionAction} method="post">
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="p-1.5 rounded-md opacity-60 hover:opacity-100 transition-opacity"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <LogOut size={15} />
            </button>
          </form>
        </div>
      </aside>

      {/* ——— Main ——— */}
      <main className="flex-1 min-w-0">
        {children}
      </main>
    </div>
  );
}
