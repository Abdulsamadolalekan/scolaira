# Concurrency Design — Concrete Transaction Behavior

> For each of the founder-named races (A–G), specify: LOCK, CONSTRAINT, IDEMPOTENCY, TRANSACTION, STATE TRANSITION, EXPECTED RESULT.

All mutations run in a single Postgres transaction at `READ COMMITTED` isolation, with explicit `SELECT … FOR UPDATE` row locks on payment and invoice rows when allocations or confirmations occur. Application-side checks inside the transaction after acquiring locks are the source of truth.

---

## Case A — Two staff record the same payment simultaneously

**Scenario:** Finance Officer A and Finance Officer B both record a cash payment of ₦100,000 for the same student (likely duplicate entry).

- **LOCK:** No row lock needed for creation (different payment rows); however, duplicate detection runs.
- **CONSTRAINT:** Unique `(organization_id, method, external_reference)` when external_reference is non-null. For CASH, external_reference is typically null and duplicate risk is handled by business logic, not constraint.
- **IDEMPOTENCY:** Each request carries client-generated `Idempotency-Key` (UUID). If the two clicks are the same logical action (same user + same idempotency key within 24h), the second returns the stored response without creating a second payment.
- **TRANSACTION:**
  1. Begin tx.
  2. Look up idempotency key; if exists and response body matches, return stored response.
  3. Insert payment row (status CONFIRMED for cash).
  4. If the payment specifies allocations, lock relevant invoices and payment (same as Case B) and insert allocations; if not, run deterministic auto-allocation.
  5. Insert idempotency record.
  6. Insert audit event.
  7. Commit.
- **STATE TRANSITION:** Each successful tx creates a new payment in CONFIRMED state and drives allocations/invoice state transitions.
- **EXPECTED RESULT:**
  - If officers used the same idempotency key (same form submit double-click): one payment created; second is a no-op.
  - If officers intentionally entered two distinct records (different idempotency keys), two separate CONFIRMED payments are created. The system does not silently prevent or classify the second record with a heuristic. An operator may manually open a reconciliation case, attach evidence, and flag it; any reversal/refund uses the existing audited correction path. This is intentional: ambiguity remains visible rather than becoming an automatic financial decision.

## Case B — Two requests attempt the same allocation simultaneously

**Scenario:** Request 1 and Request 2 both attempt to allocate a payment of ₦100k to a single invoice with ₦100k outstanding.

- **LOCK:** Within the transaction:
  ```sql
  SELECT * FROM payments WHERE id = $1 FOR UPDATE;
  SELECT * FROM invoices WHERE id = $2 FOR UPDATE;
  ```
- **CONSTRAINT:** Database triggers enforce F3 (Σ allocations ≤ payment.amount) and F4 (Σ allocations ≤ invoice.total). Trigger uses the same locks Postgres provides via FOR UPDATE on parent rows.
- **IDEMPOTENCY:** Allocation requests can carry an idempotency key (useful for retries); however primary protection is locking + trigger.
- **TRANSACTION:**
  1. Begin tx.
  2. Lock payment row.
  3. Lock target invoice row(s) (deterministic lock order: payment first, then invoices ordered by invoice_id to prevent deadlocks).
  4. Re-read allocatable balance on payment: `payment.amount_kobo − Σ(non-reversed allocations)`.
  5. Re-read outstanding on invoice: `invoice.total_kobo − invoice.paid_kobo` (paid_kobo is maintained by trigger).
  6. Compute allocatable amount = MIN(requested_amount, payment_remaining, invoice_outstanding).
  7. If allocatable < requested:
     - If strict mode: abort with 409 `ALLOCATION_EXCEEDS_OUTSTANDING`.
     - If auto mode: allocate allocatable and leave remainder unallocated with message.
  8. Insert payment_allocations row.
  9. Trigger updates invoice.paid_kobo and may transition state (PARTIALLY_PAID/PAID).
  10. Insert audit event.
  11. Commit.
