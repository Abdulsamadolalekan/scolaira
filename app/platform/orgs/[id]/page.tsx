/**
 * `/platform/orgs/[id]` — read-only support view of one organization.
 *
 * Three gates stand between the URL and any data:
 *   1. the platform layout (database-loaded `isPlatformAdmin`),
 *   2. a *verified* support claim bound to this user and this org — the page
 *      refuses to render another organization without one,
 *   3. `loadSupportOrgDetail`, which runs in database-minted platform context.
 *
 * There is no write control on this page, by design. Support mode cannot change
 * the organization it is looking at; if a change is needed, its own members make
 * it.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearContext } from '@/lib/auth';
import { listPlatformOrgs, loadSupportOrgDetail, readSupportClaim } from '@/lib/platform/support';
import { ExitSupportButton } from '../../support-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Organization' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlatformOrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getSession();
  if (!session) return null;
  if (!session.user.isPlatformAdmin) notFound();

  const support = await readSupportClaim(session.user.id);
  const ownOrgs = await listPlatformOrgs(session.user.id);

  // Without an open support window, this page shows only what the console list
  // already shows: identity and status, never tenant contents.
  if (!support || support.organizationId !== id) {
    await clearContext();
    const listed = ownOrgs.find((o) => o.id === id);
    if (!listed) notFound();
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/platform"
          className="text-[12px]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          ← All organizations
        </Link>
        <h1
          className="text-[20px] font-semibold tracking-tight"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          {listed.name}
        </h1>
        <p className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
          Status {listed.status}. Detailed figures require a support window, which is a recorded
          read-only visit.
        </p>
      </div>
    );
  }

  const detail = await loadSupportOrgDetail(session.user.id, id);
  await clearContext();
  if (!detail) notFound();

  const dateFmt = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/platform"
        className="text-[12px]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        ← All organizations
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1
            className="text-[22px] font-semibold tracking-tight sm:text-2xl"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            {detail.name}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
            Status {detail.status} · support window open until {dateFmt.format(support.expiresAt)}
          </p>
        </div>
        <ExitSupportButton />
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: 'Members', value: detail.memberCount },
          { label: 'Students', value: detail.studentCount },
          {
            label: 'Oldest audit record',
            value: detail.lastAuditAt ? dateFmt.format(detail.lastAuditAt) : 'None',
          },
        ].map((cell) => (
          <div
            key={cell.label}
            className="rounded-lg p-3"
            style={{
              backgroundColor: 'var(--color-ivory)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            <dt
              className="text-[11px] uppercase tracking-wide"
              style={{ color: 'var(--color-text-faint)' }}
            >
              {cell.label}
            </dt>
            <dd
              className="mt-1 break-words text-[18px] font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
        Read-only. This visit is recorded in {detail.name}&rsquo;s audit trail with your account and
        the time it was opened.
      </p>
    </div>
  );
}
