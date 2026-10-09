import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Merge Tailwind / CSS classes, resolving conflicts correctly.
 *
 * Components MUST use this for className composition so brand tokens and
 * override classes behave predictably.
 *
 * WHY THIS FILE EXTENDS TAILWIND-MERGE
 *   The design system added a display scale (`text-display-*`) and a financial
 *   figure scale (`text-figure*`) on top of Tailwind's defaults. tailwind-merge
 *   cannot know about classes it has never seen: it applies an ambiguous-value
 *   heuristic to `text-*` and assumed these were TEXT COLOURS. The visible
 *   consequence, measured on the redesigned Command Center: the page title
 *   rendered at the base `h1` size instead of its display size, because
 *   `cn('text-display-md', 'text-forest-deepest')` silently deleted the size
 *   class as a "losing colour".
 *
 *   Declaring them explicitly as font-size classes makes the two coexist and
 *   keeps size-vs-size overrides (e.g. a component passing its own display
 *   size) working as intended.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display-sm',
            'display-md',
            'display-lg',
            'display-xl',
            'figure',
            'figure-lg',
            'figure-xl',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
