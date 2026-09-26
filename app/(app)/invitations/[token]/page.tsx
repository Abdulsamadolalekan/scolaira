/**
 * Accept an invitation — `/invitations/<token>`.
 *
 * A GET here must never consume the token: mail clients and chat previews fetch
 * links before a human sees them. The page therefore only *describes* the
 * invitation (`previewInvitation`, a read), and acceptance is a CSRF-protected
 * POST from the button.
 *
 * The page also has to survive being opened by the wrong person. If the signed-in
 * email is not the invited email the page says so plainly and offers the way out
 * (sign out, then sign in as the invited address) instead of a dead end.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { getSession, clearContext } from '@/lib/auth';
import { previewInvitation } from '@/lib/members/invitations';
import { AcceptInvitation } from './accept-invitation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Invitation' };

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Proprietor',
  SCHOOL_ADMIN: 'Administrator',
  FINANCE_OFFICER: 'Finance Officer',
  STAFF: 'Staff',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:px-6 lg:py-10">
      <Card>
        <CardHeader title="Team invitation" description="SCOLAIRA school finance workspace" />
        <div className="px-4 pb-5 pt-1 sm:px-5">{children}</div>
      </Card>
    </div>
  );
}

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/invitations/${token}`)}`);
  }

  const preview = await previewInvitation(token);
  await clearContext();

  if (!preview) {
    return (
      <Shell>
        <p className="text-[14px]" style={{ color: 'var(--color-text-primary)' }}>
          This invitation link is not recognised. It may have been copied incompletely — ask for a
          fresh link.
        </p>
      </Shell>
    );
  }

  const roleLabel = ROLE_LABEL[preview.role] ?? preview.role;
  const dateFmt = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium' });
  const emailMatches = session.user.email.trim().toLowerCase() === preview.email;

  if (!preview.usable) {
    return (
      <Shell>
        <p className="text-[14px]" style={{ color: 'var(--color-text-primary)' }}>
          This invitation to <strong>{preview.organizationName}</strong>{' '}
          {preview.status === 'ACCEPTED' ? 'has already been accepted.' : 'is no longer active.'}
        </p>
        <p className="mt-3 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
          Invitations expire after seven days and can only be used once.
        </p>
      </Shell>
    );
  }

  if (!emailMatches) {
    return (
      <Shell>
        <p className="text-[14px]" style={{ color: 'var(--color-text-primary)' }}>
          This invitation was issued to <strong>{preview.email}</strong>, but you are signed in as{' '}
          <strong>{session.user.email}</strong>.
        </p>
        <p className="mt-3 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
          Sign out and sign in as the invited address to accept it. The link stays valid until{' '}
          {dateFmt.format(preview.expiresAt)}.
        </p>
        <Link
          href="/login"
          className="mt-4 inline-block rounded-md px-3 py-2 text-[13px] font-medium"
          style={{ backgroundColor: 'var(--color-forest)', color: 'var(--color-ivory)' }}
        >
          Go to sign in
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-[14px]" style={{ color: 'var(--color-text-primary)' }}>
        You have been invited to join <strong>{preview.organizationName}</strong> as{' '}
        <strong>{roleLabel}</strong>.
      </p>
      <p className="mt-2 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
        The link expires {dateFmt.format(preview.expiresAt)} and works once.
      </p>
      <div className="mt-4">
        <AcceptInvitation token={token} organizationName={preview.organizationName} />
      </div>
    </Shell>
  );
}
