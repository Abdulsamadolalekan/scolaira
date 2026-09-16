/**
 * Postgres enum types used across the schema.
 *
 * Naming: snake_case values match the approved state machines
 * (docs/state-machines/*) exactly.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// --- Identity / roles ---

export const orgStatusEnum = pgEnum('org_status', ['ACTIVE', 'SUSPENDED', 'CHURNED']);

export const membershipRoleEnum = pgEnum('membership_role', [
  'OWNER',
  'SCHOOL_ADMIN',
  'FINANCE_OFFICER',
  'STAFF',
  'PLATFORM_ADMIN', // platform-wide, not school membership; used for internal ops
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

export const feeAssignmentStatusEnum = pgEnum('fee_assignment_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);

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
