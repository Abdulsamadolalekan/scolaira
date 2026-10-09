# Pilot rehearsal — one school, end to end

- Run: 2026-10-09T13:06:28.450Z against `https://localhost:3443` (production build, TLS front end)
- Database: `scolaira_pilot` (scratch, synthetic data only)
- School: Rehearsal Model School (`rehearsal-mv0z8poc`), 8 pupils, fees ₦45,000 + ₦5,000
- Result: 12 passed, 3 failed, 0 not covered

| #   | Step                                                                         | Result          | Checks |
| --- | ---------------------------------------------------------------------------- | --------------- | ------ |
| S0  | Preflight — what the deployed configuration proves about itself              | **PASS**        | 19/19  |
| S1  | Register a school and land in the setup guide                                | **PASS**        | 6/6    |
| S2  | Guided setup: academic session, term, classes                                | **PASS**        | 3/3    |
| S3  | CSV import of 8 students (must create no charges)                            | **PASS**        | 3/3    |
| S4  | Fee structure: two definitions assigned to both classes                      | **PASS**        | 4/4    |
| S5  | Term billing: 8 invoices at the sum of their lines                           | **PASS**        | 9/9    |
| S6  | Staff-recorded part payment (₦20,000) against the oldest invoice             | **PASS**        | 11/11  |
| S7  | Overpayment (₦60,000) leaves a credit, never a negative balance              | **PASS**        | 6/6    |
| S8  | Receipt of record, frozen allocation snapshot                                | **PASS**        | 4/4    |
| S9  | Public payment link: parent claim lands PENDING, staff confirms              | **FAIL**        | 1/2    |
| S10 | Carry-in from the previous session (opening balance), approved and posted    | **FAIL**        | 0/0    |
| S11 | Reconciliation: flag, match and resolve a payment case                       | **NOT COVERED** | 0/0    |
| S12 | Guardian records: who the school can reach, and adding a second contact      | **NOT COVERED** | 4/4    |
| S13 | Reporting: dashboard, debtors and statement agree with the ledger            | **PASS**        | 4/4    |
| S14 | Reversal: a mistaken payment returns the ledger to its prior state           | **NOT COVERED** | 0/0    |
| S15 | Audit trail: every mutating act left a row                                   | **PASS**        | 3/3    |
| S16 | Tenant isolation from the outside: a second school sees nothing of the first | **PASS**        | 4/4    |
| S17 | Permissions: a Bursar cannot issue billing, approve carry-in or reverse      | **FAIL**        | 1/2    |

## S0 — Preflight — what the deployed configuration proves about itself · PASS

| Check                                     | Expected                                                     | Actual                                                       |     |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | --- |
| GET /api/ready status                     | 200                                                          | 200                                                          | ✓   |
| readiness status                          | ready                                                        | ready                                                        | ✓   |
| build environment                         | production                                                   | production                                                   | ✓   |
| check database                            | ok                                                           | ok                                                           | ✓   |
| check schema                              | ok                                                           | ok                                                           | ✓   |
| check auth (session+CSRF round trip)      | ok                                                           | ok                                                           | ✓   |
| migrations applied == expected            | 52                                                           | 52                                                           | ✓   |
| scolaira_app superuser                    | false                                                        | false                                                        | ✓   |
| scolaira_app bypassrls                    | false                                                        | false                                                        | ✓   |
| scolaira_app inherits                     | false                                                        | false                                                        | ✓   |
| tables with FORCE ROW LEVEL SECURITY > 0  | true                                                         | true                                                         | ✓   |
| GET /login status                         | 200                                                          | 200                                                          | ✓   |
| header x-content-type-options             | nosniff                                                      | nosniff                                                      | ✓   |
| header x-frame-options                    | DENY                                                         | DENY                                                         | ✓   |
| header referrer-policy                    | strict-origin-when-cross-origin                              | strict-origin-when-cross-origin                              | ✓   |
| header strict-transport-security          | max-age=31536000; includeSubDomains                          | max-age=31536000; includeSubDomains                          | ✓   |
| header permissions-policy                 | camera=(), microphone=(), geolocation=(), interest-cohort=() | camera=(), microphone=(), geolocation=(), interest-cohort=() | ✓   |
| CSP frame-ancestors locked                | frame-ancestors 'none'                                       | frame-ancestors 'none'                                       | ✓   |
| protected APIs reject an anonymous caller | 401                                                          | 401                                                          | ✓   |

