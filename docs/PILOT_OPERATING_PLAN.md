# Controlled pilot — operating plan for one school

Scope: **one approved school**, synthetic rehearsal first, real records second. No Paystack, no
automated settlement, no payment provider calls (see §9). Nothing here deploys anything: the hosting and
configuration decisions in [PILOT_DEPLOYMENT_REQUIREMENTS.md](PILOT_DEPLOYMENT_REQUIREMENTS.md) §6 come
first.

## 1. Before the school is invited (owner + I, one session)

- [ ] Host provisioned per D-1…D-5; `pgcrypto` enabled; roles bootstrapped; 52 migrations applied
- [ ] `SCOLAIRA_BUILD_COMMIT` set to the deployed sha; `TRUSTED_PROXY_HOPS=1`; both dev-only flags absent
- [ ] TLS valid for the exact origin; sign-in tested from a phone on mobile data, not just the laptop
- [ ] `GET /api/ready` returns `status:"ready"` through the public hostname; external check on it, alerting to a named person
- [ ] Nightly `pg_dump` running **and copied off the machine**, with the backup credential that the drill proved is required (`BYPASSRLS`, `pg_read_all_data` **`WITH INHERIT TRUE`**, `USAGE`+`SELECT` on `drizzle`)
- [ ] Restore drill re-run **against the provider instance** and its transcript filed (the local one passed: `ok=true passed=10 failed=0 skipped=0`)
- [ ] Platform administrator address chosen (D-7); carry-in approval depends on it existing
- [ ] Written answers to D-6 (password reset) and D-9 (lawful basis, storage location, retention) on file
- [ ] The rehearsal re-run against the pilot host, same script, same pass criteria

## 2. Onboarding day (the school, in the product)

1. Owner registers the school (one registration per school — the register route allows 5 per hour per
   client address; if several schools onboard together, stagger them).
2. Guide: session → first term → activate → classes → **CSV import**.
   Import rule that must be said out loud: the file brings pupils and guardian contacts, **never charges**.
   Blocked rows are listed with line numbers; fix and re-upload. The problem list is downloadable.
3. Fees: define the school's fees, choose the term, save the structure school-wide or per class.
4. Billing: Review → confirm → **Issue term billing**. Check the preview count equals the roll count
   before issuing. Idempotent: a second issue adds nothing.
5. Carry-in: only past-term debt, with the paper reference for each figure; recorder and approver must
   be different people; posting is what creates the ledger document.
6. Staff: invite each bursar/clerk by link (single use, 7 days). Ownership is transferred, never invited.
7. Print one statement, one receipt. If they look wrong on paper, stop before any payment is recorded.

## 3. Roles to give out on day one

| Person                       | Role            | Can                                                                                   | Cannot                                                            |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Proprietor / principal       | Owner           | everything for the school, incl. billing, waivers, member invites, ownership transfer | approve their own carry-in                                        |
| Bursar                       | Finance Officer | fees, billing, record/reverse payments, receipts, reconciliation, carry-in posting    | invite members, transfer ownership, change school identity        |
| Clerk / front desk           | Staff (limited) | record a payment against a named pupil, print a receipt                               | edit fees, issue billing, reverse, close a period                 |
| Platform administrator (you) | platform        | approve carry-ins, support-mode actions on a named organisation                       | act as a normal tenant user; no in-app way to grant self the flag |

Verify by signing in as each role once, on the pilot day, and writing down what was refused. A refusal
that shows a clear reason is the correct behaviour (`permission-guard` + an access-denied screen).

## 4. Daily routine during the pilot (the bursar, ~10 minutes)

- [ ] Record every payment received that day, one row each, with the bank/cash reference in the reference field.
- [ ] Anything received against a pupil with no open invoice stays as **unallocated credit** — do not invent an invoice to absorb it.
- [ ] Reconcile: for each payment the queue lists, match it to the invoice with a written basis, or flag it with a reason. Never resolve a case "to clear the list".
- [ ] Count the five invariants in `PILOT_FINANCIAL_ACCEPTANCE.md` §3 (one SQL paste, or ask me for the query sheet).
- [ ] Compare the day's confirmed payments against the bank statement / cash count, and sign the sheet.
- [ ] Print or export the day's receipts for the file.

## 5. Support during the pilot

- One named person for the school (you, or me for product defects) and one channel (a phone number the
  bursar knows). No shared inbox.
- Known limits to state up front: no email delivery of any kind from this build; password reset has no
  channel (D-6); no automated reminders are sent (reminders exist as records in-app only); Paystack and
  any online collection are absent by design.
