import type { Metadata } from 'next';
import './globals.css';
import { archivo, inter, jetbrainsMono, sourceSerif } from './fonts';
import { ToastContainer } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Root layout.
 *
 * M1 adds: design-system tokens loaded via globals.css → tokens.css, plus the
 * Toast container (mounted at root for toasts from anywhere in the tree) and
 * TooltipProvider for consistent hover/focus delay.
 *
 * Brand identity: the typefaces are now actually loaded. The tokens had always declared
 * `--font-sans: 'Inter', …` but nothing ever fetched it, so the product rendered in the
 * visitor's system font and the wordmark was never seen in its intended face. The font
 * CSS variables are attached to <html> so both product UI and the brand components can
 * resolve them.
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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${archivo.variable} ${jetbrainsMono.variable} ${sourceSerif.variable}`}
    >
      <body>
        <a
          href="#main-content"
          className="focus:bg-forest sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
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