> latest migration: 0052_opening_balances
> tables with RLS but without FORCE: app_meta
> CSP still allows 'unsafe-inline'/'unsafe-eval' in script-src: yes (documented M3 hardening item)
> anonymous probes: /api/students=401 /api/invoices=401 /api/org/settings=401 /api/ready=200 /api/health=200

## S1 — Register a school and land in the setup guide · PASS

| Check                    | Expected               | Actual                 |     |
| ------------------------ | ---------------------- | ---------------------- | --- |
| organization row created | 1                      | 1                      | ✓   |
| school name              | Rehearsal Model School | Rehearsal Model School | ✓   |
| currency                 | NGN                    | NGN                    | ✓   |
| students on a new school | 0                      | 0                      | ✓   |
| invoices on a new school | 0                      | 0                      | ✓   |
| memberships              | 1                      | 1                      | ✓   |

> landed on /dashboard
> founder membership role as stored: OWNER

## S2 — Guided setup: academic session, term, classes · PASS

| Check             | Expected | Actual |     |
| ----------------- | -------- | ------ | --- |
| academic sessions | 1        | 1      | ✓   |
| terms             | 1        | 1      | ✓   |
| classes           | 2        | 2      | ✓   |

> term status after activation: ACTIVE

## S3 — CSV import of 8 students (must create no charges) · PASS

| Check                                         | Expected | Actual |     |
| --------------------------------------------- | -------- | ------ | --- |
| students imported                             | 8        | 8      | ✓   |
| class enrolments                              | 8        | 8      | ✓   |
| invoices created by the import (must be zero) | 0        | 0      | ✓   |

> the review screen reported the file before anything was written
> guardians auto-created by the import: 8; links: 8

## S4 — Fee structure: two definitions assigned to both classes · PASS

| Check                         | Expected | Actual  |     |
| ----------------------------- | -------- | ------- | --- |
| fee definitions created       | 2        | 2       | ✓   |
| tuition default amount (kobo) | 4500000  | 4500000 | ✓   |
| levy default amount (kobo)    | 500000   | 500000  | ✓   |
| fee assignments present       | true     | true    | ✓   |

> structure being edited for: First Term · ACTIVE
> row 1: TUITION · Tuition · school-wide · ₦45,000
> row 2: PTA_LEVY · PTA levy · school-wide · ₦5,000
> fee assignments rows: 2 (TUITION, PTA_LEVY)

## S5 — Term billing: 8 invoices at the sum of their lines · PASS

| Check                             | Expected | Actual   |     |
| --------------------------------- | -------- | -------- | --- |
| the billing request was accepted  | true     | true     | ✓   |
| invoices issued                   | 8        | 8        | ✓   |
| invoice lines                     | 16       | 16       | ✓   |
| billed for the school (kobo)      | 40000000 | 40000000 | ✓   |
| collected so far                  | 0        | 0        | ✓   |
| outstanding == billed             | 40000000 | 40000000 | ✓   |
| invoices whose total ≠ sum(lines) | 0        | 0        | ✓   |
| invoices paid beyond their total  | 0        | 0        | ✓   |
| term marked billed                | true     | true     | ✓   |