- Support-mode access to a school's data is an audited, explicit act by the platform administrator, and
  every entry/exit is recorded in `audit_events` — say this to the school in writing before it starts.

## 6. Incident handling

| Symptom                                               | First action                                                                                                                                                             | Who        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| A wrong payment was recorded                          | Reverse it with a reason and record the correct one. Never edit money in place                                                                                           | Bursar     |
| A pupil appears with the wrong balance                | Stop billing for that pupil; run the invariant queries; screenshot before changing anything                                                                              | Owner + me |
| `/api/ready` 503, or the site is down                 | Check the app process, then the database, then the migration count in the probe response. Do not migrate blind                                                           | You        |
| Data loss suspected                                   | Take the app out of rotation, keep the live database **untouched**, restore into a **new** database, verify, then repoint (runbook in `PILOT_SECURITY_AND_BACKUP.md` §7) | You        |
| A real pupil's data went in by mistake before go-live | Confirm what was imported; deleting a pupil is an archive action in-product, not a `DELETE`                                                                              | Owner      |
| Any discrepancy that cannot be explained in an hour   | **Suspend the pilot.** An unexplained ledger difference is a stop condition, not a backlog item                                                                          | You        |

## 7. Rollback

1. The app version is the only reversible piece: redeploy the previous build (`SCOLAIRA_BUILD_COMMIT`
   tells you which is live). There are **no down-migrations** — never roll the schema "back" by hand.
2. If the new build needs schema and that schema is wrong, the path is restore-forward: create a new
   database from a verified dump, then repoint.
3. Any rollback that touches money rows needs the incident note, the dump sha256, and the verification
   output filed with it.
4. The school is told within the same day, in plain words, what changed and what was lost.

## 8. Pilot completion (exit criteria)

- [ ] ≥ 20 school days with the ledger as the system of record for the fees in scope
- [ ] Zero unexplained ledger discrepancies at the end, and none open for longer than one day
- [ ] Daily reconciliation performed on ≥ 90% of days, signed
- [ ] Every staff member who should have an account has one, and no account that should not
- [ ] Carry-in balances reconciled with the school's own prior records, with the paper references on file
- [ ] Receipts and statements accepted as usable by the bursar (their judgement, in writing)
- [ ] A restore drill performed on the **live** instance during the pilot, evidence filed
- [ ] Incident log reviewed; each entry either fixed or explicitly accepted as a limitation
- [ ] Owner decision recorded: proceed to a second school / hold / stop

## 9. Payment limitations — what is deliberately not here

**Out of scope until implemented and separately verified: Paystack, any card/transfer API, webhooks,
automated settlement, automated reconciliation against a bank feed, and any provider-initiated
`CONFIRMED` status.** Verified today: the Paystack and Supabase variable names exist in
`lib/security/env.ts` as accessors with **no consumer**; no route in this build calls a payment provider,
and there is no webhook signature to verify because there is no webhook. This is stated so nobody
believes a half-built integration is live.

### The permitted staff-recorded cash / bank workflow

This is the only way money enters the ledger in the pilot. It records reality; it does not move money.

1. **Money arrives first**, outside the product: cash at the school, or a bank transfer to the school's
   account.
2. The bursar (or a delegated clerk) opens **Record payment** and enters: pupil, amount in naira, method
   (`CASH`, `BANK_TRANSFER`, `POS`…), the date actually received, and the **reference** — teller number,
   bank reference, or the POS slip number. The reference is what makes the daily reconciliation possible;
   a payment without one is a future argument.
3. The system allocates to the oldest open invoice for that pupil and holds any surplus as unallocated
   credit. It never over-applies and never creates an invoice.
4. A receipt is issued from the payment. The receipt freezes the allocation snapshot; if a reversal
   later lands, the receipt shows the void state rather than being rewritten.
5. If a family pays through the public link, that creates a **claim** (`PENDING`) and nothing more: no
   allocation, no balance change, no receipt. Staff check the money has actually arrived, then confirm
   it. The claim is de-duplicated by its reference so a retry does not double-count.
6. End of day: Σ confirmed payments must equal the bank/cash statement for that day. Anything else is
   the §6 discrepancy path.
7. A mistake is corrected by **reversal + re-record**, always with a reason, never by editing the row or
   the invoice total.

Two things the school must be told explicitly before starting: no money is collected or verified by
SCOLAIRA itself (a "confirmed" payment means _a named member of staff said they saw it_), and there is no
refund, dispute or chargeback machinery — a reversal is an appended accounting act, not money returning
to a family.
