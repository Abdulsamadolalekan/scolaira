'use client';

/**
 * Print controls for server-rendered printable surfaces.
 *
 * React Server Components cannot pass event handlers across the server→client
 * boundary (`Event handlers cannot be passed to Client Component props`), so a
 * server page that renders `<button onClick={...}>` fails at render time —
 * in production this surfaces as a 500 rather than a build error. The
 * printable statement of account and the printable receipt of record both need
 * a Print control, so the interactive part lives here and the pages stay
 * server-rendered (they load data server-side and print-styled).
 *
 * Both controls are inert without JavaScript: the document itself remains
 * complete and printable via the browser's own print command.
 */

/** Printable statement of account: styled by that page's own print stylesheet. */
export function StatementActions() {
  return (
    <div className="cta no-print">
      <button className="btn" onClick={() => window.print()}>
        Print / Save as PDF
      </button>
      <button className="btn secondary" onClick={() => history.back()}>
        Back
      </button>
    </div>
  );
}

/** Printable receipt of record: matches the app shell's Tailwind surface. */
export function PrintReceiptButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-sm bg-[color:var(--color-forest-deep)] px-3 py-2 text-[13px] font-medium text-white"
    >
      Print receipt
    </button>
  );
}
