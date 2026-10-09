import type { ReactNode } from 'react';
import { ScolairaLockup } from '@/components/brand';

/**
 * Auth layout — the front door.
 *
 * REDESIGN NOTE (2026-09)
 *   The previous shell centred a rounded card on a background made of two radial
 *   gradients, with a drop shadow — the visual grammar of a generic SaaS login
 *   and the opposite of the institutional register the product is aiming for.
 *   It also said nothing: a visitor arriving from a link had no idea what they
 *   were signing in to.
 *
 *   This is a split entrance instead. The left panel is the institution speaking
 *   — mark, promise, and three structural facts about how the money is handled,
 *   in the display serif on deep forest. The right is the instrument: the form,
 *   on plain paper, with no box, no shadow and no decoration competing with it.
 *   On a phone the panel becomes a compact band above the form rather than a
 *   second screen to scroll past.
 *
 *   NO AUTH LOGIC LIVES HERE. The forms, their fields, their actions and their
 *   CSRF handling are untouched (H-4).
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ── The institution speaking ── */}
      <aside
        className="flex shrink-0 flex-col justify-between px-6 py-7 lg:w-[46%] lg:max-w-[620px] lg:px-14 lg:py-14"
        style={{ backgroundColor: 'var(--color-forest-deepest)' }}
      >
        <div className="flex items-center justify-between gap-6">
          <ScolairaLockup
            size={24}
            tone="onDark"
            descriptor="School finance"
            descriptorClassName="hidden sm:block"
          />
          <span
            className="text-[10px] uppercase tracking-[0.18em] lg:hidden"
            style={{ color: 'rgba(253, 251, 246, 0.5)' }}
          >
            Secure access
          </span>
        </div>

        {/* The promise — the reason this product exists, stated where everyone who
            signs in will read it at least once. */}
        <div className="mt-8 lg:mt-0">
          <p
            className="text-ivory"
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 'clamp(26px, 4.2vw, 42px)',
              lineHeight: 1.12,
              letterSpacing: '-0.02em',
            }}
          >
            Every term,
            <br />
            fully funded.
          </p>
          <p
            className="mt-4 hidden max-w-[46ch] text-[13.5px] leading-relaxed lg:block"
            style={{ color: 'rgba(253, 251, 246, 0.62)' }}
          >
            Fees billed by term, money recorded as it arrives, every naira matched to the invoice it
            settles — and the position provable on any day of the term.
          </p>

          <ul className="mt-8 hidden space-y-3 lg:block">
            {[
              'Each school is isolated at the database layer.',
              'Money is held as integer kobo — never a floating point.',
              'Balances are derived from the ledger, not copied from it.',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-3 text-[13px] leading-relaxed"
                style={{ color: 'rgba(253, 251, 246, 0.72)' }}
              >
                <span
                  aria-hidden
                  className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: 'var(--color-gold-reference)' }}
                />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p
          className="mt-8 hidden text-[11px] lg:block"
          style={{ color: 'rgba(253, 251, 246, 0.42)' }}
        >
          Protected access. Unauthorized attempts are logged.
        </p>
      </aside>

      {/* ── The instrument ── */}
      <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10 lg:py-16">
        <div className="w-full max-w-[404px]">
          {children}
          <p className="mt-8 text-[11px] text-ink-subtle lg:hidden">
            Protected access. Unauthorized attempts are logged.
          </p>
        </div>
      </main>
    </div>
  );
}

export const metadata = {
  title: 'Sign in · SCOLAIRA',
};
