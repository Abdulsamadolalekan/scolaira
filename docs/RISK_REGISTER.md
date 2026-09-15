# SCOLAIRA — Risk Register

> Continuously updated. Risks are classified by likelihood, impact, and priority.

Scale:
- **Likelihood:** Low / Medium / High
- **Impact:** Low / Medium / High / Critical
- **Priority:** P0 (blocks safe operation) / P1 (blocks pilot quality) / P2 (follow-up) / P3 (later enhancement)

---

## R-001 — Financial Invariant Breach
- **Type:** Product / Financial / Technical
- **Description:** A bug causes silent over-allocation, missing payments, or incorrect outstanding balances.
- **Likelihood:** Medium (financial logic is complex; concurrency + multi-method payments increase risk).
- **Impact:** Critical — trust destruction, reconciliation failure, possible legal/commercial exposure.
- **Priority:** **P0**
- **Mitigations:** Integer kobo; DB triggers; service-layer invariants; exhaustive financial test matrix (FM-1..FM-32); code review on every financial change; invariant violation paging; post-deploy canary on real data before wide use.

## R-002 — Cross-Tenant Data Leak
- **Type:** Security
- **Description:** An IDOR or RLS misconfiguration exposes one school's data to another.
- **Likelihood:** Low-Medium (common failure mode in SaaS; must be actively defended).
- **Impact:** Critical — trust, regulatory, reputational.
- **Priority:** **P0**
- **Mitigations:** Application-level org scoping as primary; RLS as defense-in-depth; cross-tenant tests in CI (S-1, S-23, S-24); mandatory code review for query/scoping code; least-privilege DB roles.

## R-003 — Paystack Webhook Mis-processing
- **Type:** Technical / Financial
- **Description:** Duplicate, forged, out-of-order, or late webhooks produce double-counted or misallocated payments.
- **Likelihood:** Medium (webhook delivery is at-least-once in practice).
- **Impact:** Critical — phantom balances or missing revenue.
- **Priority:** **P0**
- **Mitigations:** HMAC verification; idempotency key table; explicit state machine; out-of-order events route to manual review; replay tests (FM-13, FM-16, S-7, S-8).

## R-004 — Low Digital Literacy Hurting Adoption
- **Type:** Business / UX
- **Description:** Finance officers or proprietors at pilot schools struggle to use the system; onboarding takes longer than the "one-day deployment" promise.
- **Likelihood:** Medium-High (real in Nigerian private schools).
- **Impact:** High — churn, bad word-of-mouth.
- **Priority:** **P1**
- **Mitigations:** On-site pilot onboarding for first schools; in-app cues in clear English; no jargon; mobile-friendly for finance officers on phones; invest in onboarding wizard simplicity; direct support line.

## R-005 — Reconciliation Workflow Doesn't Match Real Practice
- **Type:** Product
- **Description:** The reconciliation flow is designed from assumptions, not observation. School finance officers continue to use spreadsheets.
- **Likelihood:** Medium (without observation, software diverges from reality).
- **Priority:** **P1**
- **Mitigations:** Embed with pilot school's finance officer for at least one full billing cycle before finalizing the UI; observe how they match transfers, identify students, handle partial cash; iteratively adjust.

## R-006 — Pilot School Not Identified
- **Type:** Business
- **Description:** Engineering builds in a vacuum; no real-world feedback loop.
- **Likelihood:** Current (unknown at this moment) — see Unknown S6.
- **Impact:** High — product/market mismatch discovered late.
- **Priority:** **P1**
- **Mitigations:** Founder to identify one pilot school early; sign a simple pilot agreement; co-design sessions weekly.

## R-007 — Network / Device Reality
- **Type:** UX / Technical
- **Description:** Finance officers use cheap Android phones on unreliable networks; slow-loading screens or large JS bundles break usability.
- **Likelihood:** High (real constraint).
- **Impact:** High — unusable product.
- **Priority:** **P1**
- **Mitigations:** Mobile-first parent pages; server-rendered HTML for core screens where possible; small bundles (code split, minimal heavy deps); offline-aware forms (no silent failure on weak connections); tested on low-end Android emulation.

## R-008 — Cash & Manual Workflow Residue
- **Type:** Product / Financial
- **Description:** Schools mix cash, POS, transfers, online; staff forget to record cash; parents claim payment without proof; unreconciled cash creates "I paid but it's not in the system" disputes.
- **Likelihood:** High.
- **Impact:** Medium-High — disputes, mistrust.
- **Priority:** **P1**
- **Mitigations:** Receipt issued instantly on recording; printed/SMS receipt to parent as proof; daily reconciliation check ("cash on hand" vs recorded cash total); clear UI for provisional/unconfirmed payments.

## R-009 — NDPR / Regulatory Non-Compliance
- **Type:** Business / Legal
- **Description:** Data processing agreement, privacy notice, or data subject procedures not in place before processing real student data.
- **Likelihood:** Medium if legal review is skipped.
- **Impact:** High (fines, shutdown, reputation).
- **Priority:** **P1 before pilot go-live** (P2 for scaffolding)
- **Mitigations:** Engage counsel; use DPA template; review Supabase DPA; document retention policy; security controls in place early.

