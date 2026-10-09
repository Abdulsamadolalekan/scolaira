/**
 * Members directory.
 */
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Shield, Plus, ChevronRight, Mail, Clock } from '@/components/ui/icons';
import type { MemberRow } from '@/app/api/members/route';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import { PageHeader } from '@/components/ui/page-header';

export const runtime = 'nodejs';

async function loadMembers(): Promise<MemberRow[]> {
  const cookie = await requestCookieHeader();
  const base = await internalBaseUrl();
  if (!base) return [];
  const res = await fetch(`${base}/api/members`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.members as MemberRow[]) ?? [];
}

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Proprietor',
  SCHOOL_ADMIN: 'Administrator',
  FINANCE_OFFICER: 'Finance Officer',
  STAFF: 'Staff',
};

export default async function MembersPage() {
  const guard = await checkPermission('member.read');
  if (!guard.allowed) {
    return <AccessDenied surface="Members" requiredRole="Proprietor or Administrator" />;
  }
  const members = await loadMembers();
  const active = members.filter((m) => m.status === 'ACTIVE').length;
  const invited = members.filter((m) => m.status === 'INVITED').length;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Members"
        lede="The people who run the school with you, and what they are permitted to do."
        actions={
          <>
            <Link
              href="/members/invite"
              className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--color-forest-deep)] px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]"
            >
              <Plus size={14} /> Invite member
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StripCell label="Total" value={<span className="tabular-nums">{members.length}</span>} />
        <StripCell
          label="Active"
          value={<span className="tabular-nums">{active}</span>}
          tone="positive"
        />
        <StripCell
          label={invited ? `${invited} pending invite` : 'No invites pending'}
          value={invited ? <span className="tabular-nums">{invited}</span> : <span>—</span>}
          tone={invited ? 'warning' : 'muted'}
        />
      </div>

      <Card className="mt-4">
        <CardHeader
          title={members.length === 0 ? 'No members' : 'Team directory'}
          description={
            members.length === 0
              ? 'You are the first member. Invite an administrator or finance officer to get started.'
              : `${active} active member${active === 1 ? '' : 's'}${invited ? ` · ${invited} invite pending` : ''}.`
          }
        />
        {members.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Shield size={22} />}
              title="You are the only member"
              description="Invite trusted staff to help run the school. Each member gets a role with explicit permissions; you can change or revoke access at any time."
            />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                  >
                    <th
                      className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider"
                      style={{ color: 'var(--color-text-faint)' }}
                    >
                      Member
                    </th>
                    <th
                      className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider"
                      style={{ color: 'var(--color-text-faint)' }}
                    >
                      Role
                    </th>
                    <th
                      className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider"
                      style={{ color: 'var(--color-text-faint)' }}
                    >
                      Status
                    </th>
                    <th
                      className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider"
                      style={{ color: 'var(--color-text-faint)' }}
                    >
                      Joined
                    </th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <DesktopRow key={m.id} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
            <ul
              className="divide-y md:hidden"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {members.map((m) => (
                <MobileRow key={m.id} m={m} />
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function StripCell({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
}) {
  const colors = {
    default: 'var(--color-text-primary)',
    positive: 'var(--color-forest-deep)',
    warning: 'var(--color-gold-dark, #8a6b11)',
    muted: 'var(--color-text-faint)',
  } as const;
  return (
    <div
      className="rounded-sm border px-3 py-3"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-page)' }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--color-text-faint)' }}
      >
        {label}
      </div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colors[tone] }}>
        {value}
      </div>
    </div>
  );
}

function DesktopRow({ m }: { m: MemberRow }) {
  return (
    <tr
      className="transition-colors hover:bg-[color:var(--color-forest-tint)]"
      style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
    >
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold"
            style={{
              backgroundColor: 'var(--color-forest-tint)',
              color: 'var(--color-forest-deep)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            {initials(m.name)}
          </div>
          <div className="min-w-0">
            <div className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {m.name}
              {m.isCurrentUser && (
                <span
                  className="ml-2 text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: 'var(--color-text-faint)' }}
                >
                  you
                </span>
              )}
            </div>
            {m.email && (
              <div className="text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                {m.email}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-3 align-top" style={{ color: 'var(--color-text-secondary)' }}>
        {ROLE_LABEL[m.role] ?? m.role}
      </td>
      <td className="px-3 py-3 align-top">
        <StatusBadge m={m} />
      </td>
      <td className="px-3 py-3 align-top text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
        {m.status === 'INVITED' && m.invitedAt ? (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} />
            Invited {m.invitedAt}
          </span>
        ) : (
          (m.joinedAt ?? '—')
        )}
      </td>
      <td className="px-3 py-3 pr-4 text-right align-top">
        <ChevronRight size={14} className="inline opacity-40" />
      </td>
    </tr>
  );
}

function MobileRow({ m }: { m: MemberRow }) {
  return (
    <li>
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
              style={{
                backgroundColor: 'var(--color-forest-tint)',
                color: 'var(--color-forest-deep)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              {initials(m.name)}
            </div>
            <div className="min-w-0">
              <div
                className="text-[14px] font-medium"
                style={{ color: 'var(--color-text-primary)' }}
              >
                {m.name}
                {m.isCurrentUser && (
                  <span
                    className="ml-2 text-[10px] font-medium uppercase tracking-wider"
                    style={{ color: 'var(--color-text-faint)' }}
                  >
                    you
                  </span>
                )}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {ROLE_LABEL[m.role] ?? m.role}
                {m.email ? ` · ${m.email}` : ''}
              </div>
            </div>
          </div>
          <StatusBadge m={m} />
        </div>
      </div>
    </li>
  );
}

function StatusBadge({ m }: { m: MemberRow }) {
  if (m.status === 'ACTIVE') return <Badge variant="success">Active</Badge>;
  if (m.status === 'INVITED')
    return (
      <Badge variant="warning">
        <span className="inline-flex items-center gap-1">
          <Mail size={10} />
          Invited
        </span>
      </Badge>
    );
  return <Badge variant="neutral">Disabled</Badge>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
  ).toUpperCase();
}
