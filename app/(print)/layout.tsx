/**
 * Print route group — no app shell / nav chrome. These pages are served
 * inside the authenticated envelope (middleware guards them) but render
 * plain HTML documents suitable for printing, without navigation chrome.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return children;
}