- **STATE TRANSITION:** Exactly one allocation is recorded; the invoice transitions correctly (to PAID if exact, to PARTIALLY_PAID if partial).
- **EXPECTED RESULT:** One request succeeds; the second sees (after acquiring locks) that allocatable amount is 0 and fails with a deterministic 409. The second caller's UI can refresh to show the resulting state ("Payment already allocated by another user. Here is the current state."). The system never creates two allocations exceeding the payment or invoice balances.

**Lock ordering note:** Always lock payments first, then invoices sorted by UUID, to prevent deadlocks between two allocations operating on (invoiceA, invoiceB) and (invoiceB, invoiceA) — payments are the top-level resource and always locked first.

## Case C — Two identical webhooks arrive simultaneously

**Scenario:** Paystack (or retry) delivers two copies of `charge.success` for the same provider event at nearly the same time.

- **LOCK:** Insert into webhook_events with unique constraint on `(provider, event_id)`; lock on payment row by external reference.
- **CONSTRAINT:** UNIQUE `(provider, event_id)` on webhook_events; UNIQUE `(organization_id, method, external_reference)` on payments when external_reference not null; UNIQUE `(scope, organization_id, key)` on idempotency_keys.
- **IDEMPOTENCY:** The provider event_id is the idempotency key for webhook processing.
- **TRANSACTION:**
  1. Begin tx.
  2. Attempt INSERT into webhook_events with `(provider, event_id, signature_valid, payload, status='RECEIVED')`.
  3. If duplicate key violation: read existing webhook event; if status is PROCESSED, return 200 with same response as original; if RECEIVED (race in progress), return 200 and let the other transaction finish (safe no-op).
  4. Verify HMAC signature (must already be verified before DB tx; done on raw body at edge). If invalid, mark REJECTED and 400.
  5. Look up or create payment by `(organization_id, 'ONLINE', external_reference=provider_reference)`:
     - If payment already exists with status CONFIRMED: mark webhook DUPLICATE and return 200 (no mutation).
     - If payment exists with status PENDING: lock it; transition to CONFIRMED; perform allocations.
     - If payment exists with status REFUNDED/REVERSED: DO NOT transition to CONFIRMED; mark webhook FLAGGED; route to reconciliation queue for human review (late success after refund — see Case E).
     - If no payment exists: create PENDING → CONFIRMED; attach to student from payment link metadata; perform deterministic auto-allocation.
  6. Update webhook event status to PROCESSED.
  7. Insert audit events.
  8. Commit.
- **STATE TRANSITION:** First webhook processes the payment to CONFIRMED (or applies allocations); second is a deterministic no-op.
- **EXPECTED RESULT:** Exactly one payment record is created/confirmed; allocations happen once; the second webhook returns 200 and is logged as DUPLICATE; no double counting.

## Case D — A refund arrives before a success event (out-of-order)

**Scenario:** For a Paystack transaction, `refund.successful` arrives before `charge.success` (very rare, possible due to retries/queues).

