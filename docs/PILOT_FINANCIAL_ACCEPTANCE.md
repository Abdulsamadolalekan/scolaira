# Controlled pilot — financial acceptance criteria

What each step of a school's setup must produce, in numbers. Every expectation below is either
**measured** (the rehearsal on 2026-10-09 asserted it and the ledger agreed) or **to be confirmed**
(the criterion is written down but has not been exercised — see `docs/evidence/2026-10-09-pilot-rehearsal/PILOT_REHEARSAL_ANALYSIS.md` §4).

Units: money is stored as **kobo**, ₦1 = 100 kobo. The UI asks for naira. Every expectation is stated in
both because mixing them is the classic way a "green" check lies.

## 1. Worked example the criteria are built on

One school, 8 pupils, two classes (Primary 4, Primary 5), two fees — Tuition ₦45,000 and PTA levy
₦5,000 — applied school-wide to one active term.

## 2. Per step

| #   | Step                             | Must be true afterwards                                                                                                                                                                                                                                                                                                                                                                                              | Status                                                                                                                                                       |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | School registered                | 1 organization, 1 member with role `OWNER`, currency `NGN`, 0 students, 0 invoices, 0 payments                                                                                                                                                                                                                                                                                                                       | measured                                                                                                                                                     |
| 2   | Session + term + classes         | 1 session, 1 term `ACTIVE` and current, 2 classes; **no financial row changes**                                                                                                                                                                                                                                                                                                                                      | measured                                                                                                                                                     |
| 3   | CSV import of N pupils           | N students, N class enrolments, N guardian records + N links, and **`invoices = 0`** — an import never creates a charge. Rows the reviewer blocks stay out; a blocked file writes nothing                                                                                                                                                                                                                            | measured                                                                                                                                                     |
| 4   | Fee definitions                  | one row per fee, `default_amount_kobo` = naira × 100                                                                                                                                                                                                                                                                                                                                                                 | measured                                                                                                                                                     |
| 5   | Term structure saved             | `fee_assignments` ≥ 1, each with `amount_kobo` equal to what the bursar typed                                                                                                                                                                                                                                                                                                                                        | measured                                                                                                                                                     |
| 6   | **Term billing**                 | one invoice per enrolled pupil; lines per invoice = number of assigned fees; `invoices.total_kobo == Σ invoice_lines.amount_kobo` on **every** invoice; school billed = N × Σfees; collected 0; outstanding = billed; term row marked `billed` with `billed_at`; re-running billing creates 0 new invoices                                                                                                           | measured (8 pupils → 8 invoices, 16 lines, ₦400,000 = 40,000,000 kobo)                                                                                       |
| 7   | Staff-recorded payment ≤ balance | `payment.amount_kobo` = amount typed; exactly one live allocation to the oldest open invoice for that pupil; `unallocated_kobo = 0`; invoice `paid_kobo` increases by that amount; invoice outstanding falls by the same; `paid_kobo == Σ live allocations` school-wide                                                                                                                                              | measured (₦20,000 → 2,000,000 kobo allocated; invoice 5,000,000 → 3,000,000 outstanding)                                                                     |
| 8   | Payment > balance                | allocation capped at the invoice total; **the surplus stays as `unallocated_kobo`**; no invoice may end with `paid_kobo > total_kobo`; `amount == allocated + unallocated` on every payment                                                                                                                                                                                                                          | measured (₦60,000 → 5,000,000 allocated, 1,000,000 credit)                                                                                                   |
| 9   | Receipt                          | one receipt row per payment for which it is issued; `receipts.amount_kobo == payments.amount_kobo`; the frozen `allocations_snapshot` sums to the same figure; a receipt never changes a balance by itself                                                                                                                                                                                                           | measured                                                                                                                                                     |
| 10  | Public link claim                | link created per invoice with a bearer token; the parent page (no session) shows **amount due = invoice total − paid**; a submitted claim creates a payment with status `PENDING` and **no allocation**; resubmitting the same claim returns the original outcome rather than a second row                                                                                                                           | amount-due and link creation measured; claim submission and replay to be confirmed by hand                                                                   |
| 11  | Staff confirm a claim            | status `PENDING → CONFIRMED`; only then does an allocation appear; collected rises by the confirmed amount                                                                                                                                                                                                                                                                                                           | to be confirmed by hand (the route exists; the rehearsal did not complete the parent form)                                                                   |
| 12  | **Carry-in (opening balance)**   | recording creates a row with `status` pending review and **no invoice**; approval records `reviewed_by` + `reviewed_at` and refuses when recorder = approver; posting creates exactly one invoice of `signed_amount_kobo` against a **past** term, and **`Σ total_kobo` for the current term must not change**; reversing a posted carry-in voids that invoice, appends a reason, leaves the approval history intact | to be confirmed by hand; `e2e/opening-balances.spec.ts` and `tests/db/opening-balance-rules.test.ts` cover record/approve/post on the seeded database        |
| 13  | Reversal                         | a `reversals` row is appended; the allocation's status becomes reversed, not deleted; `invoice.paid_kobo` falls by the reversed amount; the payment's `unallocated_kobo` rises by it (or the payment becomes reversed); billed never changes; a receipt issued earlier stays visible with its void state                                                                                                             | to be confirmed by hand (panel reached, confirm control not identified); the arithmetic itself is covered by `tests/db/financial-invariants.test.ts`         |
| 14  | Reconciliation                   | a case exists per payment needing a decision; matching to an invoice records `basis`, `decided_by`, `decided_at`; resolving changes **no** balance — the balances remain what payments/allocations/invoices say; `reconciliation_cases` count for the school decreases only via resolve/close                                                                                                                        | queue rows measured (the rehearsal's unallocated credit appeared with "₦10,000.00 unallocated · UNMATCHED 0 evidence"); the match click path to be confirmed |
| 15  | Reporting                        | dashboard Billed / Collected / Outstanding equal `Σ total`, `Σ paid`, `Σ (total − paid)` over non-void invoices, converted to naira; the "all terms" figure includes carry-in while "this term" does not; `/debtors` contains exactly the pupils with `Σ(total − paid) > 0`, ranked by age of the oldest open invoice; a pupil's statement prints the same numbers as the ledger                                     | measured for the dashboard and the debtors list                                                                                                              |
| 16  | Waiver / concession              | a waiver row exists with reason + note; `invoice.total_kobo` is **not** silently rewritten; outstanding reflects the concession through the documented path only                                                                                                                                                                                                                                                     | not rehearsed — out of the first pilot's scope unless the school asks                                                                                        |

## 3. Invariants to check every day (all five were 0 throughout the rehearsal)

```sql
-- 1 header vs lines        2 paid vs allocations        3 overpaid
select count(*) from invoices i left join invoice_lines l on l.invoice_id=i.id
 where i.organization_id=:org group by i.id having i.total_kobo <> coalesce(sum(l.amount_kobo),0);
select count(*) from invoices i left join payment_allocations pa on pa.invoice_id=i.id
 left join payments p on p.id=pa.payment_id and p.status<>'REVERSED'
 where i.organization_id=:org
 group by i.id having i.paid_kobo <> coalesce(sum(pa.amount_kobo),0);
select count(*) from invoices where organization_id=:org and paid_kobo > total_kobo and status<>'VOID';
-- 4 payment split          5 orphan receipts
select count(*) from payments p left join payment_allocations pa on pa.payment_id=p.id
 and pa.status<>'REVERSED' where p.organization_id=:org
 group by p.id having p.amount_kobo <> p.unallocated_kobo + coalesce(sum(pa.amount_kobo),0);
select count(*) from receipts r left join payments p on p.id=r.payment_id
 where r.organization_id=:org and p.id is null;
```

Plus two counts that must agree every day, in writing, on the pilot sheet:

- `Σ payments.amount_kobo (CONFIRMED)` **==** the bank/cash statements for the same period;
- `Σ payment_allocations.amount_kobo` **==** `Σ invoices.paid_kobo`.

## 4. Discrepancy rule

Any non-zero result above, or any disagreement between the sheet and the screen:

1. stop billing and stop recording payments against the affected pupil;
2. write the numbers down before changing anything (screenshots of the invoice, the payment and the
   statement);
3. find the row that differs — never "correct" a total directly;
4. if the fix needs an edit to money, it is a **reversal plus a new record**, appended, with a reason;
5. no school is onboarded while an unexplained discrepancy is open, and no pilot sign-off happens with
   one outstanding.

The ledger code that enforces these invariants is protected: it is not edited to make a discrepancy
disappear. If a discrepancy turns out to be a real defect in the product, that is a bug report to me,
not a manual SQL fix.
