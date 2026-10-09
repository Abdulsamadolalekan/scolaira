/**
 * SCOLAIRA brand marks.
 *
 * Three rules govern this file, and they exist so the identity behaves like a system
 * rather than like eight drawings that happen to share a palette:
 *
 *   1. GEOMETRY IS GENERATED. Every path comes from `scolaira-mark-paths.ts`, which is
 *      emitted from the same source that produces the production SVGs. Nothing here is
 *      hand-drawn, so the component and the master art cannot drift.
 *
 *   2. THE WORDMARK HAS ONE SOURCE. `ScolairaWordmark` is the only place "SCOLAIRA" is
 *      set in type. The app shell previously built its own wordmark with its own size
 *      and tracking, which is how a brand quietly forks.
 *
 *   3. RATIOS ARE DERIVED, NOT CHOSEN. Metrics come from the typeface's own
 *      measurements, so changing the display size cannot break the relationship between
 *      symbol and wordmark:
 *
 *          Archivo cap height        0.686 em
 *          symbol height             1.45 × cap height   (from the master lockups)
 *          => font size               = symbol size        (verified: 28 → 28.1px)
 *          => cap height              ≈ 0.69 × symbol size
 *          => symbol/wordmark gap     = 0.43 × symbol size
 *
 *      Those two derived numbers are the whole layout. There is no eyeballed spacing.
 *
 *   4. THE DESCRIPTOR IS SUPPORTING. It is opt-in, never rendered at small sizes, and
 *      never competes with the wordmark for weight.
 */
import type { SVGProps } from 'react';

import {
  MARK_ATTACH_KNOT_CY,
  MARK_ATTACH_KNOT_R,
  MARK_BOARD,
  MARK_BUTTON_CY,
  MARK_BUTTON_R,
  MARK_COIN_FIELD,
  MARK_COIN_RING,
  MARK_CORD,
  MARK_CROWN,
  MARK_KNOT_STEM,
  MARK_KNOT_X,
  MARK_MONO_COIN,
  MARK_NAIRA,
  MARK_SMALL_BOARD,
  MARK_SMALL_COIN_FIELD,
  MARK_SMALL_COIN_RING,
  MARK_SMALL_CROWN,
  MARK_SMALL_MONO_COIN,
  MARK_SMALL_NAIRA,
  MARK_SMALL_ATTACH_KNOT_CY,
  MARK_SMALL_ATTACH_KNOT_R,
  MARK_SMALL_ATTACH_KNOT_X,
  MARK_SMALL_TASSEL_BELL,
  MARK_SMALL_TASSEL_STRAP,
  MARK_TASSEL,
  MARK_VIEWBOX,
} from './scolaira-mark-paths';

/* ——— Palette ————————————————————————————————————————————————————————————
 * The four approved brand values. Components must never invent a colour, and must
 * never hard-code one inline: these are the only literals in the brand surface.
 */
const FOREST = '#1B4332';
const DEEPEST = '#0B3D2E';
const GOLD = '#D4AF37';
const IVORY = '#FDFBF6';
const WHITE = '#FFFFFF';
const INK = '#111814';

export type MarkTone = 'brand' | 'onDark' | 'monoDark' | 'monoLight';

interface Palette {
  coin: string;
  cap: string;
  button: string;
  cord: string;
  naira: string;
  word: string;
  descriptor: string;
}

function palette(tone: MarkTone): Palette {
  switch (tone) {
    case 'onDark':
      return {
        coin: GOLD,
        cap: IVORY,
        button: DEEPEST,
        cord: DEEPEST,
        naira: WHITE,
        word: IVORY,
        descriptor: '#BFD3C7',
      };
    case 'monoDark':
      return {
        coin: INK,
        cap: INK,
        button: WHITE,
        cord: WHITE,
        naira: WHITE,
        word: INK,
        descriptor: INK,
      };
    case 'monoLight':
      return {
        coin: IVORY,
        cap: IVORY,
        button: FOREST,
        cord: FOREST,
        naira: FOREST,
        word: IVORY,
        descriptor: IVORY,
      };
    case 'brand':
    default:
      return {
        coin: GOLD,
        cap: FOREST,
        button: IVORY,
        cord: IVORY,
        naira: WHITE,
        word: FOREST,
        descriptor: '#5C6B64',
      };
  }
}