- **LOCK:** Lock by external reference.
- **CONSTRAINT:** UNIQUE external_reference; state-machine transition guards.
- **IDEMPOTENCY:** Both events idempotent by `event_id`.
- **TRANSACTION:**
  1. Process refund event first:
     - Lookup payment by external_reference; not found → create payment with status PENDING (no CONFIRMED yet), then INSERT reversal of type REFUND, which attempts to mark payment REFUNDED.
     - However state-machine blocks PENDING → REFUNDED directly (you can't refund an unconfirmed payment).
     - Instead: INSERT the reversal as PENDING_RECONCILIATION (a marker), mark webhook as FLAGGED.
  2. When `charge.success` later arrives:
     - Find payment in PENDING with a pending refund marker.
     - State-machine sees this and: transition PENDING → CONFIRMED → REFUNDED atomically (apply success then immediately reverse), leaving net effect as zero money collected.
     - OR: move to DUPLICATE_SUSPECT/FLAGGED if the business decision is to require human review.
- **STATE TRANSITION:** The payment ends in REFUNDED state with zero contribution to collected; audit trail shows the out-of-order arrival and the resolution.
- **EXPECTED RESULT:** Money is never double-counted; the late-success-then-refund is handled deterministically; the case is surfaced in reconciliation for visibility. Default policy: auto-settle to REFUNDED for symmetric events (refund clearly references a successful charge by reference); flag for human review if asymmetry is detected (e.g., refund amount differs from charge amount, partial refund).

**DESIGN DECISION:** This is conservative but safe. For the pilot, we will FLAG for human review rather than auto-refund, to avoid incorrectly reversing a legitimate payment because of event ordering. Flagged items appear at the top of the reconciliation queue. Log this decision in DECISIONS.md after founder/finance-officer feedback.

## Case E — A success event arrives after a refund

**Scenario:** `refund.successful` has already been processed (payment CONFIRMED → REFUNDED). Later a duplicate/late delivery of `charge.success` arrives.

- **LOCK:** Lock payment row.
- **CONSTRAINT:** State machine.
- **IDEMPOTENCY:** `charge.success` event_id dedup; if this exact event already led to CONFIRMED, it is already in webhook_events as PROCESSED/DUPLICATE. But a late replay that bypasses idempotency (e.g., same event_id re-delivered after retention) is caught here.
- **TRANSACTION:**
  1. Find payment in REFUNDED state.
  2. State machine does NOT allow REFUNDED → CONFIRMED (would re-instate reversed money).
  3. Mark webhook as FLAGGED; do not modify payment; surface in reconciliation queue ("Late success for already-refunded payment — review").
  4. Send notification to finance officer.
- **STATE TRANSITION:** None on payment; webhook event recorded as FLAGGED.
- **EXPECTED RESULT:** A refunded payment stays refunded. The late success never silently brings money back onto the ledger. A human reviews to determine if the refund was in error (in which case they record a new corrective payment, not reopen the old one).

## Case F — A user retries a payment-recording request (double-click / network retry)

**Scenario:** User clicks "Record payment," browser sends the request twice (double-click or TCP retry).

- **LOCK:** No special lock beyond idempotency.
- **CONSTRAINT:** UNIQUE `(scope, organization_id, key)` on idempotency_keys where key is the client-generated UUID sent in `Idempotency-Key` header.
- **IDEMPOTENCY:** Client MUST send `Idempotency-Key` for POST /api/payments (and all mutating endpoints). UI auto-generates one per form submission; retry preserves it.
- **TRANSACTION:**
  1. Begin tx.
  2. Look up idempotency_keys for (scope='api', organization_id, key).
  3. If found: return stored response (status + body) as-is; do not re-run the mutation.
  4. If not found: proceed with payment creation + allocation; on success, store response in idempotency_keys.
  5. Commit.
- **STATE TRANSITION:** Same outcome as Case A idempotent path.
- **EXPECTED RESULT:** One payment created. Second request returns the same response. If the user truly wants to record two separate payments, they use the form twice (which generates a new idempotency key each submission).

If a client omits the idempotency key: server accepts (for API friendliness) but relies on duplicate-reference constraints (for online) and reconciliation heuristics (for cash). This is weaker; the UI will always send idempotency keys.

## Case G — Two users attempt to reverse the same payment simultaneously

**Scenario:** Owner and Finance Officer both click "Reverse" on the same payment at the same time (perhaps one on desktop, one on phone).

- **LOCK:** `SELECT FOR UPDATE` on payments row; also lock associated allocations via JOIN FOR UPDATE.
- **CONSTRAINT:** Reversal amount validated against reversible amount (paid - already reversed); state machine.
- **IDEMPOTENCY:** Reversals carry idempotency key; two reversals of the same payment with same reason/amount should dedup, but it's safer to let the lock/constraint handle it (two reversals may be legitimate — e.g., partial reversals at different amounts — so we don't dedup purely by payment id).
- **TRANSACTION:**
  1. Begin tx.
  2. Lock payment row FOR UPDATE.
  3. Re-read payment status and current reversed amount (sum of existing reversals for this payment).
  4. Validate: status is CONFIRMED; requested reversal amount ≤ (payment.amount_kobo − already_reversed).
  5. If partial reversal leaves payment with some allocated amount: insert reversal row; reverse allocations proportionally (or per specific allocation if request specifies); payment stays CONFIRMED.
  6. If full reversal: insert reversal row; reverse all ACTIVE allocations; set payment status to REVERSED (or REFUNDED if type=REFUND).
  7. Update invoice states via triggers; void associated receipts as needed.
  8. Insert audit events.
  9. Commit.
