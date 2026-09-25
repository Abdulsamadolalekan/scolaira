import Link from 'next/link';

export const runtime = 'nodejs';

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-24 text-center">
      <p className="text-xs uppercase tracking-[0.14em] font-medium" style={{ color: 'var(--color-text-faint)' }}>
        404
      </p>
      <h1
        className="mt-2 text-2xl font-semibold tracking-tight"
        style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}
      >
        We can&apos;t find that page.
      </h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        The page you are looking for may have moved, or you may not have permission to see it.
      </p>
      <div className="mt-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-md bg-[color:var(--color-forest)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-forest-deep)]"
        >
          Return to command center
        </Link>
      </div>
    </div>
  );
}
