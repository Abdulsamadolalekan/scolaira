/**
 * SCOLAIRA M4 — Authorization permissions, roles, and policy matrix.
 *
 * The permission model is deliberately compact. Roles map to a fixed set of
 * Actions; adding a new action requires making an explicit policy decision
 * for every role. There is no permissive default: if an action is not in a
 * role's grant list, it is denied.
 *
 * The matrix is source code (not a database table) so changes are code-
 * reviewed and audited through git history. Per-organization custom roles
 * are deferred; if that feature is needed, it must preserve the principle
 * that every permission grant is explicit and reviewed.
 *
 * See docs/security/AUTHORIZATION_MATRIX.md for the human-readable matrix.
 */
import 'server-only';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type MembershipRole = 'OWNER' | 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF';

/**
 * Platform actions are NOT membership roles. They are cross-tenant capabilities
 * gated by enter_platform_context(). Regular tenant routes NEVER run with
 * platform powers because setTenantFor() resets is_platform_admin='0'.
 */
export type PlatformCapability =
  | 'platform.support.enter'     // enter read-only support mode for an org
  | 'platform.org.suspend'       // suspend an organization
  | 'platform.org.activate'      // reactivate a suspended organization
  | 'platform.audit.read';       // read cross-tenant audit

// ---------------------------------------------------------------------------
// Actions (scoped by tenant; checked AFTER tenant resolution)
// ---------------------------------------------------------------------------

export type Action =
  // Organization (settings, ownership)
  | 'org.settings.read'
  | 'org.settings.update'
  | 'org.delete'
  | 'org.owner.transfer'

  // Membership / staff
  | 'member.invite'
  | 'member.read'
  | 'member.update'          // name/contact/role changes
  | 'member.suspend'         // set status DISABLED
  | 'member.reactivate'
  | 'member.revoke'          // remove membership (cascade-safe)
  | 'member.change_role'     // specifically role changes, logged with before/after

  // Academic core (students/classes/sessions/terms)
  | 'student.create'
  | 'student.read'
  | 'student.update'
  | 'student.archive'
  | 'student.restore'
  | 'academic_session.manage'
  | 'term.manage'
  | 'term.bill'
  | 'term.read'
  | 'class.manage'
  | 'class.read'
  | 'roster.read'
  | 'enrollment.manage'
  | 'guardian.manage'

  // Financial configuration
  | 'fee_definition.manage'   // create/activate/archive
  | 'fee_assignment.manage'

  // Invoices
  | 'invoice.create'
  | 'invoice.read'
  | 'invoice.issue'
  | 'invoice.void'

  // Payments
  | 'payment.record'
  | 'payment.confirm'
  | 'payment.allocate'
  | 'payment.reverse'
  | 'payment.refund'

  // Receipts
  | 'receipt.issue'
  | 'receipt.read'
  | 'receipt.void'

  // Reversals (read only — created by payment.reverse/refund)
  | 'reversal.read'

  // Payment links
  | 'payment_link.create'
  | 'payment_link.read'
  | 'payment_link.revoke'

  // Reporting & exports
  | 'report.financial.read'
  | 'report.financial.export'

  // Command center (dashboard) — lightweight summary; safe for every role
  // because the KPIs are aggregated and surfaced through the same RLS boundary
  // as underlying invoice/payment/student reads.
  | 'dashboard.read'

  // Payments list read (list/detail of payments & allocations)
  | 'payment.read'

  // Audit
  | 'audit.read'

  // Communications
  | 'communication.send'

  // Accounts-receivable / debtors
  | 'debtor.read'         // view aging/debtor workbench and reminders
  | 'reminder.send'       // send/record a payment reminder

  // Reconciliation control plane
  | 'reconciliation.read'
  | 'reconciliation.review'
  | 'reconciliation.resolve';

// ---------------------------------------------------------------------------
// Policy matrix
// ---------------------------------------------------------------------------

/**
 * The authorization policy. Roles map to the set of actions they can perform.
 *
 * Design principles:
 *   - OWNER has full authority within their school, including ownership
 *     transfer and org deletion.
 *   - SCHOOL_ADMIN has everything except ownership transfer and org deletion.
 *   - FINANCE_OFFICER has all financial operations, financial reports/exports,
 *     payment link management, read access to students (required to attach
 *     invoices/payments), and fee_definition/assignment management. No staff
 *     management or org settings changes.
 *   - STAFF (M4 baseline) has dashboard self only — no student or financial
 *     access. Class-scoped read will be added in M5 when class-assignment data
 *     exists.
 *
 * Important: this matrix grants CATEGORICAL permission at the role level.
 * Resource-level checks (organization match, resource state, idempotency,
 * etc.) are enforced separately by the route handler and by the database.
 */
