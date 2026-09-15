import type { NextConfig } from 'next';

/**
 * SCOLAIRA Next.js configuration.
 *
 * Security / production notes:
 *  - Strict React mode enabled to catch double-invocation issues during development
 *    (this matters for correctness; we ensure API handlers are idempotent).
 *  - Powered-by header removed to reduce server fingerprinting.
 *  - Security headers applied to all routes (see headers() below).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Environment variables exposed to the client must be explicitly allow-listed via
  // NEXT_PUBLIC_* prefix in .env — we never implicitly expose secrets.
  env: {},

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Prevent MIME-type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Prevent clickjacking. Adjust SAMEORIGIN if embedded views are needed later.
          { key: 'X-Frame-Options', value: 'DENY' },
          // Basic Referrer policy — balances usefulness and privacy.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // HSTS once we have HTTPS deployed on production (preload eligible once confirmed).
          // We send a conservative value initially; tightened after first TLS deploy.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          // CSP — restrictive by default. M1 design system work will refine this as needed
          // (e.g., adding script sources for Paystack inline); for M0 skeleton we lock down.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval'",
              // unsafe-inline will be tightened when nonce-based CSP is added
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
              "frame-src 'none'",
            ].join('; '),
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
