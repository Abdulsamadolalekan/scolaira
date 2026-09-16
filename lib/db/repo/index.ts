/**
 * Repository barrel — re-exports every scoped repository module.
 *
 * Usage:
 *
 *   import { withTenant } from '@/lib/db/tenant';
 *   import { invoices, payments } from '@/lib/db/repo';
 *
 *   await withTenant({ organizationId, userId }, async (db, ctx) => {
 *     const invoice = await invoices.create(db, ctx, { studentId, termId, lines: [...] });
 *     // ...
 *   });
 */
export * as organizations from './organizations';
export * as users from './users';
export * as organizationMembers from './organization-members';
export * as academicSessions from './academic-sessions';
export * as terms from './terms';
export * as classes from './classes';
export * as students from './students';
export * as feeDefinitions from './fee-definitions';
export * as feeAssignments from './fee-assignments';
export * as invoices from './invoices';
export * as invoiceLines from './invoice-lines';
export * as payments from './payments';
export * as paymentAllocations from './payment-allocations';
export * as receipts from './receipts';
export * as reversals from './reversals';
export * as paymentLinks from './payment-links';
export * as auditEvents from './audit-events';
export * as idempotencyKeys from './idempotency-keys';
export * as webhookEvents from './webhook-events';
export * from './_context';