const POLICY: Record<MembershipRole, ReadonlySet<Action>> = {
  OWNER: new Set<Action>([
    'org.settings.read', 'org.settings.update', 'org.delete', 'org.owner.transfer',
    'member.invite', 'member.read', 'member.update', 'member.suspend', 'member.reactivate', 'member.revoke', 'member.change_role',
    'student.create', 'student.read', 'student.update', 'student.archive', 'student.restore',
    'academic_session.manage', 'term.manage', 'term.bill', 'term.read', 'class.manage', 'class.read', 'roster.read', 'enrollment.manage', 'guardian.manage',
    'fee_definition.manage', 'fee_assignment.manage',
    'invoice.create', 'invoice.read', 'invoice.issue', 'invoice.void',
    'payment.record', 'payment.confirm', 'payment.allocate', 'payment.reverse', 'payment.refund',
    'receipt.issue', 'receipt.read', 'receipt.void',
    'reversal.read',
    'payment_link.create', 'payment_link.read', 'payment_link.revoke',
    'report.financial.read', 'report.financial.export',
    'dashboard.read', 'payment.read',
    'audit.read',
    'communication.send',
    'debtor.read', 'reminder.send',
    'reconciliation.read', 'reconciliation.review', 'reconciliation.resolve',
  ]),
  SCHOOL_ADMIN: new Set<Action>([
    'org.settings.read', 'org.settings.update',
    'member.invite', 'member.read', 'member.update', 'member.suspend', 'member.reactivate', 'member.revoke', 'member.change_role',
    'student.create', 'student.read', 'student.update', 'student.archive', 'student.restore',
    'academic_session.manage', 'term.manage', 'term.read', 'class.manage', 'class.read', 'roster.read', 'enrollment.manage', 'guardian.manage',
    'fee_definition.manage', 'fee_assignment.manage',
    'invoice.create', 'invoice.read', 'invoice.issue', 'invoice.void',
    'payment.record', 'payment.confirm', 'payment.allocate', 'payment.reverse', 'payment.refund',
    'receipt.issue', 'receipt.read', 'receipt.void',
    'reversal.read',
    'payment_link.create', 'payment_link.read', 'payment_link.revoke',
    'report.financial.read', 'report.financial.export',
    'dashboard.read', 'payment.read',
    'audit.read',
    'communication.send',
    'debtor.read', 'reminder.send',
    'reconciliation.read', 'reconciliation.review', 'reconciliation.resolve',
  ]),
  FINANCE_OFFICER: new Set<Action>([
    'org.settings.read',
    'member.read', // must be able to see who performed financial actions
    'student.read', // required to attach invoices/payments to students
    'class.read',
    'roster.read',
    'term.bill',
    'term.read',
    'fee_definition.manage', 'fee_assignment.manage',
    'invoice.create', 'invoice.read', 'invoice.issue', 'invoice.void',
    'payment.record', 'payment.confirm', 'payment.allocate', 'payment.reverse', 'payment.refund',
    'payment.read',
    'receipt.issue', 'receipt.read', 'receipt.void',
    'reversal.read',
    'payment_link.create', 'payment_link.read', 'payment_link.revoke',
    'report.financial.read', 'report.financial.export',
    'dashboard.read',
    'communication.send',
    'debtor.read', 'reminder.send',
    'reconciliation.read', 'reconciliation.review', 'reconciliation.resolve',
    // FINANCE_OFFICER may NOT: manage staff, change org settings, archive/
    // restore students, manage academic sessions/terms/classes, read audit,
    // transfer ownership, delete the org.
  ]),
  STAFF: new Set<Action>([
    // M4 baseline STAFF: self-service only. Class-scoped student/class read
    // will be added in M5 when class-assignment data exists. They still land
    // on the command center, where empty/graceful permission states apply.
    'dashboard.read',
  ]),
};

// ---------------------------------------------------------------------------
// Platform capability policy
// ---------------------------------------------------------------------------

/**
 * Platform capabilities are narrow and explicit. A user with
 * is_platform_admin=true can invoke ONLY these actions, and ONLY while in
 * platform context (enter_platform_context GUC).
 *
 *   platform.support.enter    — read-only support mode inside an org. Grants
 *                               READ access to every tenant table (RLS-
 *                               mediated) but forbids mutations.
 *   platform.org.suspend      — mark organization status = SUSPENDED.
 *   platform.org.activate     — reactivate a suspended organization.
 *   platform.audit.read       — read audit events cross-tenant.
 *
 * There is deliberately no "platform.bypass" or "platform.everything" grant.
 */
const PLATFORM_POLICY: ReadonlySet<PlatformCapability> = new Set<PlatformCapability>([
  'platform.support.enter',
  'platform.org.suspend',
  'platform.org.activate',
  'platform.audit.read',
]);

/** Actions that platform support mode may invoke within a tenant. */
const PLATFORM_SUPPORT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  // Read-only across every resource in support mode.
  'org.settings.read',
  'member.read',
  'student.read',
  'class.read',
  'term.read',
  'invoice.read',
  'payment.read',
  'receipt.read',
  'reversal.read',
  'payment_link.read',
  'report.financial.read',
  'dashboard.read',
  'audit.read',
  // NO mutations in support mode.
]);

// ---------------------------------------------------------------------------
// Authorization check
// ---------------------------------------------------------------------------

export interface AuthzContext {
  readonly role: MembershipRole | null;
  readonly isPlatformSupport: boolean;  // true when in explicit platform support session
}

export interface AuthzResult {
  allowed: boolean;
  reason?: string;
}

export function authorize(ctx: AuthzContext, action: Action): AuthzResult {
  // Platform support mode has a narrow read-only grant list. It does NOT get
  // all actions even though is_platform_admin='1' makes RLS more permissive;
  // the application layer is the primary gate.
  if (ctx.isPlatformSupport) {
    if (PLATFORM_SUPPORT_ACTIONS.has(action)) return { allowed: true };
    return { allowed: false, reason: 'platform support mode cannot perform mutations' };
  }

  if (!ctx.role) return { allowed: false, reason: 'no active membership' };

  if (POLICY[ctx.role]?.has(action)) return { allowed: true };
  return { allowed: false, reason: `role ${ctx.role} cannot ${action}` };
}

export function canPlatform(userIsPlatformAdmin: boolean, cap: PlatformCapability): boolean {
  if (!userIsPlatformAdmin) return false;
  return PLATFORM_POLICY.has(cap);
}

/** Used by tests and UI to read the policy (read-only). */
export function getPolicySnapshot(): Record<MembershipRole, Action[]> {
  const out: Record<string, Action[]> = {};
  for (const role of Object.keys(POLICY) as MembershipRole[]) {
    out[role] = Array.from(POLICY[role]);
  }
  return out as Record<MembershipRole, Action[]>;
}
