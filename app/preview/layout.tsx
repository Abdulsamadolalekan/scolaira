/**
 * Preview routes (design-system templates).
 *
 * Per M4 policy §7 (preview answer: dev-only): these pages are available only
 * outside production. They render mock data with no DB access, but they
 * expose future UI patterns and should never ship in production.
 */
import { notFound } from 'next/navigation';
import { NavShell } from '@/components/ui/nav-shell';

export const runtime = 'nodejs';

export default function UiLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return <NavShell>{children}</NavShell>;
}