/* ——— Derived lockup metrics ————————————————————————————————————————————
 * Cap height of the wordmark, as a fraction of the symbol's height. Derived from the
 * master SVGs (cap 1.0 : symbol 1.45) and the typeface's 0.686 em cap height, so the
 * React lockup and the static SVG lockups are the same drawing.
 */
const CAP_TO_SYMBOL = 1 / 1.45;
const ARCHIVO_CAP_EM = 0.686;
const WORD_FONT_FROM_SYMBOL = CAP_TO_SYMBOL / ARCHIVO_CAP_EM; // ≈ 1.005
const GAP_FROM_SYMBOL = 0.43;
const DESCRIPTOR_FONT_FROM_WORD = 0.24;

/**
 * The size, in px, below which the lockup renders the simplified mark.
 *
 * Explicit and deterministic on purpose: `size < SMALL_MARK_BELOW` uses
 * `ScolairaSymbolSmall`, `size >= SMALL_MARK_BELOW` uses `ScolairaSymbol`. There is no
 * heuristic, no media query and no per-call-site override — one number, one comparison,
 * so the same size always yields the same drawing.
 *
 * 32 is the measured crossover, not an inherited convention. Rendered side by side at
 * every size from 20 to 40 px, the primary mark's coin channel and ₦ stay legible from
 * 32 px up and read as an antialiased blend below it; the simplified mark reads clean at
 * 24–30 px. It matters here because the product renders this lockup at 24 px (platform
 * header) and 26 px (app shell) — both below the line — and at 34 px (auth), above it.
 */
const SMALL_MARK_BELOW = 32;
const WORD_TRACKING = '0.02em';
const DESCRIPTOR_TRACKING = '0.13em';

export interface ScolairaSymbolProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered square size in px. */
  size?: number;
  tone?: MarkTone;
  /**
   * Accessible name. Omit when a visible wordmark already names the brand, so screen
   * readers announce "SCOLAIRA" once rather than twice.
   */
  title?: string;
}

/** The primary symbol: deep-green cap, gold coin, white ₦. */
export function ScolairaSymbol({ size = 32, tone = 'brand', title, ...rest }: ScolairaSymbolProps) {
  const c = palette(tone);
  const mono = tone === 'monoDark' || tone === 'monoLight';
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {mono ? (
        <path d={MARK_MONO_COIN} fillRule="evenodd" fill={c.cap} />
      ) : (
        <>
          <path d={MARK_COIN_RING} fillRule="evenodd" fill={c.coin} />
          <path d={MARK_COIN_FIELD} fill={c.coin} />
        </>
      )}
      <path d={MARK_CROWN} fill={c.cap} />
      <path d={MARK_BOARD} fill={c.cap} />
      {mono ? null : (
        <>
          <circle cx={32} cy={MARK_BUTTON_CY} r={MARK_BUTTON_R} fill={c.button} />
          <path d={MARK_CORD} fill="none" stroke={c.cord} strokeWidth={1.3} strokeLinecap="round" />
        </>
      )}
      {/* Tassel attachment. The knot is centred on the board's right vertex and drawn
          ON TOP of the cord, so it supplies the mass that sharp vertex lacked and buries
          the cord's terminus — which otherwise ran an ivory line straight into the join
          and visually cut the tassel off from the cap. Its radius is the cap button's
          radius, so the mark's two pieces of fastening hardware are the same size. */}
      <circle cx={MARK_KNOT_X} cy={MARK_ATTACH_KNOT_CY} r={MARK_ATTACH_KNOT_R} fill={c.cap} />
      <path d={MARK_KNOT_STEM} fill="none" stroke={c.cap} strokeWidth={1.9} strokeLinecap="round" />
      <path d={MARK_TASSEL} fill={c.cap} />
      {mono ? null : <path d={MARK_NAIRA} fill={c.naira} />}
    </svg>
  );
}

