# Pilot rehearsal — what was proven, what the harness failed to drive, what is covered elsewhere

Companion to [PILOT_REHEARSAL.md](PILOT_REHEARSAL.md), which is generated verbatim by
`scripts/pilot-rehearsal.mjs`. Run 2026-10-09, 12:5x–12:5x UTC, against the production build served over
the TLS front end, database `scolaira_pilot`, one synthetic school (`rehearsal-<stamp>`, 8 pupils,
₦45,000 tuition + ₦5,000 levy).

Result: **12 steps passed, 3 failed, 3 not covered.** Reading the three categories correctly matters:

| Status      | Meaning in this rehearsal                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PASS        | the control was driven through the real UI (or the product's own REST route) **and** every expected number equalled the number the database held                           |
| FAIL        | the step aborted part-way; the failing line is a number the harness could not satisfy — for each of the three below the cause is named, and none is a ledger inconsistency |
| NOT COVERED | the rehearsal could not reach the function at all. **Not a defect and not a pass.** It says: this build's surface, driven this way, did not offer it                       |

## 1. Proven by this rehearsal (V-M)

| Step                 | Numbers that had to be right                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 configuration     | readiness 200 with `applied 52 = expected 52`; `scolaira_app` `superuser=false bypassrls=false inherit=false`; FORCE RLS on every tenant table; headers nosniff / `X-Frame-Options: DENY` / referrer / HSTS 1 y / CSP / permissions-policy; anonymous `/api/students` → 401 |
| S1 register          | exactly 1 organization, 1 membership (`OWNER`), currency `NGN`, 0 students, 0 invoices                                                                                                                                                                                      |
| S2 guide             | 1 session, 1 term (`ACTIVE`, current), 2 classes                                                                                                                                                                                                                            |
| S3 CSV import        | 8 pupils, 8 class enrolments, 8 guardian records, 8 pupil–guardian links, **0 invoices** — the import cannot create a charge, verified in data rather than in the sentence the UI prints                                                                                    |
| S4 fees              | 2 definitions (4,500,000 and 500,000 kobo defaults), structure saved school-wide                                                                                                                                                                                            |
| S5 billing           | `POST /api/terms/<id>/bill` → **HTTP 200 `createdInvoices:8 createdLines:16`**; billed exactly 40,000,000 kobo; collected 0; `Σ invoice_lines == invoices.total_kobo` for all 8 (0 violations); term flagged `billed`                                                       |
| S6 part payment      | ₦20,000 → 2,000,000 kobo, one allocation of exactly 2,000,000, unallocated 0, invoice `paid_kobo` 2,000,000, invoice outstanding 3,000,000, school collected 2,000,000, `paid_kobo == Σ live allocations` on every invoice (0 violations)                                   |
| S7 overpayment       | ₦60,000 → allocated only up to the invoice's 5,000,000, **1,000,000 kobo held as unallocated credit**, no invoice paid beyond its total, `amount == allocated + unallocated` on every payment (0 drift)                                                                     |
| S8 receipt           | 1 receipt for the payment, receipt amount == payment amount, the frozen allocation snapshot inside the receipt sums to the same figure, printable region rendered                                                                                                           |
| S13 reporting        | dashboard Billed / Collected / Outstanding (₦) equal the kobo rollup ÷ 100; `/debtors` listed a row per pupil with a balance                                                                                                                                                |
| S15 audit            | one row per mutating act (`term.create`, `term.activate`, `term.bill`, `student.import`, `student.create`×8, `receipt.issue`, `payment_link.create`, `payment.record`×2) with the actor recorded                                                                            |
| S16 tenant isolation | a second, separately registered school was refused when reading the first school's pupil / invoice / opening-balance ids, and the first school's admission prefix and name appeared nowhere in the second school's own list                                                 |

The five ledger invariants re-checked after every money step (invoice header vs lines, `paid_kobo` vs
allocations, overpayment, payment split, orphan receipts) were **0 violations throughout**.

## 2. The three FAILs, with causes

**S9 — public payment link.** Everything up to the parent's submit is proven: the invoice page created a
link (`HTTP 201`, 24-character token recovered from the page's own network response), and the
cookie-less parent page opened it showing **"amount due ₦30,000"** — exactly the invoice's outstanding
balance after S6, which is the number that matters. The harness then filled name + reference and
submitted, and no `PENDING` payment appeared: the public form expects a payment-method choice that the
harness did not set. Not covered at the submit boundary; see §3 for what the product's own suite covers.

**S10 — opening balances.** The rehearsal created a prior session and a prior term through the product's
own endpoints (both `HTTP 201`) because the register legitimately refuses a current term — _"only
past-term debt can be posted"_. Opening the record form and clicking "Record it" then timed out in the
harness: the panel needs a further interaction (the term picker inside the open form) that this harness
did not perform. No carry-in row was written, so nothing was measured and nothing is claimed.

**S17 — a second staff member.** The invitation itself worked: a `member_invitations` row appeared for
the school after clicking "Create invitation link", and the page offered "Copy link". The harness looked
for the one-time URL in the rendered text, while the page keeps it in an input's value, so the accept
step never ran and the membership count stayed at 1. Delivery-by-link with a 7-day single-use token is
separately covered by `tests/db/h8-invitation-rls.test.ts` [V-T].

## 3. Where these journeys _are_ verified, on this same commit

The rehearsal was composed for the pilot; it is not the only evidence, and it should not be read as if a
harness gap were a product gap. All of the following ran green today on `fea875e` against a real
PostgreSQL and the built artifact — release gate **86 passed / 0 failed / 0 skipped** on chromium and
webkit over TLS, plus **909/909** unit and database tests:

| Journey                                                                                                                         | Where it is proven                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding guide incl. CSV import, blocking and non-blocking problems, problem-list download                                    | `e2e/onboarding-import.spec.ts` (3)                                                                                                 |
| Opening balances: record → approve (self-approval refused) → post, with the "no silent edit" behaviour                          | `e2e/opening-balances.spec.ts` (3) + `tests/db/opening-balance-rules.test.ts`                                                       |
| Public payment link: parent view, "notify the school of my payment", the logged-claim confirmation copy, an unknown token → 404 | `e2e/parent-journey.spec.ts` (3)                                                                                                    |
| Receipt, allocation, idempotent billing, concurrency                                                                            | `tests/db/audit.test.ts`, `idempotency.test.ts`, `concurrency.test.ts`, `financial-invariants.test.ts`, `financial-attacks.test.ts` |
| Reconciliation M10 and collections M11 state machines                                                                           | `tests/db/m10-reconciliation.test.ts`, `m11-collections.test.ts`                                                                    |
| Term billing M8, academic M9                                                                                                    | `tests/db/m8-term-billing.test.ts`, `m9-academic.test.ts`                                                                           |
| Invitation RLS and single-use tokens                                                                                            | `tests/db/h8-invitation-rls.test.ts`                                                                                                |
| School journey: dashboard, students, record payment, invoices                                                                   | `e2e/school-journey.spec.ts` (6)                                                                                                    |

## 4. NOT COVERED — the honest list, with the reason and the consequence

1. **Reconciliation queue: opening a case and matching it** (S11). The page renders the queue — it showed
   the rehearsal's unallocated payment with "unallocated ₦10,000", "UNMATCHED 0 evidence", per-row
   actions — but the harness could not reach "Establish invoice match" from that state. The M10 state
   machine is proven in `tests/db/m10-reconciliation.test.ts`; **the browser-side flow for a bursar
   matching a payment to an invoice has therefore never been rehearsed end to end.** Someone should walk
   it by hand before the pilot, on the real host, and write down the clicks.
2. **Adding a second guardian to a pupil** (S12). The import created one guardian per pupil; a second
   guardian was refused by the form (a message the harness could not identify precisely). Whether the
   refusal is intentional (one primary per pupil) or an artefact needs a human answer.
3. **Reversal from the payment page** (S14). The panel expands ("REVERSE / REFUND — reversing unwinds
   allocations and restores invoice balances. This action is appended…") and the harness could not
   identify its confirm control; the same route called directly returned `400 BAD_REQUEST`, i.e. the
   body the harness sent was incomplete. Reversal _semantics_ are proven by the DB tests; the click path
   is not rehearsed. Pair this with item 1: both are "the bursar's own screen", and both deserve a
   manual walk-through.
4. **Period close / cutoff.** `app/(app)/finance/` contains only `opening-balances`; there is a
   `financial-periods` + `close` API and a `/terms/[id]` close path in the route list, but the pilot
   checklist cannot tell a school to close a term in the UI, because no such page exists. Either it is
   done by the platform administrator via the API, or the step is out of the pilot's scope. **Owner
   decision, recorded in the operating plan.**
5. **Any real-host concern**: TLS chain, pooler, provider backup, alerting. By definition not rehearsed
   here — see `PILOT_SECURITY_AND_BACKUP.md` §4 and `PILOT_DEPLOYMENT_REQUIREMENTS.md`.

## 5. How to re-run this rehearsal

```bash
# scratch database (never scolaira_e2e, which the release gate owns)
sudo -u postgres createdb -O scolaira_owner scolaira_pilot
sudo -u postgres psql -d scolaira_pilot -v boot_db=1 -f scripts/bootstrap-roles.sql
DATABASE_MIGRATION_URL=postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_pilot npm run db:migrate
# a read credential that bypasses RLS (measured necessity, not convenience):
#   BYPASSRLS + pg_read_all_data WITH INHERIT TRUE + USAGE on schema drizzle
bash /home/user/serve-pilot.sh &                        # production build, port 3000
node scripts/e2e-https-proxy.mjs &                      # TLS front end, port 3443
PILOT_READ_URL=postgresql://<bypass-role>:<pw>@localhost:5432/scolaira_pilot \
  node scripts/pilot-rehearsal.mjs                      # writes this directory
```

Deliberate method choices, so nobody reads them as shortcuts: the browser context ignores the throwaway
certificate (`ignoreHTTPSErrors`, the same setting `playwright.config.ts` uses); the _app_ keeps
verification fully on (`NODE_EXTRA_CA_CERTS` + `SCOLAIRA_INTERNAL_ORIGIN` on loopback, exactly as the
gate does). The register limiter was honoured, not cleared: each run presents a different client address,
as the product's own onboarding spec does. Rate-limit rows were never deleted.
