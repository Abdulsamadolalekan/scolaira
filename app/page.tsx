/**
 * SCOLAIRA landing (M0 minimal).
 *
 * The public marketing site lives on scolaira.com in the future.
 * For the app (app.scolaira.com), the root redirects to the Command Center
 * once auth is live (M3+). M0 shows a simple foundation-status page that:
 *  - confirms the app is serving
 *  - links to the health endpoint
 *  - makes it visually obvious this is a foundation build, not a finished product.
 *
 * No fake product UI, no fake numbers, no placeholder buttons.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
            SCOLAIRA · M0 Foundation
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
            The Financial Operating System for Nigerian Private Schools.
          </h1>
          <p className="text-base leading-relaxed text-neutral-600">
            Every term, fully funded. Foundation skeleton is in place; product surfaces are being
            built in the upcoming milestones.
          </p>
        </div>

        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
            System status
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-neutral-700">
            <li>
              <span className="font-medium">Application:</span> running
            </li>
            <li>
              <span className="font-medium">Health endpoint:</span>{' '}
              <a
                href="/api/health"
                className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
              >
                /api/health
              </a>
            </li>
            <li>
              <span className="font-medium">Current milestone:</span> M0 — Project Skeleton
            </li>
          </ul>
        </div>

        <p className="text-xs text-neutral-500">
          This is an engineering build. No financial data should be entered here until later
          milestones complete and staging is configured.
        </p>
      </div>
    </main>
  );
}
