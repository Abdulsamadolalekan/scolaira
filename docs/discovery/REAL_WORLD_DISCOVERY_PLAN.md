# Real-World Financial Workflow Discovery Plan

> Do not build a sophisticated reconciliation system around unvalidated assumptions.
> Before finalizing Reconciliation (Phase 3), we must observe and document how real schools and finance officers actually handle money.

This plan covers the workflows and edge cases called out by the founder (items 8a–z). Phase 1 (Financial Truth) proceeds on domain truths that are unlikely to change (money in = recorded; allocations ≤ outstanding; reversals preserve history; etc.). Reconciliation's intelligence, automation, and UX will be shaped by what we discover here.

---

## I. Goals

1. Observe at least one pilot school finance officer through at least one full billing cycle.
2. Document the *actual* flow of cash, transfers, POS, online payments, receipts, and reconciliations.
3. Identify edge cases that our current model misses or mis-models.
4. Validate or invalidate each assumption in `/docs/ASSUMPTIONS.md` that touches financial workflow.
5. Produce a validated blueprint for Reconciliation (Phase 3) before building it.

## II. Subjects

We need access to:

| Role | Why |
|---|---|
| Proprietor (decision-maker) | Understand what they *need* to know about money; what they do with Command Center information |
| Finance officer / bursar | Primary daily user; records payments, reconciles, issues receipts |
| School admin | May handle parent follow-ups, invoice sending, class lists |
| 3–5 parents (optional, but ideal) | Understand how they pay, what receipts they expect, what communication works |

Minimum viable: one school, one finance officer, one proprietor. Two schools is better.

## III. Methods

