/**
 * Rich deterministic M2 seed (§XI).
 *
 * Builds a financially coherent fixture for Org A on top of seedTwoOrgs using
 * the repository layer (so triggers and invariants are exercised, not
 * bypassed). At exit, tenant context is set to Org A / Alice.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { UUID } from '@/lib/db/repo/_context';
import type { SeededIds } from './seed';
import type { Database } from '@/lib/db';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import * as paymentLinksRepo from '@/lib/db/repo/payment-links';
import * as auditRepo from '@/lib/db/repo/audit-events';
import * as idemRepo from '@/lib/db/repo/idempotency-keys';
import * as webhookRepo from '@/lib/db/repo/webhook-events';
import { kobo } from '@/lib/money';

export interface RichIds extends SeededIds {
  classA2Id: UUID;
  studentA2Id: UUID;
  studentA3Id: UUID;
  invDraftId: UUID;
  invPaidId: UUID;
  invPartialId: UUID;
  invOverpaidId: UUID;
  invReversedId: UUID;
  payCashId: UUID;
  payBankId: UUID;
  payPosId: UUID;
  payReversedId: UUID;
  linkToken: string;
  overpaymentKobo: number;
}

export async function applyRichSeed(sql: postgres.Sql, base: SeededIds): Promise<RichIds> {
  const db = drizzle(sql) as unknown as Database;
  const ctx = { organizationId: base.orgId, userId: base.aliceId };

  // Switch into org A as Alice.
  await sql`SELECT set_tenant_context(${base.orgId}::uuid, ${base.aliceId}::uuid)`;

  const classA2Id = randomUUID() as UUID;
  const studentA2Id = randomUUID() as UUID;
  const studentA3Id = randomUUID() as UUID;

  await sql`INSERT INTO classes (id, name) VALUES (${classA2Id}::uuid, 'SS3 East')`;
  await sql`
    INSERT INTO students (id, student_id, first_name, last_name, status) VALUES
      (${studentA2Id}::uuid, 'STU-A02', 'Chinedu', 'Okonkwo', 'ACTIVE'),
      (${studentA3Id}::uuid, 'STU-A03', 'Zainab', 'Abubakar', 'ACTIVE')
  `;

  const tuitionAmt = 45_000_000;
  const levyAmt    = 5_000_000;
  const bankAmt    = 20_000_000;
  const overpayExtra = 3_000_000;
  const posAmt     = levyAmt + overpayExtra;

  // (a) DRAFT invoice for A1, no lines/total
  const draft = await invoicesRepo.createDraft(db, ctx, {
    studentId: base.studentAId, termId: base.termId, sessionId: base.sessionId,
  });

  // (b) ISSUED → paid in full via CASH
  const invPaid = await invoicesRepo.createDraft(db, ctx, {
    studentId: base.studentAId, termId: base.termId, sessionId: base.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invPaid.id, [
    { description: 'Tuition', quantity: 1, unitRateKobo: kobo(tuitionAmt), amountKobo: kobo(tuitionAmt) },
  ]);
  const issuedPaid = await invoicesRepo.issue(db, ctx, invPaid.id);
  const payCash = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(tuitionAmt) });
  await allocationsRepo.allocate(db, ctx, { paymentId: payCash.id, invoiceId: issuedPaid.id, amountKobo: kobo(tuitionAmt) });

  // (c) ISSUED → partially paid via BANK_TRANSFER
  const invPartial = await invoicesRepo.createDraft(db, ctx, {
    studentId: studentA2Id, termId: base.termId, sessionId: base.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invPartial.id, [
    { description: 'Tuition', quantity: 1, unitRateKobo: kobo(tuitionAmt), amountKobo: kobo(tuitionAmt) },
  ]);
  const issuedPartial = await invoicesRepo.issue(db, ctx, invPartial.id);
  const payBank = await paymentsRepo.record(db, ctx, { method: 'BANK_TRANSFER', amountKobo: kobo(bankAmt), reference: 'BANK-RICH-001' });
  await allocationsRepo.allocate(db, ctx, { paymentId: payBank.id, invoiceId: issuedPartial.id, amountKobo: kobo(bankAmt) });

  // (d) ISSUED → overpaid via POS; overpayment preserved as unallocated
  const invOver = await invoicesRepo.createDraft(db, ctx, {
    studentId: studentA3Id, termId: base.termId, sessionId: base.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invOver.id, [
    { description: 'Levy', quantity: 1, unitRateKobo: kobo(levyAmt), amountKobo: kobo(levyAmt) },
  ]);
  const issuedOver = await invoicesRepo.issue(db, ctx, invOver.id);
  const payPos = await paymentsRepo.record(db, ctx, { method: 'POS', amountKobo: kobo(posAmt), reference: 'POS-RICH-001' });
  await allocationsRepo.allocate(db, ctx, { paymentId: payPos.id, invoiceId: issuedOver.id, amountKobo: kobo(levyAmt) });

  // (e) ISSUED → paid → fully reversed (invoice returns to ISSUED, payment REVERSED)
  const invRev = await invoicesRepo.createDraft(db, ctx, {
    studentId: base.studentAId, termId: base.termId, sessionId: base.sessionId,
  });
  await invoiceLinesRepo.addLines(db, ctx, invRev.id, [
    { description: 'Levy', quantity: 1, unitRateKobo: kobo(levyAmt), amountKobo: kobo(levyAmt) },
  ]);
  const issuedRev = await invoicesRepo.issue(db, ctx, invRev.id);
  const payRev = await paymentsRepo.record(db, ctx, { method: 'CASH', amountKobo: kobo(levyAmt) });
  await allocationsRepo.allocate(db, ctx, { paymentId: payRev.id, invoiceId: issuedRev.id, amountKobo: kobo(levyAmt) });
  await reversalsRepo.create(db, ctx, { paymentId: payRev.id, amountKobo: kobo(levyAmt), reason: 'parent dispute' });

  // Payment link for partial invoice (open amount = outstanding)
  const linkToken = 'rich-pl-token-' + randomUUID().slice(0, 8);
  await paymentLinksRepo.create(db, ctx, {
    token: linkToken,
    invoiceId: issuedPartial.id,
    amountKobo: kobo(tuitionAmt - bankAmt),
  });

  // Audit, idempotency key, webhook
  await auditRepo.record(db, ctx, {
    action: 'invoice.issued', entityType: 'invoices', entityId: issuedPaid.id,
    before: { status: 'DRAFT' }, after: { status: 'ISSUED' }, reason: 'term billing',
  });
  await idemRepo.acquire(db, ctx, { key: 'ik-rich-001', scope: 'API', expiresAt: new Date(Date.now() + 86_400_000) });
  const { event: whEv } = await webhookRepo.ingest(db, {
    provider: 'paystack', eventId: 'evt_rich_001', eventType: 'charge.success',
    payload: { reference: 'POS-RICH-001' }, organizationId: base.orgId,
  });
  await webhookRepo.markProcessed(db, whEv.id as UUID, base.orgId);

  return {
    ...base,
    classA2Id, studentA2Id, studentA3Id,
    invDraftId: draft.id,
    invPaidId: issuedPaid.id,
    invPartialId: issuedPartial.id,
    invOverpaidId: issuedOver.id,
    invReversedId: issuedRev.id,
    payCashId: payCash.id,
    payBankId: payBank.id,
    payPosId: payPos.id,
    payReversedId: payRev.id,
    linkToken,
    overpaymentKobo: overpayExtra,
  };
}
