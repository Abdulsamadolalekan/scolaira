import type { Metadata } from 'next';
import './globals.css';

/**
 * Root layout — M0 minimal shell.
 *
 * This is intentionally unstyled beyond the HTML document scaffolding.
 * The design system (typography, color, navigation shell) is introduced in M1.
 */
export const metadata: Metadata = {
  title: {
    default: 'SCOLAIRA — Financial Operating System for Nigerian Private Schools',
    template: '%s · SCOLAIRA',
  },
  description:
    'Every term, fully funded. The financial operating system for Nigerian private schools.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-white text-neutral-900">{children}</body>
    </html>
  );
}
