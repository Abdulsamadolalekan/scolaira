# Opening Balance (Carry-in) State Machine

Entity: `opening_balances` · migration `0052_opening_balances.sql` · surface
`/finance/opening-balances` · API group **W** in `docs/API_CONTRACTS.md`

## Why this machine exists

A school arriving at SCOLAIRA already owes money to itself: children were billed
last term, some overpaid, some are behind, and some of that is written on paper
nobody has checked. The tempting shortcut is a "opening balance" column on
`students` or a manual invoice created by hand. Both are wrong for the same reason:
they let an unverified number become a debt without leaving a trace of who decided
it, when, and from what evidence.

So a carry-in is a **record first and a debt only later**, and the later step reuses
the ordinary invoice machine rather than a parallel one.

## Valid states

- `DRAFT` — recorded, not yet agreed to. No invoice exists; the child owes nothing.
- `APPROVED` — a second look agreed the figure belongs to the student. Still no
  invoice, because approving a fact and creating a debt are two decisions.
- `POSTED` — an invoice was created **through the normal billing path**
  (`createDraft → addLine → issue`) on a **past** term, and its id is on this row.
  This is the only state that touches the ledger.
- `REJECTED` — the figure was wrong or unprovable. Terminal. The row stays so the
  next person does not record the same thing again.
- `REVERSED` — a posted row whose invoice was voided, with a mandatory reason.
  Terminal. Never a delete: the ledger keeps both events.

## Transitions

| From       | To         | Who (permission)                 | Guard                                                            |
| ---------- | ---------- | -------------------------------- | ---------------------------------------------------------------- |
| create     | `DRAFT`    | `invoice.create`                 | figure > 0, source note ≥ 5 chars, student exists, **not** the current term |
| `DRAFT`    | `APPROVED` | `invoice.issue`                  | nothing else; `self_reviewed` recorded when the approver created the row |
| `DRAFT`    | `REJECTED` | `invoice.issue`                  | reason required (≥ 4 chars)                                       |
| `APPROVED` | `POSTED`   | `invoice.issue` + Idempotency-Key | category must be `HISTORICAL_BALANCE`, `term_id` set and in the past, key required |
| `APPROVED` | `REJECTED` | `invoice.issue`                  | reason required                                                   |
| `POSTED`   | `REVERSED` | `invoice.void`                   | reason required; refused while the invoice has `paid_kobo > 0` (a real payment needs the real refund path) |

Anything not in this table is refused — including editing a recorded figure after it
left `DRAFT`, posting a second carry-in for the same student and term, and any
attempt to delete a row.

## What may never happen (enforced below the application)

1. **No state skips.** `DRAFT → POSTED` is impossible even with a direct `UPDATE`:
   a trigger compares the pair against the allowed transitions.
2. **No silent re-writing of history.** Non-status columns are frozen the moment the
   row stops being a `DRAFT`.
3. **No double debt.** A partial unique index on `(organization_id, student_id,
   term_id) WHERE status = 'POSTED' AND category = 'HISTORICAL_BALANCE'` makes the
   second post — including one that raced past the API's own check — fail in
   Postgres, and the route rolls both the invoice and the row back.
4. **No posting into the current term.** A carry-in belongs to the term it came from;
   charging it again in the live term is exactly how a school double-bills a family.
5. **No unverifiable self-approval.** A one-person school must be able to set up, so
   self-review is allowed — but a BEFORE trigger derives `self_reviewed` from
   `created_by = reviewed_by`, so the flag cannot be forged or forgotten and the row
   reads as self-approved forever.
6. **No credit ever posted as a charge.** `CREDIT_OVERPAYMENT`,
   `CURRENT_TERM_UNBILLED` and `UNVERIFIED` are marked non-postable by a CHECK
   constraint, not just in TypeScript. A credit's negative sign is likewise derived
   by a CHECK from the category, so a mistyped sign cannot survive.
7. **No deletion.** Table-level `DELETE` is revoked, the restrictive RLS policy
   denies it, and a BEFORE DELETE trigger refuses. Corrections are transitions.
8. **`UNVERIFIED` never becomes money.** It counts in the register and contributes
   nothing to any outstanding figure, so an unproven number cannot leak into a debt
   report.

## How the money is read

- `outstandingKobo` per row = the posted invoice's `total − paid`, floored at `0`, and
  `0` once the invoice is `VOID` (the debt was removed, so it is not "still owed").
- The register's summary is **per category**. `CURRENT_TERM_UNBILLED` rows are this
  term's bills being retyped, `CREDIT_OVERPAYMENT` rows are money the school holds,
  `HISTORICAL_BALANCE` rows are the carry-in debt. Adding them produces a number no
  one can defend, so the product never does it — the five figures sit side by side.
- `collectedAgainstCarryInKobo` counts payments that reached posted carry-in
  invoices, so "what we carried in" and "what has since been paid against it" are
  distinguishable without a query.

## What deliberately reuses the existing machine

`POST` does not insert into `invoices`. It calls the same repository functions the
billing run calls, so the invoice gains:

- a generated `INV-YYYY-NNNNNN` number,
- the `term_bucket` classification owned by H-2 (`PRIOR_TERM`, never
  `CURRENT_TERM`, asserted in the tests),
- lines, status machine, ledger, receipts, allocation and audit behaviour that every
  other invoice has — no second implementation of "unpaid, owing money".

## Pinned by

`tests/db/opening-balance-rules.test.ts` (14 pure rule tests),
`tests/db/opening-balances.test.ts` (18 live-DB invariant tests),
`tests/auth/opening-balances-routes.test.ts` (21 HTTP-surface tests) — including the
trigger-derived `self_reviewed`, the four 403s for a staff member, cross-tenant
invisibility, forged `organization_id` re-stamping, replay-safe posting, the duplicate
409 with no orphan invoice, the VOID → outstanding-0 reading and the three-event audit
trail (`record`, `review.approve`, `post`).