1. **Shadowing:** Sit (physically or via screen-share) with the finance officer during a busy payment period (first 2-3 weeks of term are peak collection). Observe without intervening.
2. **Artifact collection:** Collect samples of:
   - Existing invoices / bills
   - Hand-written or printed receipts
   - Bank tellers / POS slips / transfer screenshots
   - Bank statements (school's corporate account)
   - Current spreadsheet (if any)
   - Any existing software they use
3. **Semi-structured interview** with proprietor:
   - "When do you look at the numbers and what do you look for?"
   - "What surprises have you had — times the money was not what you expected?"
   - "What's the most painful part of fee collection for you?"
   - "How do you follow up on overdue accounts?"
4. **Semi-structured interview** with finance officer:
   - Walk through recording a cash payment end-to-end.
   - Walk through matching a bank transfer to a parent.
   - Walk through a POS transaction.
   - Walk through a day of collections, including cash-in-drawer reconciliation.
   - How do you handle a parent who says they paid but you don't see it?
   - How do you handle overpayments? Underpayments?
   - What happens if a sibling pays for two students?
   - How do you identify an anonymous bank transfer?
   - What do you do at end of day? End of week? End of term?
5. **Existing-data import:** With permission, export their current student list, invoice list, and payment history (even from spreadsheets). Use this to seed a realistic development dataset.
6. **Hypothetical scenario walkthroughs:** For each edge case in §IV, ask the finance officer how they'd handle it and what records they'd keep.
7. **Prototype feedback:** When a Phase 1 build exists, watch them attempt to complete tasks without coaching. Note friction points.

## IV. Workflow Domains to Investigate

For each item below we will document:
- How common it is (all the time / often / rare / never seen)
- How they handle it today (paper/spreadsheet/verbal)
- What the "ground truth" indicator is (teller? alert? parent's word?)
- Who is authorized to act
- What record they keep (receipt, note, entry in spreadsheet)
- What they do when there's a dispute
- How SCOLAIRA should handle it

### A. Payment methods
- Cash collection — denominations? cash drawer? who counts? who issues receipts?
- Bank transfers — which banks? how do they match alerts to students? what info is on the alert? is there a dedicated school account?
- POS — terminal at school? who operates? how are POS slips matched to student/child? do they settle same day?
- Online payments (Paystack/Flutterwave) — who sets up? any friction?

### B. Transaction edge cases
- One payment covering multiple students (siblings) — how often? how is it split today? who decides split?
- One payment covering multiple invoices (current + prior term)
- Previous-term debt — how tracked? is it bundled with current bill?
- Overpayments — kept as credit? refunded? applied to next term?
- Underpayments — partial payments accepted? how are balances tracked?
- Wrong-account payments (parent pays into old account / wrong account)
- Unidentified payments (anonymous transfer — what happens next? how long do they wait?)
- Duplicate payments (parent pays twice by mistake)
- Refunds — how are they issued? cash vs transfer? how documented?
- Reversals (corrections for error — when do they happen?)

### C. Discounts / Adjustments
- Discounts (sibling discount, early-payment discount, staff discount)
- Scholarships (full/partial, by term?)
- Fee waivers (e.g., hardship, proprietor discretion)
- Credit notes vs write-offs
- How these are authorized (proprietor sign-off? verbal?)

### D. Receipts & evidence
- Manual receipt books in use? format?
- How parent proves payment (paper receipt, SMS alert, WhatsApp screenshot?)
- What happens if a parent says "I paid but you have no record"?
- Do parents ever forge/alter receipts?

### E. Bank statement reconciliation
- How often do they compare bank statements to their own records?
- What tools do they use (bank app, paper statement, spreadsheet)?
- How long does it take?
- Common discrepancies (bank charges, reversals, unidentified lodgments)?

### F. Finance-officer daily workflow
- Start-of-day / end-of-day routine
- How they organize the collection queue (overdue list? class list?)
- Communication with class teachers / form masters about defaulters
- What the proprietor asks for and how often

### G. Proprietor review workflow
- Frequency of check-ins (daily? weekly? at will?)
- Key questions they ask
- Which reports they currently produce (if any)
- What they consider a "good" term vs a "problem" term
- How they make decisions (e.g., "send defaulters home") based on numbers

## V. Outputs of Discovery

1. **Workflow Map** — a documented end-to-end flow of money from parent to reconciled record, including authorizations and failure paths (disputes, unidentified, reversals).
2. **Validated/Invalidated Assumptions** — every assumption in `/docs/ASSUMPTIONS.md` that touches workflow is marked VALIDATED or INVALIDATED with evidence.
3. **Edge-case Register** — the actual frequency and handling of each edge case in §IV.
4. **Reconciliation Blueprint** — concrete design for the reconciliation queue, states, and actions that matches what finance officers actually do.
5. **Seeded Realistic Dataset** — for dev/test based on real (anonymized) school data.
6. **Design Changes** — list of UX/data changes required before Phase 3.
7. **Updated Decision Log** — any recommendations/changes from the above go through `/docs/DECISIONS.md`.

## VI. Timeline

- **Pilot identification:** D7, as soon as founder identifies school.
- **Pre-build interviews (Week 1 after pilot identified):** proprietor + finance officer, 60–90 min each; collect artifacts.
- **Shadowing during first billing cycle of pilot:** if possible, observe first 2 weeks of term; otherwise at minimum, a full week's reconciliation.
- **Parallel with Phase 1–2 build:** build the financial foundation on domain truths; interviews proceed in parallel so findings are ready when Phase 3 work begins.
- **Phase 3 gate:** Before building final Reconciliation UI, all outputs §V must be complete and reviewed by founder.

## VII. What We Will NOT Do During Discovery

- We will NOT redesign the system on the fly based on one school's idiosyncratic process. Findings inform priorities and workflows; they do not overturn invariants (kobo money, allocations ≤ outstanding, auditability, tenant isolation, etc.).
- We will NOT add academic/attendance features just because a school asks. SCOLAIRA owns the money; we integrate with other systems (§15).
- We will NOT build custom one-off workflows per school; we look for patterns, not snowflakes.
- We will NOT treat verbal answers as behavior; where possible, observe actual work rather than relying on self-report.

## VIII. Open Questions to Answer During Discovery

These are currently UNKNOWN items from `/docs/discovery/PRODUCT_DISCOVERY_BACKLOG.md` that directly affect reconciliation:

- U-01 through U-17 (financial workflow questions) will be marked VALIDATED/INVALIDATED after discovery.
