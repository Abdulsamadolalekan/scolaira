/**
 * Audit logger stub (M0).
 *
 * Real audit_events table insertion is introduced with M2/Database + M4/Auth.
 * For M0 we expose a no-op logger that satisfies type and lays down the
 * shape future implementations will fill.
 *
 * Every service file that performs mutations will import from this module
 * rather than using console.log directly for audit-relevant events.
 */

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
}

type AuditLogger = {
  record(event: AuditEventInput): Promise<void>;
};

/**
 * Default M0 logger writes to stdout in development and is a no-op in tests.
 * Replaced in M2 with a real DB-writing logger.
 */
const consoleLogger: AuditLogger = {
  async record(event: AuditEventInput) {
    if (process.env.NODE_ENV === 'test') return;
    // eslint-disable-next-line no-console
    console.info('[audit]', event);
  },
};

let current: AuditLogger = consoleLogger;

export function setAuditLogger(logger: AuditLogger): void {
  current = logger;
}

export async function audit(event: AuditEventInput): Promise<void> {
  await current.record(event);
}
