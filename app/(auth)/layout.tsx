import type { ReactNode } from 'react';

/**
 * Auth layout — minimal, centered, Deep Forest Green/Gold/Ivory per M1.
 * No navigation chrome. Serves login / register / password-reset flows.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
         style={{
           background:
             'radial-gradient(circle at 20% 0%, rgba(22, 62, 45, 0.08), transparent 55%),' +
             'radial-gradient(circle at 85% 100%, rgba(191, 155, 79, 0.10), transparent 45%),' +
             'var(--color-bg-page)',
         }}>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <div
              className="h-10 w-10 rounded-xl flex items-center justify-center"
              style={{
                backgroundColor: 'var(--color-forest-deep)',
                color: 'var(--color-ivory)',
                border: '1px solid var(--color-gold)',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 7L12 3L20 7V17L12 21L4 17V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                <path d="M12 3V12M12 12L20 7M12 12L4 7" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
          <h1
            className="text-2xl tracking-tight"
            style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
          >
            SCOLAIRA
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
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
        <p
          className="text-xs text-center mt-6"
          style={{ color: 'var(--color-text-faint)' }}
        >
          Protected access. Unauthorized attempts are logged.
        </p>
      </div>
    </div>
  );
}

export const metadata = {
  title: 'Sign in · SCOLAIRA',
};
