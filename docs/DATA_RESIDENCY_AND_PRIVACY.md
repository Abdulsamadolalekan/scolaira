# Data Residency & Privacy Decision (DRAFT — REQUIRED BEFORE PRODUCTION DATA)

> Selecting a hosting region does NOT by itself equal legal compliance.
> This document will be reviewed by legal counsel before production student data is introduced.

---

## Status: DRAFT — NOT FINAL

This is the initial skeleton of the data-residency decision required by Founder Correction 7. It will be completed (with selected region, subprocessors, backup locations, legal sign-off) before any production student data is stored. Engineering will select a reasonable default for scaffolding, but the final decision requires founder approval and legal review.

---

## I. Selected Supabase Region

**DECISION PENDING (D12).** To be chosen before production provisioning.

**Candidate options:**

- `eu-west-1` (Ireland) — stable, robust, Supabase-supported; GDPR-mature; data leaves Africa.
- `eu-west-2` (London) — similar to Ireland, good latency to Nigeria from UK cables.
- `af-south-1` (Cape Town, if Supabase supports) — African data residency, potentially higher latency/less mature than EU regions; verify availability.
- `us-east-1` (N. Virginia) — avoid for data residency reasons.

**Selection criteria:**

1. Supabase availability and reliability.
2. Network latency from Nigeria (tested during staging).
3. NDPR compliance / adequacy decisions for cross-border transfers.
4. Backup location controls.
5. Disaster recovery posture.
6. Cost.

**Engineering recommendation (subject to legal review):** Choose an EU region (Ireland `eu-west-1`) as the production region because: (a) Supabase's EU region is mature; (b) Nigerian NDPR recognizes countries with adequate data protection; (c) latency to Nigeria via undersea cables is workable; (d) backups remain within EU. We will verify Cape Town availability and re-evaluate.

**Action items before go-live:**

- [ ] Confirm Supabase region availability for shortlist.
- [ ] Run latency tests from Nigerian networks (pilot school location) to each region.
- [ ] Review Supabase Data Processing Agreement (DPA) for NDPR compatibility.
- [ ] Sign DPAs with all sub-processors.
- [ ] Document school (controller) / SCOLAIRA (processor) responsibilities.
- [ ] Engage counsel to review NDPR compliance.

## II. Why Selected

Documented after selection.

## III. Data Residency Considerations

- **Primary data store** (Supabase Postgres): in selected region.
- **Storage** (receipts, CSV uploads): in same region.
- **Edge / CDN** (Vercel): static assets served globally; dynamic responses come from region closest to request but talk to Postgres in the primary region.
- **Backups:**
  - Supabase automated backups + PITR: same region as database.
  - Weekly off-site backup: stored in a separate cloud region, encrypted, documented in `/docs/DISASTER_RECOVERY.md`. Off-site backup location is chosen with legal review.
- **Logging:** Sentry/Vercel data centers documented; PII scrubbing enforced so logs don't contain regulated data.

## IV. Sub-processors (Initial List, to be Maintained)

| Processor                  | Purpose                   | Location                                                                                          |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| Supabase (selected region) | Database, Auth, Storage   | Selected region                                                                                   |
| Vercel                     | Application hosting, CDN  | Global edge; primary region to be selected (likely `iad1` or `fra1` based on DB region proximity) |
| Paystack                   | Online payment processing | Nigeria (Paystack is Nigeria-founded; card data never touches our systems)                        |
| Resend                     | Transactional email       | US/EU (documented at provisioning time)                                                           |
| Sentry                     | Error tracking            | EU or US; PII-scrubbed                                                                            |
| GitHub                     | Source code hosting       | US; repository does not contain production data or secrets                                        |

## V. Data Residency Considerations (International Transfer)

- Schools (controllers) must be aware of and consent to processing locations.
- Where data leaves Nigeria (or Africa), SCOLAIRA will:
  - Have a signed DPA with each sub-processor;
  - Rely on either an adequacy decision (where applicable) or standard contractual clauses (SCCs) as the transfer mechanism, per NDPR guidance;
  - Document all transfers in this document.