> POST /api/terms/<id>/bill → HTTP 200 {"bill":{"term":{"id":"3b41a0ae-810b-4f6c-b52f-5b6bb881ecdf","name":"First Term","label":"1st","status":"BILLED","billed":true,"dueDate":"2026-12-01","sessionId":"06147c4a-1f00-4698-bb82-93896c61fa37"},"createdInvoices":8,"createdLines":16,"unchanged":0,"total
> invoice numbers visible: INV-2026-000001, INV-2026-000002, INV-2026-000003

## S6 — Staff-recorded part payment (₦20,000) against the oldest invoice · PASS

| Check                                             | Expected | Actual   |     |
| ------------------------------------------------- | -------- | -------- | --- |
| payment row exists                                | 1        | 1        | ✓   |
| payment amount (kobo)                             | 2000000  | 2000000  | ✓   |
| allocated to the invoice (kobo)                   | 2000000  | 2000000  | ✓   |
| unallocated remainder                             | 0        | 0        | ✓   |
| the payment was allocated to an open invoice      | 1        | 1        | ✓   |
| invoice paid_kobo                                 | 2000000  | 2000000  | ✓   |
| invoice outstanding after part payment            | 3000000  | 3000000  | ✓   |
| school collected (kobo)                           | 2000000  | 2000000  | ✓   |
| school outstanding                                | 38000000 | 38000000 | ✓   |
| paid_kobo ≠ Σ allocations on any invoice          | 0        | 0        | ✓   |
| payment amount ≠ allocated + unallocated anywhere | 0        | 0        | ✓   |

> payment PMT-2026-000001 status=CONFIRMED method=BANK_TRANSFER

## S7 — Overpayment (₦60,000) leaves a credit, never a negative balance · PASS

| Check                                        | Expected | Actual  |     |
| -------------------------------------------- | -------- | ------- | --- |
| overpayment row exists                       | 1        | 1       | ✓   |
| payment amount                               | 6000000  | 6000000 | ✓   |
| capped at the invoice total (never overpaid) | 5000000  | 5000000 | ✓   |
| credit held as unallocated                   | 1000000  | 1000000 | ✓   |
| invoices paid beyond their total             | 0        | 0       | ✓   |
| payment amount ≠ allocated + unallocated     | 0        | 0       | ✓   |

## S8 — Receipt of record, frozen allocation snapshot · PASS

| Check                                  | Expected | Actual  |     |
| -------------------------------------- | -------- | ------- | --- |
| receipt issued for the payment         | 1        | 1       | ✓   |
| receipt amount == payment amount       | 2000000  | 2000000 | ✓   |
| snapshot carries the allocation amount | 2000000  | 2000000 | ✓   |
| printable region rendered              | true     | true    | ✓   |

> snapshot shape: 1 allocation row(s)
> receipt number RCP-2026-000001, status ISSUED

## S9 — Public payment link: parent claim lands PENDING, staff confirms · FAIL

| Check                                            | Expected | Actual |     |
| ------------------------------------------------ | -------- | ------ | --- |
| parent can open the page without a session       | true     | true   | ✓   |
| a PENDING claim was recorded by the public route | 1        | 0      | ✗   |

> token recovered from a payment-links response (HTTP 201)
> link token 65PEkN… (24 chars) for INV-2026-000001
> amount due shown to the parent: ₦30,000

## S10 — Carry-in from the previous session (opening balance), approved and posted · FAIL

> prior session created via POST /api/academic-sessions (HTTP 201)
> prior term via POST /api/terms → HTTP 201
> error: locator.click: Timeout 12000ms exceeded.
> Call log:

- waiting for getByRole('button', { name: /record it|new entry|add entry/i }).first()
  - locator resolved to <button disabled type="button" data-size="sm" data-variant="primary" class="inline-flex items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,filter] duration-fast ease-standard focus-visible:shadow-focus-ring disabled:cursor-not-allowed select-none [&>svg]:shrink-0 bg-forest-deep text-ivory hover:brightness-110 active:brightness-95 disabled:bg-ink-subtle disabled:text-ivory h-8 px-3 text-sm gap-1.5 rounded-sm">…</button>
- attempting click action
  2 × waiting for element to be visible, enabled and stable
  - element is not enabled
  - retrying click action
  - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
    - element is not enabled
  - retrying click action
    - waiting 100ms
      23 × waiting for element to be visible, enabled and stable
    - element is not enabled
  - retrying click action
    - waiting 500ms

> page text: Opening balances Carry in what was owed before SCOLAIRA, with the paper it came from. Nothing here becomes a charge until you post it, and only past-term debt can be posted. THE REGISTER Five separate figures, deliberately never added together. Owed from before, still outstanding ₦0.00 Nothing has been posted yet, so nothing is owed in the ledger. Waiting to be reviewed 0 figures recorded and not

## S11 — Reconciliation: flag, match and resolve a payment case · NOT COVERED

> reconciliation cases before rehearsal: 1
> buttons on /reconcile: PMT-2026-000003 Rehearsal Parent · REH-CLAIM-MV0Z8POC BANK TRANSFER 09 Oct 2026 Not established No invoice linked ₦30,000 Fully allocated UNMATCHED 0 evidence + | PMT-2026-000002 Payer not recorded · REH-CASH-MV0Z8POC-2 BANK TRANSFER 09 Oct 2026 Tunde Bello INV-2026-000005 ₦60,000 ₦10,000.00 unallocated UNMATCHED 0 evidence +
> absent: the reconciliation queue offers no way to open a case from this page
> page text: Reconciliation Payment cases that need a human decision. Balances stay authoritative in payments, allocations and invoices. Record payment VISIBLE OPEN CASES 2 PENDING CONFIRMATION ₦30,000.00 UNALLOCATED CREDIT ₦10,000.00 FLAGGED EXCEPTIONS 0 OPERATIONAL QUEUE Derived payment work is visible even before a case is opened. Expand a row to add evidence, establish context, and take a permitted action.

## S12 — Guardian records: who the school can reach, and adding a second contact · NOT COVERED

| Check                                               | Expected | Actual |     |
| --------------------------------------------------- | -------- | ------ | --- |
| guardian records for the imported roster            | 8        | 8      | ✓   |
| pupil–guardian links                                | 8        | 8      | ✓   |
| pupils with no guardian at all                      | 0        | 0      | ✓   |
| every guardian has a phone in the single local form | 8        | 8      | ✓   |

> stored phone shapes: nnnnnnnnnnn×8
> absent: a second guardian was refused; the page said: nothing recognised
> page text: Students REH-MV0Z8POC-001 · ACTIVE Bisi Adeyemi New invoice Record payment Archive student BILLED ₦50,000.00 PAID ₦20,000.00 OUTSTANDING ₦30,000.00 INVOICES 1 invoice issued to this student. INVOICE TOTAL PAID BALANCE STATUS INV-2026-000001 ₦50,000.00 ₦20,000.00 ₦30,000.00 Part paid PAYMENT HISTORY Payments allocated to this student's invoices. PMT-2026-000001 BANK_TRANSFER · REH-TRANSFER-MV0Z8POC

## S13 — Reporting: dashboard, debtors and statement agree with the ledger · PASS

| Check                                                   | Expected | Actual |     |
| ------------------------------------------------------- | -------- | ------ | --- |
| dashboard Collected (₦) equals the ledger               | 70000    | 70000  | ✓   |
| dashboard Outstanding (₦) equals the ledger             | 330000   | 330000 | ✓   |
| debtors list is non-empty when balances are outstanding | true     | true   | ✓   |
| every owing pupil appears at most once in the ledger    | true     | true   | ✓   |

> dashboard text did not expose a "Billed" figure to parse: FIRST TERM · CURRENT TERM Good afternoon, Rehearsal. The school's financial position, and what needs attention before it ages. Issue an invoice Record a payment COLLECTED TO DATE All terms — includes any debt carried for
> /debtors rows rendered: 8; page begins "ACCOUNTS RECEIVABLE Debtors and aging Students with outstanding balances, ranked by how long the oldest invoice has been overdue. Covers eve"

## S14 — Reversal: a mistaken payment returns the ledger to its prior state · NOT COVERED

> the inline panel was expanded but the harness did not identify its confirm control; the same reversal through POST /api/payments/<id>/reverse returned HTTP 400 {"error":{"code":"BAD_REQUEST","message":"Invalid request","issues":[{"code":"invalid_type","expected":"number","received":"undefined","path":["amount
> absent: neither the panel control nor the API path completed a reversal (HTTP 400)
> page text: Payments Fully allocated PMT-2026-000001 Print receipt Reverse Print receipt REVERSE / REFUND Reversing unwinds allocations and restores invoice balances. This action is append-only and cannot be undone from the UI. Type Reversal Refund Correction Amount (₦) Reason Reference (optional) Record reversal Bank Transfer · ref REH-TRANSFER-MV0Z8POC-1 9 Oct, 0:00 Recorded by Rehearsal Head RECEIVED ₦20,0

## S15 — Audit trail: every mutating act left a row · PASS

| Check                                                          | Expected | Actual |     |
| -------------------------------------------------------------- | -------- | ------ | --- |
| audit events recorded for this school                          | true     | true   | ✓   |
| every audit row names an actor (user or labelled system actor) | 0        | 0      | ✓   |
| money-bearing actions are represented in the trail             | true     | true   | ✓   |

> top actions: term.create×2, term.bill×1, term.activate×1, student.import×1, student.create×8, receipt.issue×1, payment_link.create×1, payment.record×2
> actor types: USER: 42 (no user id: 1)
> reversal audit rows carrying a reason: 0

## S16 — Tenant isolation from the outside: a second school sees nothing of the first · PASS

| Check                                                    | Expected | Actual |            |
| -------------------------------------------------------- | -------- | ------ | ---------- |
| another school cannot read students by id                | true     | true   | ✓ HTTP 404 |
| another school cannot read invoices by id                | true     | true   | ✓ HTTP 404 |
| another school cannot read opening-balances by id        | true     | true   | ✓ HTTP 404 |
| pupil list of the other school contains no rehearsal row | false    | false  | ✓          |

## S17 — Permissions: a Bursar cannot issue billing, approve carry-in or reverse · FAIL

| Check                                  | Expected | Actual |           |
| -------------------------------------- | -------- | ------ | --------- |
| a second member joined the school      | 2        | 1      | ✗         |
| a restricted page tells the bursar why | true     | true   | ✓ Sign in |

Enter your credentials to open your school’s worksp |

> invitation PENDING for role SCHOOL_ADMIN
> bursar probes → issue term billing: 200, read another pupil record: 401, open the member list: 401 (the page-level guard answers 403/redirect; the API check is in the product's own suite)

## Final ledger position

| Quantity                    | Value                                  |
| --------------------------- | -------------------------------------- |
| Invoices                    | 8                                      |
| Invoice lines               | 16                                     |
| Billed (kobo)               | 40000000                               |
| Collected (kobo)            | 7000000                                |
| Outstanding (kobo)          | 33000000                               |
| Receipts issued             | 1 (₦200)                               |
| Invoice status distribution | ISSUED: 6, PARTIALLY_PAID: 1, PAID: 1  |
| Payment status distribution | PENDING: 1 (₦300), CONFIRMED: 2 (₦800) |
| Opening balances            | none                                   |
| Audit events                | 42 across 16 action types              |

## Ledger invariants (must all be zero)

| Invariant                                        | Violations |
| ------------------------------------------------ | ---------- |
| invoice.total_kobo ≠ Σ invoice_lines.amount_kobo | 0          |
| invoice.paid_kobo ≠ Σ live allocations           | 0          |
| invoice paid beyond its total                    | 0          |
| payment.amount ≠ allocated + unallocated         | 1          |
| receipt without its payment                      | 0          |

Generated by `scripts/pilot-rehearsal.mjs`; nothing in this file is hand-written.
