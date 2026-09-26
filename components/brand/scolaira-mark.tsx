/**
 * SCOLAIRA brand mark — the production identity, as vector geometry.
 *
 * The visual mark is the approved naira-coin-and-graduation-cap symbol:
 * Deep Forest Green cap, Gold coin, White ₦. Nothing here is a raster asset,
 * an embedded image, or a traced screenshot — every shape is a reconstructed
 * vector path defined in `./scolaira-mark-paths`.
 *
 * Implementation notes
 *  - **No `<mask>` anywhere.** Knockouts are real merged paths resolved by
 *    `fill-rule="evenodd"`. Masks are ignored by some renderers (favicon
 *    generators, Android WebView, PDF export) and fail *silently* when they
 *    are — producing a solid coin with no ₦ that still looks like valid SVG.
 *  - **Fixed brand colours, not `currentColor`.** The mark carries two brand
 *    colours and cannot inherit a text colour without losing them. Values are
 *    the design-system brand primitives, inlined so an exported file or a
 *    server-rendered surface looks identical to the app.
 *  - **Wordmark is live text**, so it always matches the product's typography
 *    and stays crisp at any density. It uses `--font-sans` from the design
 *    system, not a rasterised or outlined wordmark.
 *
 * Geometry: 64x64 grid. The cap sits *on* the coin and its skirt passes behind
 * it, so the skirt reads as a crescent concentric with the coin — one
 * intentional intersection rather than two stacked illustrations.
 *
 * Size guidance
 *  - `ScolairaSymbol`  ≥ 40px
 *  - `ScolairaSymbolSmall` / `ScolairaIcon`  16–48px (simplified geometry: at
 *    16-32px the primary mark's rim closes up and the ₦ loses its counters)
 */
import type { SVGProps } from 'react';

import {
  MARK_BOARD,
  MARK_COIN_FIELD,
  MARK_COIN_RING,
  MARK_CORD,
  MARK_MONO_COIN,
  MARK_NAIRA,
  MARK_SKIRT,
  MARK_SMALL_BOARD,
  MARK_SMALL_COIN_FIELD,
  MARK_SMALL_COIN_RING,
  MARK_SMALL_MONO_COIN,
  MARK_SMALL_NAIRA,
  MARK_SMALL_SKIRT,
  MARK_SMALL_TASSEL_BELL,
  MARK_SMALL_TASSEL_STRAP,
  MARK_TASSEL,
} from './scolaira-mark-paths';

const FOREST = '#1B4332';
const GOLD = '#D4AF37';
const IVORY = '#FDFBF6';
const WHITE = '#FFFFFF';
const INK = '#17201C';

/** Vertical position of the tassel knot, in mark units. */
const KNOT_X = 53.5;
const KNOT_STRAP = `M${KNOT_X} 19.5L${KNOT_X} 24`;

export type MarkTone = 'brand' | 'onDark' | 'monoDark' | 'monoLight';

interface Palette {
  gold: string;
  cap: string;
  button: string;
  cord: string;
  naira: string;
}

function palette(tone: MarkTone): Palette {
  switch (tone) {
    case 'onDark':
      // For deep-green plates: ivory cap, gold coin preserved, white ₦.
      return { gold: GOLD, cap: IVORY, button: FOREST, cord: FOREST, naira: WHITE };
    case 'monoDark':
      return { gold: INK, cap: INK, button: INK, cord: INK, naira: INK };
    case 'monoLight':
      return { gold: IVORY, cap: IVORY, button: IVORY, cord: IVORY, naira: IVORY };
    case 'brand':
    default:
      return { gold: GOLD, cap: FOREST, button: IVORY, cord: IVORY, naira: WHITE };
  }
}

export interface ScolairaSymbolProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered square size in px. */
  size?: number;
  tone?: MarkTone;
  /**
   * Accessible name. Omit when a visible wordmark already names the brand, so
   * screen readers announce "SCOLAIRA" once rather than twice.
   */
  title?: string;
}

/** The primary symbol: deep-green cap, gold coin, white ₦ symbol. */
export function ScolairaSymbol({ size = 32, tone = 'brand', title, ...rest }: ScolairaSymbolProps) {
  const c = palette(tone);
  const mono = tone === 'monoDark' || tone === 'monoLight';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {/* Single colour uses the knockout coin: the ₦ is cut out of the disc by
          evenodd fill, so one path serves every plate without a mask. */}
      <path d={mono ? MARK_MONO_COIN : MARK_COIN_RING} fillRule="evenodd" fill={c.gold} />
      {mono ? null : <path d={MARK_COIN_FIELD} fill={c.gold} />}
      <path d={MARK_SKIRT} fill={c.cap} />
      <path d={MARK_BOARD} fill={c.cap} />
      {mono ? null : <circle cx={32} cy={18.5} r={2} fill={c.button} />}
      {mono ? null : (
        <path d={MARK_CORD} fill="none" stroke={c.cord} strokeWidth={1.3} strokeLinecap="round" />
      )}
      <path d={KNOT_STRAP} fill="none" stroke={c.cap} strokeWidth={1.9} strokeLinecap="round" />
      <path d={MARK_TASSEL} fill={c.cap} />
      {mono ? null : <path d={MARK_NAIRA} fill={c.naira} />}
    </svg>
  );
}

