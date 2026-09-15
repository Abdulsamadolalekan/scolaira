# SCOLAIRA — Financial Invariants

> If a financial invariant cannot be guaranteed, STOP and flag it.

All monetary values are **integer kobo (BIGINT)** internally. All API contracts use **Naira strings** with two decimals (e.g. `"150000.00"`). All arithmetic must be on kobo. Floating-point arithmetic on money is forbidden; CI will fail on lint rules that apply number ops to kobo fields.

---

## I. Canonical Invariants

| # | Invariant | Enforcement |
|---|---|---|
| F1 | **Invoice totals** equal the sum of all non-void invoice lines for that invoice. | DB trigger + service-layer assertion; sum() on lines = invoice.total_kobo. |
| F2 | **Payment amounts** are strictly positive. Reversals and refunds are explicit, separate records — never negative payments. | Check constraint `amount_kobo > 0`; reversals are in `reversals` table with positive amount and sign-polarity handled in aggregation views. |
| F3 | **Allocations ≤ payment.** Σ(PaymentAllocation.amount_kobo) for a given payment ≤ payment.amount_kobo, minus any reversal already applied. | Check constraint + trigger + service-layer SELECT … FOR UPDATE lock on payment row during allocation. |
| F4 | **Allocations ≤ invoice outstanding.** Σ(allocations to invoice) + Σ(reversals of allocations to invoice) ≤ invoice.total_kobo. | Trigger + service assertion; invoice outstanding is derived, never stored as independent mutable state. |
| F5 | **Confirmed payments never disappear.** Soft-delete/void is not allowed for confirmed payments. Reversal is the only correction path. | `payments.state` is an enum (`PENDING`, `CONFIRMED`, `REVERSED`, `REFUNDED`, `FAILED`); hard-delete blocked by trigger; `state` transitions constrained. |
| F6 | **Reversals preserve history.** Reversals are append-only rows pointing to the original payment/allocation. | Foreign key to original; reversal rows cannot be edited after insertion; audit log records who/when/why. |
| F7 | **Refunded/reversed payments do not contribute to collected totals.** Aggregation views/reports exclude `REVERSED`/`REFUNDED` payments and adjust for partial reversals. | Reporting views sum only `CONFIRMED` minus reversed amounts; integration tests cover each scenario. |
| F8 | **Duplicate payment references** are safely handled. | Unique `(organization_id, payment_method, external_reference)` where reference is non-null; duplicate webhooks dedup on provider reference + idempotency key. |
| F9 | **Webhooks are idempotent.** Re-delivery of an already-processed event is a no-op; out-of-order events do not corrupt state. | Idempotency table keyed by `(provider, event_id)`; state machine enforces valid transitions only (e.g., you cannot reverse a payment that is still PENDING). |
| F10 | **Out-of-order events** do not corrupt balances. Late `payment.success` after `refund` is reconciled as a separate, reviewable item — not double-counted. | State machine with explicit transitions; when a late event arrives for a non-current state, it is flagged for human review rather than auto-applied. |
| F11 | **Single tenancy of financial records.** Every financial row belongs to exactly one organization; queries cannot cross tenants. | `organization_id NOT NULL` on every financial table + FK to organizations + Postgres RLS + application-level guard. |
| F12 | **Auditability.** Every financial mutation writes an append-only audit event (actor, action, before/after snapshot hashes, timestamp, request id). | Audit trigger on financial tables + service-level audit emission; audit table has no UPDATE/DELETE permissions for app role. |
| F13 | **Previous-term balances are distinguishable** from current-term obligations. | Invoices carry a `term_id`; outstanding aggregations group by term/current-vs-prior; the Command Center separates "current term outstanding" from "previous-term exposure." |
| F14 | **Reports derive from authoritative data.** No cached dashboard totals; reports run against financial tables or materialized views refreshed transactionally. | Reporting functions read from invoices/payments/allocations directly; materialized views, if introduced, refresh in transactions and are marked stale-safe. |
| F15 | **The system never manufactures a financial result** because the UI expects one. If data is missing or inconsistent, the UI shows the uncertainty rather than a false number. | Service methods return explicit uncertainty flags (e.g., reconciliation `FLAGGED`); UI exposes uncertainty; no client-side "fixing" of numbers. |

## II. State Machines

### Invoice state
```
DRAFT → ISSUED → PARTIALLY_PAID → PAID
  │        │         │
  ▼        ▼         ▼
 VOID    VOID       VOID   (with proper reversal of allocations)
```

- `DRAFT`: editable, not yet sent/visible to parent/command-center totals.
- `ISSUED`: finalized; contributes to BILLED totals; immutable lines except via credit note / correction invoice.
- `PARTIALLY_PAID`: at least one allocation but outstanding > 0.
- `PAID`: outstanding == 0.
- `VOID`: zeroed out via a credit note; history preserved; does not contribute to BILLED (net zero).

### Payment state
```
PENDING → CONFIRMED → REVERSED
                │
                └→ REFUNDED
PENDING → FAILED
PENDING → DUPLICATE_SUSPECT → CONFIRMED (manual review) or REJECTED
```

