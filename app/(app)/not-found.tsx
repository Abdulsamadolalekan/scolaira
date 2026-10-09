import Link from 'next/link';

export const runtime = 'nodejs';

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-24 text-center">
      <p
        className="text-xs font-medium uppercase tracking-[0.14em]"
        style={{ color: 'var(--color-text-faint)' }}
      >
        404
      </p>
      <h1
        className="mt-2 text-display-md font-semibold tracking-[-0.015em]"
        style={{ color: 'var(--color-forest-deepest)' }}
      >
        We can&apos;t find that page.
      </h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        The page you are looking for may have moved, or you may not have permission to see it.
      </p>
      <div className="mt-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-sm bg-[color:var(--color-forest-deep)] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          Return to command center
        </Link>
      </div>
    </div>
  );
}