/**
 * Simplified symbol tuned for small sizes (16–48px) and used by the favicon.
 * Wider board, shorter skirt, heavier ₦ — at those sizes only the silhouette
 * and the ₦ actually survive.
 */
export function ScolairaSymbolSmall({
  size = 20,
  tone = 'brand',
  title,
  ...rest
}: ScolairaSymbolProps) {
  const c = palette(tone);
  const mono = tone === 'monoDark' || tone === 'monoLight';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path
        d={mono ? MARK_SMALL_MONO_COIN : MARK_SMALL_COIN_RING}
        fillRule="evenodd"
        fill={c.gold}
      />
      {mono ? null : <path d={MARK_SMALL_COIN_FIELD} fill={c.gold} />}
      <path d={MARK_SMALL_SKIRT} fill={c.cap} />
      <path d={MARK_SMALL_BOARD} fill={c.cap} />
      <path d={MARK_SMALL_TASSEL_STRAP} fill={c.cap} />
      <path d={MARK_SMALL_TASSEL_BELL} fill={c.cap} />
      {mono ? null : <path d={MARK_SMALL_NAIRA} fill={c.naira} />}
    </svg>
  );
}

/**
 * Favicon / app-icon build: the simplified symbol on a deep-green plate.
 *
 * A plate is used deliberately — the brand mark is white-and-gold on a dark
 * green cap, so on a browser's dark tab bar a transparent mark loses its cap
 * entirely. The plate guarantees contrast on any chrome.
 */
export function ScolairaIcon({ size = 32, title, ...rest }: ScolairaSymbolProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <rect width={64} height={64} rx={14} fill={FOREST} />
      <path d={MARK_SMALL_COIN_RING} fillRule="evenodd" fill={GOLD} />
      <path d={MARK_SMALL_COIN_FIELD} fill={GOLD} />
      <path d={MARK_SMALL_SKIRT} fill={IVORY} />
      <path d={MARK_SMALL_BOARD} fill={IVORY} />
      <path d={MARK_SMALL_TASSEL_STRAP} fill={IVORY} />
      <path d={MARK_SMALL_TASSEL_BELL} fill={IVORY} />
      <path d={MARK_SMALL_NAIRA} fill={WHITE} />
    </svg>
  );
}

export interface ScolairaLockupProps {
  /** Symbol size in px; the wordmark scales from it. */
  size?: number;
  tone?: MarkTone;
  /** Tailwind classes deciding where the wordmark disappears. */
  wordmarkClassName?: string;
  /** Show the supporting tagline. Never used in the small or icon builds. */
  tagline?: boolean;
  /** Accessible name for the symbol when the wordmark is not rendered. */
  title?: string;
}

/**
 * Horizontal lockup: symbol + wordmark.
 *
 * Responsive hierarchy:
 *   desktop      symbol + SCOLAIRA
 *   mobile       symbol + SCOLAIRA where space permits
 *   very small   symbol only
 *
 * The wordmark is hidden with CSS (`hidden sm:inline-flex`) rather than by
 * measuring the viewport, so it is correct during SSR with no layout shift and
 * no client-side media-query fork.
 */
export function ScolairaLockup({
  size = 26,
  tone = 'brand',
  wordmarkClassName = 'hidden sm:inline-flex',
  tagline = false,
  title,
}: ScolairaLockupProps) {
  const word = tone === 'onDark' || tone === 'monoLight' ? IVORY : FOREST;
  return (
    <span className="inline-flex items-center gap-2.5">
      <ScolairaSymbol size={size} tone={tone} title={title} />
      <span
        className={`min-w-0 flex-col leading-tight ${tagline ? 'inline-flex' : wordmarkClassName}`}
      >
        <span
          className="font-semibold tracking-[0.18em]"
          style={{
            color: word,
            fontFamily: 'var(--font-sans)',
            fontSize: Math.round(size * 0.66),
          }}
        >
          SCOLAIRA
        </span>
        {tagline ? (
          <span
            className="uppercase tracking-[0.18em]"
            style={{
              color: word,
              fontFamily: 'var(--font-sans)',
              fontSize: Math.max(9, Math.round(size * 0.32)),
              opacity: 0.72,
            }}
          >
            The financial operating system for Nigerian private schools
          </span>
        ) : null}
      </span>
    </span>
  );
}