## R-010 — Key-Person / Bus-Factor Risk
- **Type:** Operations
- **Description:** Early team is small; if one person (founder or first engineer) is unavailable, knowledge or access is lost.
- **Likelihood:** High (typical of early-stage startups).
- **Impact:** Critical.
- **Priority:** **P1**
- **Mitigations:** Document everything (this docs foundation is the start); credentials in shared password manager owned by founder; GitHub access owned by founder; runbooks for deploy/backup/restore; cross-train.

## R-011 — No Remote Git Back-up
- **Type:** Operations (Section 47)
- **Description:** Code exists only in the sandbox/local; environment/session loss destroys work.
- **Likelihood:** Current (workspace is ephemeral sandbox).
- **Impact:** Critical.
- **Priority:** **P0 immediately after approval**
- **Mitigations:** Set up GitHub remote (D2); push at every milestone; verify remote; branch protection.

## R-012 — Brand & Spelling Errors
- **Type:** Brand
- **Description:** Accidentally writing "SCOLARIA" or variants in UI, marketing, emails, payment links.
- **Likelihood:** Medium.
- **Impact:** Medium — brand dilution.
- **Priority:** **P2**
- **Mitigations:** Central brand string constant; CI lint for common misspellings in code/docs; review of all copy; spelling tests in marketing materials.

## R-013 — Over-Engineering
- **Type:** Technical
- **Description:** Building microservices, AI, complex analytics, or infra before Phase 1 is correct.
- **Likelihood:** Medium (engineers love building; must be disciplined).
- **Impact:** Medium-High — delays correctness, increases cost and bugs.
- **Priority:** **P2**
- **Mitigations:** Phase discipline per /docs/PRODUCT_ROADMAP.md; every feature must map to a moat category (§41); defer what isn't needed; regular founder check-ins on roadmap.

## R-014 — Payment Provider Concentration
- **Type:** Business
- **Description:** Over-reliance on Paystack exposes us to outages, rate changes, or account issues.
- **Likelihood:** Medium.
- **Impact:** Medium (pilot); High at scale.
- **Priority:** **P2 for pilot** (P1 post-pilot)
- **Mitigations:** Payment-method agnostic core means cash/transfer/POS work without Paystack; online payments abstracted behind provider interface; add second provider (e.g., Flutterwave) post-pilot if needed.

## R-015 — Pricing Misalignment
- **Type:** Business
- **Description:** Pricing model doesn't match how schools budget (per-term vs per-month) or is too expensive / too cheap.
- **Likelihood:** Unknown (company brief pricing not provided to this team yet).
- **Impact:** High.
- **Priority:** **P1**
- **Mitigations:** Founder to provide pricing details (D6); test pricing with pilot schools in conversation; be willing to adjust before scaling.

## R-016 — Parent Distrust of Digital Receipts
- **Type:** Product / UX
- **Description:** Parents expect physical teller receipts; digital receipts are not accepted as proof.
- **Likelihood:** Medium.
- **Impact:** Medium — friction, extra work for school.
- **Priority:** **P2**
- **Mitigations:** Issued receipts include school logo, signature block, unique receipt number, school contact info; support printing; school can still issue physical receipts alongside digital; design receipt to look authoritative (private-bank aesthetic).

## R-017 — Scope Creep From School Feature Requests
- **Type:** Product
- **Description:** Pilot schools request features outside the financial OS (attendance, grading, etc.).
- **Likelihood:** High.
- **Impact:** Medium-High if indulged; dilutes focus.
- **Priority:** **P2**
- **Mitigations:** Clear product strategy: we are the financial operating system, not the academic system. Interoperability roadmap (§15) — we will integrate, not replace. Document requests and decide against roadmap, not on the fly.

## R-018 — Currency / Locale Issues
- **Type:** UX / Technical
- **Description:** Date/number formatting, timezone (Africa/Lagos), or currency display inconsistent or wrong.
- **Likelihood:** Medium (common internationalization mistake).
- **Impact:** Medium — erodes trust.
- **Priority:** **P2**
- **Mitigations:** Single money formatter; Nigeria-specific number grouping (commas every 3 digits for Naira); dates rendered in Africa/Lagos; locale tests.

## R-019 — Data Import Poisoning
- **Type:** Security / Data
- **Description:** CSV import of students/invoices/payments accepts bad data silently, polluting ledger.
- **Likelihood:** Medium.
- **Impact:** High — corrupted financial history.
- **Priority:** **P1**
- **Mitigations:** Strict server-side validation; dry-run preview; per-row errors; transactional commit (all-or-nothing unless partial-import is explicitly allowed and reviewed); size limits; formula/CSV-injection prevention on exports.

## R-020 — Abuse of Communication Channels
- **Type:** Security / Reputation
- **Description:** Bulk messaging abused (intentionally or via compromised account) to spam parents; damages school trust and SCOLAIRA sender reputation.
- **Likelihood:** Low-Medium.
- **Impact:** Medium-High.
- **Priority:** **P2** (Phase 7 becomes P1)
- **Mitigations:** Per-organization send caps; per-parent frequency caps; permission checks; audit log of sends; easy opt-out; rate limits; monitoring for unusual volumes.

---

## New Risks

Add new risks to this register as they are discovered, with the same fields. P0/P1 risks must have owners and mitigation plans before the area ships.