- `PENDING`: recorded (e.g. webhook received but not signature-verified; or cash entered as provisional?). *Decision:* cash/transfer/POS entries should be created directly CONFIRMED by authorized finance officer; online payments PENDING until webhook confirmation.
- `CONFIRMED`: counts toward collected; eligible for allocation.
- `REVERSED`: full reversal; does not count toward collected.
- `REFUNDED`: money returned; does not count toward collected; requires original payment reference.
- `FAILED`: e.g., online payment failed; no financial effect.
- `DUPLICATE_SUSPECT`: suspected duplicate reference; held for review; not allocated until resolved.

### Payment Link state
```
ACTIVE → PAID (one-time)
ACTIVE → EXPIRED
ACTIVE → REVOKED
```

- Links are single-use per payment or per-invoice depending on configuration.
- Expiry is timestamp-based; expired links show a clear expired page.

## III. Concurrency Controls

| Scenario | Control |
|---|---|
| Two finance officers record payments on same student | Independent; sum naturally; no lock needed beyond per-statement transactions. |
| Two allocations against same payment/invoice concurrently | Transaction with `SELECT … FOR UPDATE` on payment and target invoice rows; check outstanding inside the transaction; abort if would exceed. |
| Duplicate webhook | Idempotency table unique key on `(provider, event_id)`; second delivery returns 200 OK but performs no mutation. |
| Webhook for already-refunded payment | State-machine guard; late `charge.success` after `refund.successful` routes to `DUPLICATE_SUSPECT` for manual reconciliation. |
| CSV import during active billing | Import runs in a transaction; duplicate identifiers are flagged, not partially written. |
| User double-clicks "Record payment" | Client disables + server-side idempotency key (client-generated UUID) enforced unique per `(organization_id, user_id, idempotency_key)`. |

## IV. Kobo / Naira Boundary Rules

1. **All internal math is integer kobo.** `amount_kobo BIGINT NOT NULL`.
2. **API input/output is Naira string** with exactly two decimals, regex `^-?\d{1,15}\.\d{2}$`. Negative only in explicit correction/refund contexts where allowed by contract.
3. **Parsing** is done by a single `parseNaira(s): Kobo` function that rejects malformed strings; never via `Number(s) * 100`.
4. **Formatting** is done by a single `formatKobo(k): NairaString` function; UI components never format money ad-hoc.
5. **Database** stores kobo; no floats, no `NUMERIC` (avoids accidental decimal drift in JS), no cents-as-string-in-DB. BIGINT kobo is the canonical representation.
6. **Rounding policy:** kobo is the smallest unit; fee templates may only define kobo-aligned amounts; division-based allocations (e.g. splitting a partial payment across invoices) use deterministic allocation (largest-invoice-first or FIFO) with remainder explicitly assigned to one line — never silent rounding errors.

## V. Allocation Algorithm (Default)

When a payment arrives without explicit allocation instruction (e.g., parent makes bank transfer without specifying invoice), SCOLAIRA applies a deterministic default:

1. Allocate to **overdue invoices** in descending order by `(overdue_days DESC, outstanding_kobo DESC)`.
2. Then allocate to **current-term invoices** in due-date order (earliest first), then by outstanding_kobo DESC.
3. Then allocate to **previous-term balances** oldest first.
4. Remainder that cannot fully pay an invoice becomes partial allocation.
5. If after allocation the payment is over-received (unlikely for method-captured payments; possible for unmatched transfers), the surplus remains on the payment as **unallocated** and surfaces in Reconciliation as "Excess payment — requires review."

*Rationale:* deterministic, explainable, reviewable. Finance officer can always re-allocate before close; correction is an audited action.

## VI. Audit Requirements for Financial Mutations

Every mutation (invoice create/issue/void, payment record/confirm/reverse, allocation create/undo, receipt issue, fee template change affecting billed amounts) must produce an audit event with:

- `id` (UUID)
- `organization_id`
- `actor_user_id` (nullable for system/webhook, with `actor_type` = 'system'|'webhook'|'user')
- `action` (e.g., `payment.confirmed`, `allocation.created`)
- `entity_type` + `entity_id`
- `before_jsonb` (snapshot of changed fields pre-mutation, or null for creates)
- `after_jsonb` (snapshot post-mutation)
- `reason` (nullable; required for reversals/corrections/voids)
- `request_id` (for idempotency and tracing)
- `ip_address` (for user-initiated; not for webhooks where provider-verified)
- `created_at` (immutable)

## VII. Required Test Coverage for Invariants

Every invariant in §I must have at least one deterministic automated test. These are part of the required financial test matrix and gate Phase 1 exit.

## VIII. Invariant Violation Response

If a service-layer assertion or DB trigger detects an invariant violation:

1. Roll back the transaction immediately.
2. Log a structured error with `severity: 'FINANCIAL_INVARIANT_VIOLATION'` (no PII in log).
3. Return a deterministic API error (e.g., `409 ALLOCATION_EXCEEDS_OUTSTANDING`) with a human-readable explanation and safe next steps.
4. Surface in monitoring (Sentry) as a critical alert.
5. Increment a counter for the specific invariant.

A violation is never silently coerced to "make it work."
