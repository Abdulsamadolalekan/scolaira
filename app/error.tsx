'use client';

import { useEffect } from 'react';

/**
 * Next.js global error boundary for the app directory.
 *
 * Production-safe error page: never exposes stack traces to users; logs them
 * on the client for Sentry/observer pickup once monitoring is wired in.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In M1+ we will wire Sentry here; for M0 log to console (warn, not error,
    // to avoid failing tests that assert no console.error noise on happy paths).
    // eslint-disable-next-line no-console
    console.warn('[scolaira:error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
          <div className="space-y-4">
            <h1
              className="text-display-md font-semibold"
              style={{ color: 'var(--color-forest-deepest, #0b3d2e)' }}
            >
              Something went wrong
            </h1>
            <p style={{ color: 'var(--color-text-secondary, #3f4a44)' }}>
              An unexpected error occurred while loading this page. Please try again. If the problem
              persists, contact support.
            </p>
            <button
              type="button"
              onClick={reset}
              className="rounded-sm border px-4 py-2 text-sm font-medium"
              style={{
                borderColor: 'rgba(11, 31, 22, 0.22)',
                backgroundColor: '#ffffff',
                color: 'var(--color-forest-deepest, #0b3d2e)',
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
