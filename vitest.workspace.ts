import { defineWorkspace } from 'vitest/config';
import path from 'node:path';

/**
 * Two-project workspace for SCOLAIRA tests.
 *
 *   'unit'        — jsdom, for React + pure-TS tests. No DB access; must not
 *                   import `server-only` (the real `server-only` module throws
 *                   unconditionally, so accidental DB imports fail fast here).
 *   'integration' — node, real Postgres. The `server-only` package is stubbed
 *                   to a no-op because those tests run in a genuine server
 *                   (node) environment, exactly what the guard is meant to
 *                   enforce.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.mts',
    test: {
      name: 'unit',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup-unit.ts'],
      // `app/**` is included so a client component can carry its own test
      // beside it (the router ignores non-route filenames such as
      // `*.test.tsx`). H-5's rotate control is the first such test.
      include: ['lib/**/*.test.{ts,tsx}', 'components/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
      exclude: ['tests/db/**', 'node_modules', '.next'],
    },
  },
  {
    extends: './vitest.config.mts',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        'server-only': path.resolve(__dirname, 'tests/support/server-only-stub.js'),
      },
    },
    test: {
      name: 'integration',
      environment: 'node',
      globals: true,
      globalSetup: ['./tests/global-setup-db.ts'],
      setupFiles: ['./tests/setup-db.ts'],
      include: ['tests/db/**/*.test.{ts,tsx}', 'tests/auth/**/*.test.{ts,tsx}'],
      exclude: ['node_modules', '.next'],
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
