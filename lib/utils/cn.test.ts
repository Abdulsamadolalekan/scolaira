import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn (className merger)', () => {
  it('merges class strings', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('resolves tailwind conflicts (latter wins for same utility)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('handles conditional classes', () => {
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c');
  });
});
