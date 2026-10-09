/**
 * SCOLAIRA typefaces.
 *
 * WHY THIS FILE EXISTS
 *   The design tokens declared `--font-sans: 'Inter', …` from the beginning, but no
 *   `next/font` import ever existed — so Inter was never loaded, and every surface
 *   rendered in whatever the visitor's operating system provided. The declared brand
 *   typeface has never actually been on screen.
 *
 *   This file makes the typography real. It also fixes the wordmark: it was previously
 *   set in `var(--font-sans)`, which resolved to a system fallback, which is why it read
 *   as a default rather than as a decision.
 *
 * WHY ARCHIVO
 *   Chosen in a five-candidate study (see the typography exploration), judged on
 *   letterform architecture rather than reputation:
 *     · the capital A has a FLAT apex — architectural, not the pointed startup apex;
 *     · the C and S terminals are cut horizontally, the Swiss-grotesque discipline;
 *     · the O is wide and near-circular, echoing the coin in the mark;
 *     · the stroke weight is even and the spacing rhythm is calm;
 *     · it is genuinely not Inter — which is the whole point, since Inter is the
 *       default that reads as "template".
 *   It is released under the SIL Open Font License and served from Google Fonts, so it
 *   costs nothing and is licence-clean for commercial use. `next/font` self-hosts it at
 *   build time: no runtime request to a third party, no layout shift, no FOUT.
 *
 * WHY BOTH A SANS AND A WORDMARK VARIABLE
 *   `--font-wordmark` is what the brand components bind to. Keeping it separate from
 *   `--font-sans` means the identity can change its own typeface without touching
 *   product UI, and vice versa. Today they are the same family, deliberately: a brand
 *   whose wordmark is set in a face the product never uses is a brand in two voices.
 */
import { Archivo, Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';

/**
 * The identity typeface. Bound to `--font-wordmark`, NOT to `--font-sans`.
 *
 * This separation is deliberate. The wordmark needs a distinctive, institutional face;
 * the product UI needs a neutral one it has been designed against. Pointing both at
 * Archivo would have re-typeset every screen in the application — a far larger change
 * than a brand exercise is entitled to make. The identity gets its own voice; unrelated
 * UI keeps the one it was built with.
 */
export const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-archivo',
  display: 'swap',
  // The wordmark is set in caps; optical sizing is not needed, but a fallback chain is
  // declared so a font-loading failure degrades to a grotesque rather than to Times.
  fallback: ['ui-sans-serif', 'system-ui', 'Helvetica Neue', 'Arial', 'sans-serif'],
  adjustFontFallback: true,
});

/**
 * Product UI typeface — what `--font-sans` always claimed to be.
 *
 * No visual change of intent: the token has declared Inter since M1. It simply never
 * loaded, so every screen silently rendered in the visitor's system font. Loading it
 * restores the declared design rather than replacing it.
 */
export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
  fallback: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Arial',
    'sans-serif',
  ],
  adjustFontFallback: true,
});

/**
 * Monospace, for money and tabular figures.
 *
 * Only loaded when a surface needs it — the token now points at a font that actually
 * exists, rather than at `'JetBrains Mono'` with nothing to resolve it.
 */
export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
});

/**
 * The EDITORIAL voice — display serif.
 *
 * WHY THIS EXISTS
 *   `var(--font-serif)` has been referenced by every page title in the product
 *   since M1, but was never defined anywhere and no serif was ever loaded. The
 *   measured consequence (redesign baseline, 84 captures): every `h1` in the
 *   application rendered in the UI sans at a single 22px size. The product had
 *   no display level at all — which is precisely why nothing in it read as
 *   institutional.
 *
 * WHY SOURCE SERIF
 *   The direction is "private bank × distinguished school". That needs a serif
 *   with institutional composure rather than literary flourish: an open,
 *   low-contrast transitional face with sturdy, unambiguous figures. Source
 *   Serif 4 (Frank Grießhammer / Adobe, SIL OFL) is exactly that class of
 *   typeface — it is the face of documentation and record-keeping, not of
 *   wedding invitations. It reads as authority at display sizes and stays
 *   legible when it has to carry a sentence.
 *
 *   It is NOT used for the wordmark or any brand geometry: the identity is
 *   frozen. This face belongs to the PRODUCT's voice, and `--font-wordmark`
 *   still resolves to Archivo, untouched.
 */
export const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal'],
  variable: '--font-source-serif',
  display: 'swap',
  fallback: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
  adjustFontFallback: true,
});
