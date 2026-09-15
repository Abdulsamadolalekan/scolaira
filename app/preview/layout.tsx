'use client';

import { NavShell } from '@/components/ui/nav-shell';

/**
 * The `/preview/*` routes render the design system inside the navigation shell.
 * These routes are for internal UI validation / visual QA in M1 and can be
 * removed or gated behind an admin flag before launch.
 */
export default function UiLayout({ children }: { children: React.ReactNode }) {
  return <NavShell>{children}</NavShell>;
}
