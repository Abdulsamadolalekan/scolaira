/**
 * SCOLAIRA mark geometry — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Produced by /home/user/brand/emit_ts.py from the same emitter that produces the
 * production SVGs, so the shipping component and the master art cannot drift apart.
 *
 * Grid: 64 x 64. Flat paths only — no gradients, masks, filters or embedded raster.
 * Knockouts use fill-rule="evenodd" on a single path (masks are deliberately avoided:
 * cairosvg — and some PDF rasterisers — ignore <mask> silently).
 *
 * Refinement notes (v2):
 *   · The Naira glyph is 17.2 x 17.8 — 54% of the coin field. The approved scale was
 *     14.0 x 14.6 (44%), which was small for a denomination device and was the cause of
 *     the mark's small-size legibility limit. Construction is otherwise identical:
 *     stem 2.7, crossbars at 0.355/0.645 of cap height, same diagonal.
 *   · The knot resolves the cord/tassel junction.
 *   · Everything else — coin radii, board geometry, crown base curve, button — is the
 *     approved construction, unchanged.
 */

/** Coin: outer disc with the rim/field channel knocked out (evenodd). */
export const MARK_COIN_RING =
  'M50.50 41.50A18.50 18.50 0 1 1 13.50 41.50A18.50 18.50 0 1 1 50.50 41.50Z M48.80 41.50A16.80 16.80 0 1 1 15.20 41.50A16.80 16.80 0 1 1 48.80 41.50Z';

/** Coin: inner field disc. */
export const MARK_COIN_FIELD =
  'M47.90 41.50A15.90 15.90 0 1 1 16.10 41.50A15.90 15.90 0 1 1 47.90 41.50Z';

/** Mortarboard crown (body). */
export const MARK_CROWN = 'M24 18.5L40 18.5L40 29.5Q32.0 34.2 24 29.5Z';

/** Mortarboard board. */
export const MARK_BOARD = 'M32.0 8.0L53.5 18.5L32.0 29.0L10.5 18.5Z';

/** Cord from the crown to the tassel knot. */
export const MARK_CORD = 'M34 18.5L53.5 18.5';

/** Stem dropping from the attachment knot to the tassel. */
export const MARK_KNOT_STEM = 'M53.5 19.45L53.5 25.60';

/** Tassel body. */
export const MARK_TASSEL = 'M51.65 25.60L55.35 25.60L55.05 32.60Q53.5 34.60 51.95 32.60Z';

/** Attachment knot centre, y — on the board's right vertex. */
export const MARK_ATTACH_KNOT_CY = '18.5';

/** Attachment knot radius — identical to the cap button radius, by design. */
export const MARK_ATTACH_KNOT_R = '2.0';

/** Naira glyph — real vector outlines, not a font glyph. */
export const MARK_NAIRA =
  'M21.90 40.67 23.40 40.67 23.40 43.13 21.90 43.13 21.90 45.83 23.40 45.83 23.40 50.80 26.10 50.80 26.10 45.83 34.61 45.83 37.90 50.80 40.60 50.80 40.60 45.83 42.10 45.83 42.10 43.13 40.60 43.13 40.60 40.67 42.10 40.67 42.10 37.97 40.60 37.97 40.60 33.00 37.90 33.00 37.90 37.97 32.63 37.97 29.34 33.00 23.40 33.00 23.40 37.97 21.90 37.97ZM26.10 33.00 26.10 37.97 29.39 37.97ZM26.10 43.13 32.82 43.13 31.18 40.67 26.10 40.67ZM34.42 40.67 36.06 43.13 37.90 43.13 37.90 40.67ZM37.85 45.83 37.90 45.91 37.90 45.83Z';

/** Simplified mark: coin rim and field. */
export const MARK_SMALL_COIN_RING =
  'M52.50 41.40A20.50 20.50 0 1 1 11.50 41.40A20.50 20.50 0 1 1 52.50 41.40Z M51.00 41.40A19.00 19.00 0 1 1 13.00 41.40A19.00 19.00 0 1 1 51.00 41.40Z';

/** Simplified mark: field disc. */
export const MARK_SMALL_COIN_FIELD =
  'M50.30 41.40A18.30 18.30 0 1 1 13.70 41.40A18.30 18.30 0 1 1 50.30 41.40Z';

/** Simplified mark: crown. */
export const MARK_SMALL_CROWN = 'M22.5 17.5L41.5 17.5L41.5 28.5Q32.0 33.6 22.5 28.5Z';