- **STATE TRANSITION:** Exactly one reversal commits. The second transaction, upon acquiring the lock, sees the new state:
  - If the first reversal was full: payment status is REVERSED → second reversal fails with 409 `PAYMENT_ALREADY_REVERSED`.
  - If the first reversal was partial: second reversal calculates remaining reversible amount and either succeeds (if its amount ≤ remaining) or fails with 409 `REVERSAL_EXCEEDS_REMAINING`.
- **EXPECTED RESULT:** Over-reversal is impossible. User sees a clear message and the current state. No race condition can cause Σ reversals > payment amount.

---

## M10 — Reconciliation control-plane races

### Case M10-A — Two operators open the same payment case

- **LOCK/CONSTRAINT:** The payment is tenant-scoped; the open-case partial unique index `m10_reconciliation_one_open_payment_idx` permits at most one open case per payment.
- **IDEMPOTENCY:** Evidence, match, flag, confirm, allocate, and resolve mutations require the shared 24-hour `Idempotency-Key` boundary.
- **TRANSACTION:** Each creator first reads the open case, then inserts with `ON CONFLICT DO NOTHING` against the partial index and reads the winner if another transaction committed first.
- **EXPECTED RESULT:** Both callers receive the same case id; no duplicate review history or second control record is created.

### Case M10-B — Two operators make competing reconciliation decisions

- **LOCK/CONSTRAINT:** Case updates use an optimistic `version` predicate and the database transition trigger. A candidate has one partial unique accepted decision per case. Evidence is append-only.
- **TRANSACTION:** The service checks the current open case and evidence precondition, updates `version = version + 1`, and writes the audit event in the same transaction. A stale update affects zero rows and returns 409. A competing accepted candidate waits on the unique index and returns 409 to the loser.
- **EXPECTED RESULT:** Exactly one decision commits. The losing operator refreshes; no stale state or duplicate accepted candidate is silently merged.

### Case M10-C — Reconciliation allocation races with an existing financial path

- **LOCK/CONSTRAINT:** Reconciliation allocation locks the authoritative payment first, then delegates to the existing allocation repository and database triggers. The legacy payment allocation path remains authoritative and is not shadowed.
- **TRANSACTION:** After the payment lock, the service re-reads `unallocated_kobo`, checks the accepted human candidate, and inserts through `payment_allocations`. Trigger-maintained payment and invoice balances are read back after the insert.
- **EXPECTED RESULT:** One allocation consumes the available amount; a concurrent caller sees the reduced authoritative balance and fails deterministically rather than creating an over-allocation. Reconciliation state is only updated after the financial operation succeeds.

## General Concurrency Guardrails

1. **Deterministic lock order:** Always lock parent before children; for multiple invoices lock by UUID ordering to prevent deadlocks.
2. **Re-read after lock:** Never trust values read before acquiring a row lock.
3. **Trigger-enforced constraints supplement service checks:** If a bug bypasses service logic, DB triggers/constraints prevent invariant violation (defense-in-depth).
4. **Serialization failures (SQLSTATE 40001)** are caught by the service layer and retried once with a small delay for idempotent read operations; non-idempotent operations surface a retryable error to the user ("Please retry; another operation was in progress.").
5. **All concurrency cases in this document must have automated tests** using concurrent Postgres sessions (see test case FM-26 and FM-27 in the financial matrix, plus the specific A–G cases added to `/docs/TESTING.md`).