/**
 * Simplified symbol for the smallest sizes.
 *
 * Not a scaled-down copy of the primary mark: the coin is larger relative to the cap,
 * the tassel is a strap rather than a corded knot, and the ₦ is drawn on a proportionally
 * heavier stem. A 64-unit drawing reduced to 16px keeps its mass; this one is designed to
 * hold it.
 */
export function ScolairaSymbolSmall({
  size = 24,
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
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {mono ? (
        <path d={MARK_SMALL_MONO_COIN} fillRule="evenodd" fill={c.cap} />
      ) : (
        <>
          <path d={MARK_SMALL_COIN_RING} fillRule="evenodd" fill={c.coin} />
          <path d={MARK_SMALL_COIN_FIELD} fill={c.coin} />
        </>
      )}
      <path d={MARK_SMALL_CROWN} fill={c.cap} />
      <path d={MARK_SMALL_BOARD} fill={c.cap} />
      <circle
        cx={MARK_SMALL_ATTACH_KNOT_X}
        cy={MARK_SMALL_ATTACH_KNOT_CY}
        r={MARK_SMALL_ATTACH_KNOT_R}
        fill={c.cap}
      />
      <path d={MARK_SMALL_TASSEL_STRAP} fill={c.cap} />
      <path d={MARK_SMALL_TASSEL_BELL} fill={c.cap} />
      {mono ? null : <path d={MARK_SMALL_NAIRA} fill={c.naira} />}
    </svg>
  );
}

/**
 * App icon / favicon: the simplified symbol on a rounded institutional plate.
 *
 * Used for the home screen and the browser tab, where the plate gives the mark a
 * consistent silhouette against arbitrary browser chrome and OS wallpaper.
 */
export function ScolairaIcon({ size = 32, title, ...rest }: ScolairaSymbolProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <rect width={64} height={64} rx={14.2} fill={DEEPEST} />
      <g transform="translate(32 32) scale(0.84) translate(-32 -34.2)">
        <path d={MARK_SMALL_COIN_RING} fillRule="evenodd" fill={GOLD} />
        <path d={MARK_SMALL_COIN_FIELD} fill={GOLD} />
        <path d={MARK_SMALL_CROWN} fill={IVORY} />
        <path d={MARK_SMALL_BOARD} fill={IVORY} />
        <circle
          cx={MARK_SMALL_ATTACH_KNOT_X}
          cy={MARK_SMALL_ATTACH_KNOT_CY}
          r={MARK_SMALL_ATTACH_KNOT_R}
          fill={IVORY}
        />
        <path d={MARK_SMALL_TASSEL_STRAP} fill={IVORY} />
        <path d={MARK_SMALL_TASSEL_BELL} fill={IVORY} />
        <path d={MARK_SMALL_NAIRA} fill={WHITE} />
      </g>
    </svg>
  );
}

export interface ScolairaWordmarkProps {
  /** Symbol size in px. The wordmark's type size is derived from it. */
  size?: number;
  tone?: MarkTone;
  className?: string;
}

/**
 * The wordmark, set in the brand typeface.
 *
 * Live text, not outlines: it stays selectable, searchable and crisp at every zoom, and
 * it picks up the same `--font-wordmark` the rest of the product uses. Weight 500 and
 * 0.02em tracking come from the typography study; Archivo's flat A apex and straight R
 * leg already carry the institutional character, so no letter has been redrawn.
 */
