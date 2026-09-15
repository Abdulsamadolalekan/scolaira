/**
 * Server-side environment-variable access.
 *
 * Financial/sensitive variables are accessed exclusively through this module so
 * accidental imports into client components fail loudly at build time.
 *
 * M0 exposes only infrastructure variables that exist from day one.
 * M2+ will add DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.
 */
import 'server-only';

/**
 * Read a required server-side environment variable.
 * Throws at startup if missing so misconfigurations fail loudly rather than
 * silently operating with undefined values.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Required server environment variable ${name} is not set. Check .env.local.`);
  }
  return v;
}

/** Read an optional server-side environment variable. */
function optional(name: string): string | undefined {
  return process.env[name];
}

export const serverEnv = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appUrl: optional('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',
  payUrl: optional('NEXT_PUBLIC_PAY_URL') ?? 'http://localhost:3000',
  sessionSecret: optional('SCOLAIRA_SESSION_SECRET'),
  db: {
    url: optional('DATABASE_URL'),
    migrationUrl: optional('DATABASE_MIGRATION_URL'),
  },
  supabase: {
    url: optional('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: optional('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
  },
  paystack: {
    publicKey: optional('NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY'),
    secretKey: optional('PAYSTACK_SECRET_KEY'),
    webhookSecret: optional('PAYSTACK_WEBHOOK_SECRET'),
  },
  resend: {
    apiKey: optional('RESEND_API_KEY'),
    fromAddress: optional('FROM_EMAIL_ADDRESS'),
  },
  sentry: {
    dsn: optional('SENTRY_DSN'),
  },
} as const;

/**
 * Throws if required variables for the current environment are missing.
 * Invoked during server startup (e.g. instrumentation.ts) in later milestones.
 * Provided as a function for M0 so callers can opt-in; full validation runs at M2.
 */
export function assertEnvReady(_requiredKeys: (keyof typeof serverEnv)[] = []): void {
  // M0 does not yet require DATABASE_URL etc. Real assertions added in later milestones.
  for (const k of _requiredKeys) {
    const v = (serverEnv as unknown as Record<string, unknown>)[k];
    if (v === undefined || v === '') {
      throw new Error(`Required server env var not ready: ${String(k)}`);
    }
  }
}

// Mark file as server-only by accessing 'server-only' at top level.
export { required, optional };
