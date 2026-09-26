/**
 * `/platform` — organizations this administrator can support.
 *
 * Rendered straight from the platform context (`listPlatformOrgs`), so the list
 * itself is the proof that the database accepted the platform identity: if
 * `auth_is_platform_admin_authorized()` refused, this read returns nothing and
 * the page says so rather than pretending.
 *
 * Entering support mode is a POST to `/api/platform/support-mode` (audited before
 * the cookie is issued). Exiting is a DELETE from the same endpoint.
 */
import { notFound } from 'next/navigation';
import { getSession, clearContext } from '@/lib/auth';
import { listPlatformOrgs, readSupportClaim } from '@/lib/platform/support';
import { EnterSupportButton, ExitSupportButton } from './support-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Organizations' };

function fmt(d: Date) {
  return new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export default async function PlatformHome() {
  const session = await getSession();
  if (!session) return null;
  // Defence in depth, and silence: the layout guards this surface, but Next may
  // render a page concurrently with a layout that is about to 404. Checking here
  // means an ordinary user's request never even attempts platform context (which
  // the database would refuse, correctly but noisily).
  if (!session.user.isPlatformAdmin) notFound();

  const support = await readSupportClaim(session.user.id);
  const orgs = await listPlatformOrgs(session.user.id);
  await clearContext();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1
          className="text-[22px] font-semibold tracking-tight sm:text-2xl"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Organizations
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {orgs.length} organization{orgs.length === 1 ? '' : 's'} visible to platform support.
          Opening one is a read-only visit and leaves an audit record.
        </p>
      </div>

      {support && (
        <div
          className="flex flex-col gap-2 rounded-lg p-4 sm:flex-row sm:items-center sm:justify-between"
          style={{
            backgroundColor: 'var(--color-forest-tint)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <div className="min-w-0">
            <p className="text-[13px] font-medium" style={{ color: 'var(--color-forest-deepest)' }}>
              Support window open
            </p>
            <p className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
              Read-only, until {fmt(support.expiresAt)}. Leave it when you are done.
            </p>
          </div>
          <ExitSupportButton />
        </div>
      )}

      {orgs.length === 0 ? (
        <p className="text-[14px]" style={{ color: 'var(--color-text-secondary)' }}>
          No organizations are visible in platform context. That is expected when the database
          refuses the platform identity — the console shows nothing rather than guessing.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {orgs.map((org) => (
            <li
              key={org.id}
              className="flex flex-col gap-2 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-between"
              style={{
                backgroundColor: 'var(--color-ivory)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              <div className="min-w-0">
                <p
                  className="truncate text-[14px] font-medium"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {org.name}
                </p>
                <p
                  className="text-[11px] uppercase tracking-wide"
                  style={{ color: 'var(--color-text-faint)' }}
                >
                  {org.status}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <a
                  href={`/api/platform/orgs/${org.id}`}
                  className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                  style={{
                    border: '1px solid var(--color-border-subtle)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Read API
                </a>
                {!support && (
                  <EnterSupportButton organizationId={org.id} organizationName={org.name} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
