import type { Metadata } from 'next';
import './globals.css';
import { ToastContainer } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Root layout.
 *
 * M1 adds: design-system tokens loaded via globals.css → tokens.css, plus the
 * Toast container (mounted at root for toasts from anywhere in the tree) and
 * TooltipProvider for consistent hover/focus delay.
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
      <body>
        <a
          href="#main-content"
          className="focus:bg-forest sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
        >
          Skip to main content
        </a>
        <TooltipProvider delayDuration={200}>
          <ToastContainer>{children}</ToastContainer>
        </TooltipProvider>
      </body>
    </html>
  );
}