/** Simplified mark: board. */
export const MARK_SMALL_BOARD = 'M32.0 6.5L57.5 17.5L32.0 28.5L6.5 17.5Z';

/** Simplified mark: attachment knot x — on the board's right vertex. */
export const MARK_SMALL_ATTACH_KNOT_X = '57.5';

/** Simplified mark: attachment knot centre, y. */
export const MARK_SMALL_ATTACH_KNOT_CY = '17.5';

/** Simplified mark: attachment knot radius — scaled from the primary knot's ratio. */
export const MARK_SMALL_ATTACH_KNOT_R = '2.4';

/** Simplified mark: tassel strap. */
export const MARK_SMALL_TASSEL_STRAP = 'M56.0 19.0h3v6.0h-3Z';

/** Simplified mark: tassel bell. */
export const MARK_SMALL_TASSEL_BELL = 'M54.5 25h6l-1.1 8.6q-1.9 2.8-3.8 0Z';

/** Simplified mark: Naira glyph. */
export const MARK_SMALL_NAIRA =
  'M20.70 40.20 22.30 40.20 22.30 42.60 20.70 42.60 20.70 46.00 22.30 46.00 22.30 51.40 25.70 51.40 25.70 46.00 34.90 46.00 38.30 51.40 41.70 51.40 41.70 46.00 43.30 46.00 43.30 42.60 41.70 42.60 41.70 40.20 43.30 40.20 43.30 36.80 41.70 36.80 41.70 31.40 38.30 31.40 38.30 36.80 33.12 36.80 29.72 31.40 22.30 31.40 22.30 36.80 20.70 36.80ZM25.70 31.40 25.70 36.80 29.10 36.80ZM25.70 42.60 32.76 42.60 31.24 40.20 25.70 40.20ZM35.26 40.20 36.77 42.60 38.30 42.60 38.30 40.20Z';

/** Monochrome: coin disc with the Naira knocked out (evenodd). */
export const MARK_MONO_COIN =
  'M50.50 41.50A18.50 18.50 0 1 1 13.50 41.50A18.50 18.50 0 1 1 50.50 41.50Z M21.90 40.67 23.40 40.67 23.40 43.13 21.90 43.13 21.90 45.83 23.40 45.83 23.40 50.80 26.10 50.80 26.10 45.83 34.61 45.83 37.90 50.80 40.60 50.80 40.60 45.83 42.10 45.83 42.10 43.13 40.60 43.13 40.60 40.67 42.10 40.67 42.10 37.97 40.60 37.97 40.60 33.00 37.90 33.00 37.90 37.97 32.63 37.97 29.34 33.00 23.40 33.00 23.40 37.97 21.90 37.97ZM26.10 33.00 26.10 37.97 29.39 37.97ZM26.10 43.13 32.82 43.13 31.18 40.67 26.10 40.67ZM34.42 40.67 36.06 43.13 37.90 43.13 37.90 40.67ZM37.85 45.83 37.90 45.91 37.90 45.83Z';

/** Monochrome simplified: disc with the Naira knocked out. */
export const MARK_SMALL_MONO_COIN =
  'M52.50 41.40A20.50 20.50 0 1 1 11.50 41.40A20.50 20.50 0 1 1 52.50 41.40Z M20.70 40.20 22.30 40.20 22.30 42.60 20.70 42.60 20.70 46.00 22.30 46.00 22.30 51.40 25.70 51.40 25.70 46.00 34.90 46.00 38.30 51.40 41.70 51.40 41.70 46.00 43.30 46.00 43.30 42.60 41.70 42.60 41.70 40.20 43.30 40.20 43.30 36.80 41.70 36.80 41.70 31.40 38.30 31.40 38.30 36.80 33.12 36.80 29.72 31.40 22.30 31.40 22.30 36.80 20.70 36.80ZM25.70 31.40 25.70 36.80 29.10 36.80ZM25.70 42.60 32.76 42.60 31.24 40.20 25.70 40.20ZM35.26 40.20 36.77 42.60 38.30 42.60 38.30 40.20Z';

/** Mark grid size in user units. */
export const MARK_VIEWBOX = 64;

/** Button centre, y. */
export const MARK_BUTTON_CY = 18.5;

/** Button radius. */
export const MARK_BUTTON_R = 2.0;

/** Knot x, on the board's right edge. */
export const MARK_KNOT_X = 53.5;

/** Naira glyph width. */
export const MARK_NAIRA_W = 17.2;

/** Naira glyph height. */
export const MARK_NAIRA_H = 17.8;
