// @vitest-environment node
/** M11 authorization contract: tenant case actions are explicit and least privilege. */
import { describe, expect, it } from 'vitest';
import { authorize } from '@/lib/authz/permissions';

describe('M11 collections authorization policy', () => {
  it('grants the bounded workbench to operational roles only', () => {
    for (const role of ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'] as const) {
      expect(authorize({ role, isPlatformSupport: false }, 'collections.read').allowed).toBe(true);
      expect(authorize({ role, isPlatformSupport: false }, 'collections.create').allowed).toBe(
        true,
      );
      expect(authorize({ role, isPlatformSupport: false }, 'collections.assign').allowed).toBe(
        true,
      );
      expect(authorize({ role, isPlatformSupport: false }, 'collections.note').allowed).toBe(true);
      expect(authorize({ role, isPlatformSupport: false }, 'collections.transition').allowed).toBe(
        true,
      );
    }
    expect(authorize({ role: 'STAFF', isPlatformSupport: false }, 'collections.read').allowed).toBe(
      false,
    );
    expect(authorize({ role: null, isPlatformSupport: false }, 'collections.create').allowed).toBe(
      false,
    );
  });

  it('allows platform support to read but not mutate in explicit platform context', () => {
    expect(authorize({ role: null, isPlatformSupport: true }, 'collections.read').allowed).toBe(
      true,
    );
    expect(authorize({ role: null, isPlatformSupport: true }, 'collections.create').allowed).toBe(
      false,
    );
    expect(authorize({ role: null, isPlatformSupport: true }, 'collections.assign').allowed).toBe(
      false,
    );
    expect(
      authorize({ role: null, isPlatformSupport: true }, 'collections.transition').allowed,
    ).toBe(false);
  });
});