export function ScolairaWordmark({ size = 28, tone = 'brand', className }: ScolairaWordmarkProps) {
  const c = palette(tone);
  return (
    <span
      className={className}
      style={{
        color: c.word,
        fontFamily: 'var(--font-wordmark)',
        fontWeight: 500,
        fontSize: size * WORD_FONT_FROM_SYMBOL,
        letterSpacing: WORD_TRACKING,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      SCOLAIRA
    </span>
  );
}

export interface ScolairaLockupProps {
  /** Symbol size in px; the wordmark, spacing and descriptor all derive from it. */
  size?: number;
  tone?: MarkTone;
  /** Tailwind classes deciding where the lockup's text block disappears. */
  wordmarkClassName?: string;
  /**
   * Supporting line beneath the wordmark. There is exactly one supporting slot, because
   * a brand that has both a descriptor and a tagline in different places ends up with
   * neither. This is the DESCRIPTOR slot: what SCOLAIRA is, and for whom. Short form in
   * product chrome ("School finance"), long form in marketing (`withDescriptor`).
   *
   * VOCABULARY. "Every term, fully funded." is the brand PROMISE — a different piece of
   * brand language, deliberately not rendered here. A descriptor names the category; a
   * promise makes a claim. Swapping one into this slot is not a substitution, it is a
   * different composition, and that decision is still open.
   */
  descriptor?: string;
  /** Use the long-form category descriptor as the supporting line. */
  withDescriptor?: boolean;
  /** Where the descriptor itself disappears (e.g. when the rail is narrow). */
  descriptorClassName?: string;
  title?: string;
}

/** The category descriptor: what SCOLAIRA is, for whom. Supporting, never primary. */
export const SCOLAIRA_DESCRIPTOR = 'THE FINANCIAL OPERATING SYSTEM FOR NIGERIAN PRIVATE SCHOOLS';

/**
 * Horizontal lockup: symbol + wordmark (+ optional supporting line).
 *
 * Responsive hierarchy — one component, four behaviours:
 *   large         symbol + wordmark + descriptor
 *   product       symbol + wordmark + short descriptor
 *   constrained   symbol + wordmark (`wordmarkClassName` hides the text block)
 *   favicon/icon  simplified symbol only (`ScolairaIcon`)
 *
 * SMALL-SIZE MARK. Below `SMALL_MARK_BELOW` px the lockup renders the approved
 * simplified mark instead of the primary one. The primary mark's construction — the
 * coin's rim/field channel, the ₦ counter, the cord hairline — needs roughly 32 px
 * before those features read as distinct rather than as an antialiased blend; at 24–26 px
 * (where the product actually uses this lockup) the coin collapses into a gold mass and
 * the denomination device goes soft. The simplified mark was drawn for exactly that
 * range: larger coin, heavier ₦ stem, strap rather than corded knot. This is a wiring
 * decision only — neither drawing is altered.
 */
export function ScolairaLockup({
  size = 28,
  tone = 'brand',
  wordmarkClassName = 'inline-flex',
  descriptor,
  withDescriptor = false,
  descriptorClassName,
  title,
}: ScolairaLockupProps) {
  const c = palette(tone);
  const text = descriptor ?? (withDescriptor ? SCOLAIRA_DESCRIPTOR : undefined);
  const wordSize = size * WORD_FONT_FROM_SYMBOL;
  const Mark = size < SMALL_MARK_BELOW ? ScolairaSymbolSmall : ScolairaSymbol;
  return (
    <span className="inline-flex items-center" style={{ gap: size * GAP_FROM_SYMBOL }}>
      {/* `shrink-0`: the mark's *rendered* size is what selects the geometry above, so it
          must never be flex-shrunk below the `size` it was given. Without this the mark is
          a default `flex-shrink: 1` item and a tight row quietly renders it smaller than
          the size the threshold just evaluated. */}
      <Mark size={size} tone={tone} title={title} className="shrink-0" />
      {/* `text-left`, not inherited alignment. This block is as wide as its WIDEST child
          — the descriptor — so under an ancestor's `text-center` (the auth page wraps the
          lockup in `text-center`) the shorter wordmark gets centred inside that wider box
          and is visibly orphaned from the mark. The master artwork left-aligns both lines
          flush, so the block must not inherit alignment from whatever contains it. */}
      <span className={`min-w-0 flex-col text-left leading-none ${wordmarkClassName}`}>
        <ScolairaWordmark size={size} tone={tone} />
        {text ? (
          <span
            className={`mt-[0.42em] uppercase ${descriptorClassName ?? ''}`}
            style={{
              color: c.descriptor,
              fontFamily: 'var(--font-wordmark)',
              fontWeight: 400,
              fontSize: wordSize * DESCRIPTOR_FONT_FROM_WORD,
              letterSpacing: DESCRIPTOR_TRACKING,
              lineHeight: 1.2,
            }}
          >
            {text}
          </span>
        ) : null}
      </span>
    </span>
  );
}
