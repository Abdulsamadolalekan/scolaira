/**
 * Postgres enum types used across the schema.
 *
 * Naming: snake_case values match the approved state machines
 * (docs/state-machines/*) exactly.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// --- Identity / roles ---

export const orgStatusEnum = pgEnum('org_status', ['ACTIVE', 'SUSPENDED', 'CHURNED']);

// Membership roles within a school organization.
//
// OWNER  — immutable organizational anchor (exactly one ACTIVE per org,
//          enforced by partial unique index org_members_one_active_owner_idx).
// SCHOOL_ADMIN — day-to-day school administrator.
// FINANCE_OFFICER — financial operations per the M4 authorization matrix.
// STAFF  — teachers / non-finance staff (scoped reads; no financial access).
//
// NOTE: PLATFORM_ADMIN is intentionally NOT a membership role. Platform-wide
// authority is tracked separately via users.is_platform_admin and scoped
// GUCs set by enter_platform_context(); never insert rows with role
// PLATFORM_ADMIN into organization_members (blocked by CHECK constraint).
export const membershipRoleEnum = pgEnum('membership_role', [
  'OWNER',
  'SCHOOL_ADMIN',
  'FINANCE_OFFICER',
  'STAFF',
]);

export const membershipStatusEnum = pgEnum('membership_status', ['ACTIVE', 'INVITED', 'DISABLED']);

// --- Academic lifecycle ---

export const sessionStatusEnum = pgEnum('session_status', ['PLANNED', 'ACTIVE', 'CLOSED']);

export const termStatusEnum = pgEnum('term_status', ['PLANNED', 'ACTIVE', 'BILLED', 'CLOSED']);

export const studentStatusEnum = pgEnum('student_status', [
  'ACTIVE',
  'ARCHIVED',
  'GRADUATED',
  'WITHDRAWN',
]);

// --- Billing ---

export const feeAssignmentStatusEnum = pgEnum('fee_assignment_status', [
  'DRAFT',
  'ACTIVE',
  'ARCHIVED',
]);

export const waiverReasonEnum = pgEnum('waiver_reason', [
  'SCHOLARSHIP',
  'SIBLING_DISCOUNT',
  'STAFF_CHILD',
  'EARLY_PAYMENT',
  'OTHER',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'VOID',
]);

// --- Payments ---

export const paymentMethodEnum = pgEnum('payment_method', [
  'CASH',
  'BANK_TRANSFER',
  'POS',
  'ONLINE',
  'OTHER',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'PENDING',
  'CONFIRMED',
  'DUPLICATE_SUSPECT',
  'REVERSED',
  'REFUNDED',
  'FAILED',
  'REJECTED',
]);

export const allocationStatusEnum = pgEnum('allocation_status', ['ACTIVE', 'REVERSED']);

// --- Reversals ---

export const reversalTypeEnum = pgEnum('reversal_type', ['REVERSAL', 'REFUND', 'CORRECTION']);

// --- Receipts ---

export const receiptStatusEnum = pgEnum('receipt_status', ['ISSUED', 'VOID']);

// --- Payment links ---

export const paymentLinkStatusEnum = pgEnum('payment_link_status', [
  'ACTIVE',
  'PAID',
  'EXPIRED',
  'REVOKED',
]);

// --- Communications ---

export const communicationChannelEnum = pgEnum('communication_channel', [
  'SMS',
  'EMAIL',
  'WHATSAPP',
  'PRINT',
  'IN_APP',
]);

export const communicationStatusEnum = pgEnum('communication_status', [
  'PENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
]);

// --- Audit ---

export const auditActorTypeEnum = pgEnum('audit_actor_type', ['USER', 'SYSTEM', 'WEBHOOK']);

// --- Webhooks ---

export const webhookStatusEnum = pgEnum('webhook_status', [
  'RECEIVED',
  'PROCESSED',
  'FAILED',
  'RETRYING',
  'REJECTED',
]);

// --- Guardians ---

export const guardianRelationshipEnum = pgEnum('guardian_relationship', [
  'PARENT',
  'GUARDIAN',
  'SPONSOR',
  'OTHER',
]);

// --- H-2: declared invoice aggregation scope -------------------------------

/**
 * The scope a financial surface declares for itself. `ALL_TERM` is the
 * documented default (arrear visibility is the safe default); `TERM` is an
 * explicit, auditable opt-in.
 */
export const invoiceScopeEnum = pgEnum('invoice_scope', ['TERM', 'ALL_TERM']);

// H-8 invitations. PENDING is the only state a token can be consumed from;
// acceptance and revocation are terminal.
export const invitationStatusEnum = pgEnum('invitation_status', ['PENDING', 'ACCEPTED', 'REVOKED']);
