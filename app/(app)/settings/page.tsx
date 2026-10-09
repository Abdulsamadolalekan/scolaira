import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import type { ComponentType } from 'react';
import { ArrowRight, Calendar, Naira, Users } from '@/components/ui/icons';

export const runtime = 'nodejs';

/**
 * Settings — an index of the settings surfaces that exist.
 *
 * WHAT WAS WRONG
 *   This page promised "School profile, branding, bank details, terms, sessions,
 *   and access" and then rendered one empty card under the heading
 *   "Workspace settings", with a note about the academic roster and a single
 *   link. Nothing on the page was about school profile, branding or bank
 *   details, and the navigation badged the destination `soon` while it was a
 *   live route. A settings page that describes surfaces it does not have reads
 *   as a product that is not finished — which is exactly the impression the
 *   worst page in the product was creating.
 *
 * WHAT THIS IS
 *   An honest index. Each row is a surface that exists in this build, described
 *   by what it actually controls. Nothing is listed that cannot be opened, and
 *   nothing is promised that has not been built.
 *
 * COMPOSITION
 *   Rules and typography rather than cards — the same grammar as the public
 *   site and the dashboard header. An index is a list of destinations, so it is
 *   set as one, on hairlines, with the ordinal drawn rather than boxed.
 */

type Surface = {
  href: string;
  title: string;
  body: string;
  Icon: ComponentType<{ size?: number }>;
};

const SURFACES: Surface[] = [
  {
    href: '/settings/fees',
    title: 'Fee structure',
    body: 'What each class is billed per term, and the review that must pass — enrolled population, exceptions and totals — before invoices can be issued.',
    Icon: Naira,
  },
  {
    href: '/academic',
    title: 'Academic roster',
    body: 'Sessions, terms, classes, students and term-specific enrolment: the population every invoice is drawn from.',
    Icon: Calendar,
  },
  {
    href: '/members',
    title: 'Members and access',
    body: 'Who can sign in to this school, the role each member holds, and the invitations that are still outstanding.',
    Icon: Users,
  },
];

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        lede="The surfaces that configure this school. Each row opens the workspace that owns it."
      />

      <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {SURFACES.map(({ href, title, body, Icon }, i) => (
          <li key={href}>
            <Link
              href={href}
              className="group flex items-start gap-4 px-5 py-5 transition-colors sm:px-6 sm:py-6"
              style={{ color: 'inherit' }}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-2xs font-semibold tabular-nums"
                style={{ color: 'var(--color-gold-rich)' }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>

              <span
                aria-hidden="true"
                className="mt-0.5 shrink-0"
                style={{ color: 'var(--color-forest-primary)' }}
              >
                <Icon size={18} />
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className="block text-[16px] leading-snug tracking-[-0.01em]"
                  style={{ color: 'var(--color-forest-deepest)', fontWeight: 600 }}
                >
                  {title}
                </span>
                <span
                  className="mt-1.5 block max-w-[62ch] text-pretty text-[13px] leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {body}
                </span>
              </span>

              <span
                aria-hidden="true"
                className="mt-1 hidden shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 sm:block"
                style={{ color: 'var(--color-text-faint)' }}
              >
                <ArrowRight size={16} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
