/**
 * Invite a member — the destination the frozen members page already links to.
 *
 * The link `/members/invite` has existed in `app/(app)/members/page.tsx` since
 * M5 while no route answered it (404 on click). H-8 does not edit that frozen
 * file: it makes the destination real, which is the smaller change and keeps the
 * M5 freeze intact.
 *
 * Decision D-1: the invitation is delivered as a link. The one-time token is
 * rendered once, here, and never stored client-side beyond the page's lifetime;
 * the inviter copies it into whatever channel they already use (WhatsApp,
 * printed slip, SMS). No email provider is involved.
 */
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { AccessDenied } from '@/components/access-denied';
import { checkPermission } from '@/components/permission-guard';
import { InviteForm } from './invite-form';

export const runtime = 'nodejs';
export const metadata = { title: 'Invite member' };

export default async function InviteMemberPage() {
  const guard = await checkPermission('member.invite');
  if (!guard.allowed) {
    return <AccessDenied surface="Invitations" requiredRole="Proprietor or Administrator" />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1
          className="text-[22px] font-semibold tracking-tight sm:text-2xl"
          style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
        >
          Invite a member
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Create a single-use link for one address. The link expires in seven days and can be used
          once.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Who are you adding?"
          description="Ownership is transferred, never invited — this grants Administrator, Finance Officer or Staff."
        />
        <div className="px-4 pb-5 pt-1 sm:px-5">
          <InviteForm />
        </div>
      </Card>
    </div>
  );
}
