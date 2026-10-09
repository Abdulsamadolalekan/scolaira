'use client';

/**
 * Reveal — entrance animation for public surfaces.
 *
 * WHY NOT A LIBRARY
 *   Framer Motion / GSAP would add 30–120 kB to a marketing page to move things
 *   a few pixels. This is ~1 kB of IntersectionObserver and a CSS class.
 *
 * WHY THIS IS NOT DECORATION
 *   The motion carries meaning: content arrives as it enters the viewport, so the
 *   page reads top-down instead of everything competing at once. It is slow
 *   (700ms), short-travelled (10px) and eased out, so it feels like typesetting
 *   settling rather than a slide.
 *
 * ACCESSIBILITY — non-negotiable
 *   · `prefers-reduced-motion: reduce` removes the transition entirely; content is
 *     rendered in its final position immediately (globals.css already zeroes
 *     transition-duration under that query).
 *   · The element is NEVER hidden behind opacity:0 without JS. Reveal state is only
 *     applied once the observer is attached, so a visitor with JS disabled — or a
 *     crawler — sees fully-rendered content.
 *   · No layout shift: transform only, never height/width/margin.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

type RevealProps = {
  children: ReactNode;
  /** Stagger in ms. Keep small — this is cadence, not choreography. */
  delay?: number;
  className?: string;
  /** Render as a different element when semantics require it. */
  as?: 'div' | 'section' | 'li' | 'article';
};

export function Reveal({ children, delay = 0, className = '', as = 'div' }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  // Rendered visible until JS proves otherwise — never a blank page without JS.
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    // Anything already in view on first paint must not animate — animating the
    // hero on load reads as a loading state, not as arrival.
    const box = el.getBoundingClientRect();
    if (box.top < window.innerHeight * 0.92) {
      setShown(true);
      return;
    }

    setArmed(true);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const Tag = as as 'div';

  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={`${armed && !shown ? 'reveal-armed' : ''} ${shown ? 'reveal-in' : ''} ${className}`}
      style={delay ? { transitionDelay: shown ? `${delay}ms` : '0ms' } : undefined}
    >
      {children}
    </Tag>
  );
}