- **ACTION:** Counsel review of transfer mechanism before production.

## VI. Retention

From `/docs/DATA_PRIVACY.md`:

- Financial records (invoices, payments, allocations, receipts, reversals, audit): minimum 7 years (aligned with financial record-keeping best practice; school-specific auditor requirements may extend this).
- Student records: duration of enrollment + 7 years.
- Guardian PII: same as student.
- Communication events: 7 years.
- Webhook raw payloads: 1 year.
- Idempotency records: 1 year (webhooks) / 30 days (API).
- Application logs: 30 days.
- Post-churn: data retained per financial requirements, then securely erased.

Legal review will confirm alignment with Nigerian Companies and Allied Matters Act (CAMA) and NDPR.

## VII. Deletion & Erasure

- "Right to erasure" requests are honored subject to financial-record retention requirements:
  - Non-financial PII (e.g., marketing contact fields) can be erased on request.
  - Financial records cannot be destroyed on demand during retention period; they are archived/restricted after the data subject leaves the school.
- Secure deletion at end of retention: logical deletion in DB; cryptographic erasure for backups where applicable (documented).

## VIII. NDPR Considerations

SCOLAIRA will comply with NDPR obligations for processors:

- Act only on documented instructions from the school (controller) as described in the DPA and terms of service.
- Implement appropriate technical and organizational security measures (documented in `/docs/SECURITY.md`).
- Assist controllers in responding to data subject rights requests (access, rectification, erasure, restriction, portability, objection) via in-app tooling.
- Notify controllers without undue delay (target within 24 hours) upon becoming aware of a personal data breach, and provide information needed for NITDA notification.
- Maintain records of processing activities.
- Do not engage sub-processors without controller notice (we will maintain the current sub-processor list and notify schools of changes).
- Delete or return all personal data at the end of the service relationship, subject to retention requirements.

## IX. School (Controller) Responsibilities

Each school as controller is responsible for:

- Having a lawful basis for processing student/guardian data (typically consent and/or legitimate interest/contract for operating the school).
- Providing appropriate privacy notice to parents/guardians (SCOLAIRA will provide a template).
- Honoring data-subject requests from parents.
- Managing their own communication consent practices (SCOLAIRA supports opt-out lists per channel).
- Determining appropriate retention for non-financial data (SCOLAIRA enforces financial retention per policy).

## X. SCOLAIRA (Processor) Responsibilities

- Process data only as documented (provision of the financial OS).
- Maintain security controls (per `/docs/SECURITY.md`).
- Support schools with data-subject requests via in-app tools.
- Notify of breaches within the documented timeframe.
- Make audit information available to schools on reasonable request.
- Publish an up-to-date sub-processor list (this document).
- Sign a Data Processing Agreement with each school.

## XI. Final Approval Gate (Before Production Data)

- [ ] Supabase region selected, with latency tests.
- [ ] DPAs signed with all sub-processors.
- [ ] School/SCOLAIRA DPA template drafted and reviewed by counsel.
- [ ] Privacy notice template drafted for schools to use with parents.
- [ ] Cross-border transfer mechanism documented with counsel sign-off.
- [ ] Retention periods finalized with auditor/legal confirmation.
- [ ] Breach notification runbook drafted (see `/docs/OPERATIONS.md`).
- [ ] Encryption in transit (TLS 1.2+) verified.
- [ ] Encryption at rest verified (Supabase volume encryption).
- [ ] Access control and audit logging verified in staging.
- [ ] Backups tested and documented (see `/docs/DISASTER_RECOVERY.md`).
- [ ] Founder sign-off on this document.

---

_Until this document is finalized and approved, development and scaffolding may proceed using Supabase default region, but NO real student/guardian data will be entered until this gate is passed. Test/seed data may use fictional students._
