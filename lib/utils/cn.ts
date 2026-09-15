import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind / CSS classes, resolving conflicts correctly.
 *
 * Components MUST use this for className composition so brand tokens and
 * override classes behave predictably.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
