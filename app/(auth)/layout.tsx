import type { ReactNode } from 'react';
import { ScolairaLockup } from '@/components/brand';

/**
 * Auth layout — minimal, centered, Deep Forest Green/Gold/Ivory per M1.
 * No navigation chrome. Serves login / register / password-reset flows.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-12"
      style={{
        background:
          'radial-gradient(circle at 20% 0%, rgba(22, 62, 45, 0.08), transparent 55%),' +
          'radial-gradient(circle at 85% 100%, rgba(191, 155, 79, 0.10), transparent 45%),' +
          'var(--color-bg-page)',
      }}
    >
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          {/* Responsive hierarchy: the wordmark is shown here at every width
              because the auth column always has room for it. */}
          <div className="mb-3 inline-flex justify-center">
            <ScolairaLockup size={40} title="SCOLAIRA" />
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            School financial operations.
          </p>
        </div>
        <div
          className="rounded-xl p-8"
          style={{
            backgroundColor: 'var(--color-ivory)',
            border: '1px solid var(--color-border-subtle)',
            boxShadow: '0 1px 2px rgba(17, 24, 15, 0.04), 0 8px 24px -8px rgba(22, 62, 45, 0.12)',
          }}
        >
          {children}
        </div>
        <p className="mt-6 text-center text-xs" style={{ color: 'var(--color-text-faint)' }}>
          Protected access. Unauthorized attempts are logged.
        </p>
      </div>
    </div>
  );
}

export const metadata = {
  title: 'Sign in · SCOLAIRA',
};
