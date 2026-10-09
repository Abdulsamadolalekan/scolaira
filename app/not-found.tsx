import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <div className="space-y-4">
        <p className="text-sm font-medium uppercase tracking-widest text-ink-muted">404</p>
        <h1 className="text-display-md font-semibold text-forest-deepest">Page not found</h1>
        <p className="text-ink-muted">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block rounded-sm bg-[color:var(--color-forest-deep)] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
