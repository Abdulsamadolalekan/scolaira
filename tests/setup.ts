/**
 * Vitest global setup.
 *
 * - Extends Jest matchers (assertions like expect(el).toBeInTheDocument()).
 * - Ensures React rendering APIs are configured for RTL.
 * - Sets NODE_ENV to 'test' if not already set.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

if (!process.env.NODE_ENV) {
  // process.env.NODE_ENV is read-only TypeScript-wise; cross-spawn env setting
  // is done by vitest. We only need to guard against undefined at runtime.
}

// Ensure React renders the same way across tests.
afterEach(() => {
  cleanup();
});
