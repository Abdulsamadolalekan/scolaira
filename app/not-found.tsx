import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <div className="space-y-4">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">404</p>
        <h1 className="text-2xl font-semibold text-neutral-900">Page not found</h1>
        <p className="text-neutral-600">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
