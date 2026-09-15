# SCOLAIRA — Data Privacy (NDPR-Aligned)

> We process children's data and school financial data. We collect the minimum, protect it, and respect the rights of parents and schools.

SCOLAIRA processes personal data in Nigeria under the Nigeria Data Protection Act (NDPA) 2023 and Nigeria Data Protection Regulation (NDPR) 2019 framework. This document sets the baseline; formal legal review is required before onboarding real schools (NOTED AS AN ASSUMPTION / OPEN ITEM).

---

## I. Roles

- **Data Controller:** The school (proprietor) — they decide what data to collect, for what purpose, and communicate with parents.
- **Data Processor:** SCOLAIRA — processes data strictly on the school's instructions to deliver the financial operating system.
- **Data Subjects:** Students, guardians, school staff.

A Data Processing Agreement (DPA) between SCOLAIRA and each school will be in place before processing real data.

## II. Data Minimization

### A. Student data
Collected: name, gender (optional DOB), class enrollment history, admission/student code, dates of enrollment/withdrawal/archive.
NOT collected without explicit optional consent: religion, tribe, state of origin (unless required by school for regulatory reporting — in which case it's an optional field with clear purpose), photos (deferred), biometric data (never in pilot).

### B. Guardian data
Collected: name, relationship, primary phone (required for receipts/reminders), optional secondary phone, optional email.
NOT collected: BVN, bank account numbers, NIN, government IDs (unless a school chooses to record in free-text notes — flagged as non-standard in the UI and encrypted-at-rest along with other fields; we recommend against it).

### C. Financial data
Collected: invoices, payments (method, amount, date, reference, recorded-by), allocations, receipts, reversals. All required for financial truth.
Payment references (e.g., Paystack transaction IDs, bank transfer references) are stored; card numbers or bank credentials are NEVER stored (Paystack tokenizes/handles cards; cash/POS/transfers require no card storage).

### D. Staff data
Collected: name, email, role, login/audit events.

## III. Lawful Basis & Consent

- Schools have a legitimate interest (and contract with parents) in processing billing and payment data to operate the school and collect fees.
- Marketing to parents via SCOLAIRA is out of scope for pilot.
- Communication channel consent is recorded per guardian (opt-out honored; channels enabled individually).

## IV. Data Subject Rights

SCOLAIRA will provide the school (controller) with tools to respond to:
1. **Right to access** — export of all data held about a student/guardian.
2. **Right to rectification** — correction of inaccurate data (with audit).
3. **Right to erasure** — subject to financial-record retention requirements (financial data cannot be deleted on demand; it is retained for legal/audit periods and then erased per policy).
4. **Right to restrict processing** — honored where legally required; financial records may not be suppressed but non-financial processing can be paused.
5. **Right to data portability** — export in machine-readable format (CSV/JSON) where applicable.
6. **Right to object** — opt-out of non-essential communications.

## V. Retention Policy

| Data | Retention period |
|---|---|
| Financial records (invoices, payments, allocations, receipts, reversals, audit events) | Minimum 7 years (aligned with Nigerian financial record-keeping best practice; schools should confirm against their auditor requirements). |
| Student records (active) | Duration of enrollment + 7 years after withdrawal/graduation. |
| Guardian PII linked to a student | Same as student records. |
| Communication events | Duration of enrollment + 7 years. |
| Webhook raw payloads | 1 year (for reconciliation/dispute support); then archived/deleted. |
| Idempotency records | 1 year (for webhooks) / 30 days (for API). |
| Server logs (non-audit) | 30 days. |
| Deleted org data (post-churn) | Retained per financial requirements; then securely erased. |

Destruction at end-of-life is performed via secure DB delete (or for backups: cryptographic erasure of keys if volume-level, or overwriting logical records on next backup cycle).

## VI. Security Controls

See `/docs/SECURITY.md`. Specific to privacy:
- Encryption in transit: TLS 1.2+ for all traffic.
- Encryption at rest: Supabase-managed volume encryption; backups encrypted.
- Access control: role-based access + RLS; staff see only what they're authorized to.
- Audit: all access to sensitive data logged.
- Pseudonymization: logs use truncated identifiers where full ID isn't needed.
- Minimized logging: PII never logged (see `/docs/OPERATIONS.md` §IV).

## VII. Third-Party Sub-Processors

| Sub-processor | Purpose | Location |
|---|---|---|
| Supabase | Database, Auth, Storage | Supabase regions (D12 — chosen with NDPR DPA awareness) |
| Vercel | Hosting/CDN | Global edge; primary region chosen to minimize data residency risk |
| Paystack | Online payment processing (card/bank) | Nigeria (Paystack is Nigeria-founded; ensures domestic processing) |
| Resend/Postmark | Transactional email | US/EU; with DPA; no sensitive financial detail in email beyond amounts |
| Sentry | Error tracking | EU/US; configured without PII scrubbing |

A current sub-processor list will be maintained in this doc and on the SCOLAIRA website post-launch.

## VIII. Data Breach Response

In the event of a personal data breach:
1. Assess scope (what data, how many subjects, risk).
2. Notify the school (controller) without undue delay (target: within 24 hours of confirmation).
3. School (controller) is responsible for notifying NITDA and affected data subjects as required by NDPR within statutory timelines; SCOLAIRA provides all available information to support this.
4. Contain and remediate.
5. Document incident and post-mortem.

## IX. Parent Transparency

- Receipts and payment pages carry a short, clear note: "SCOLAIRA processes your payment on behalf of [School Name]. Questions? Contact the school bursary."
- SCOLAIRA does not contact parents for marketing.
- The school decides their own parent privacy notice; SCOLAIRA provides a template.

## X. Exports

- Exports of student/financial data are restricted to authorized roles and audited.
- CSV exports are sanitized (formula injection prevention).
- Bulk exports (whole school data) are logged to the owner; large exports trigger a confirmation.

## XI. Children's Data

- Students are minors (children). SCOLAIRA does not knowingly collect more data than necessary to operate school fee management.
- The school (controller) is responsible for obtaining any required parental consent; SCOLAIRA supports the school with template consent language where needed.

## XII. Open Items / Assumptions

- **[ASSUMPTION]** Formal legal review of this policy against NDPR/NDPA has not been conducted. Recommend founder engages counsel before pilot go-live with real student data.
- **[ASSUMPTION]** Supabase region to be chosen (D12) — recommend a region that supports NDPR data residency expectations; document the Data Processing Agreement with Supabase.
- **[ASSUMPTION]** Template DPA between SCOLAIRA and schools is not yet drafted.
- **[DECISION REQUIRED]** Opt-in vs opt-out for non-essential communications (e.g., school announcements via SCOLAIRA) — pilot can leave this to the school.
