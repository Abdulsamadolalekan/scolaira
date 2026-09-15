import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest configuration for SCOLAIRA.
 *
 * Unit/integration tests run in jsdom to simulate browser DOM for React components.
 * Tests that require a real Postgres database will live under tests/integration and
 * set up their own ephemeral database (added when M2 database lands).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e', 'test-results', 'playwright-report'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/*.test.{ts,tsx}', '**/node_modules/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
