import { redirect } from 'next/navigation';

/**
 * Root — redirects to Command Center (the default M1 shell).
 *
 * Landing pages / marketing site live outside the authenticated app.
 * In M1 the product shell is the primary entry point for visual QA.
 */
export default function RootPage() {
  redirect('/preview/command-center');
}
