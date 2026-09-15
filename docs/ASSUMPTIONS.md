# SCOLAIRA — Assumptions Log

> Every assumption must be labeled. Never convert an assumption into a claimed fact.

As we build, assumptions are logged here. Validation (with pilot schools, legal review, technical proof) will promote or retire them.

---

## Business & Market

- **A1** — ASSUMPTION: The primary customer is proprietor-owned Nigerian private schools of 150–800 students, not government schools, not international high-end schools, not primary-only or university. **Source:** Company directive. **Validated when:** 5+ such schools sign up/pilot.
- **A2** — ASSUMPTION: Proprietors are the primary decision-maker and will value "financial truth" over feature count. **Validated when:** Proprietor interviews confirm this priority ordering.
- **A3** — ASSUMPTION: Parents of these schools have a mix of digital literacy; some pay cash, some by transfer, some via Paystack; no single method dominates universally. **Validated when:** We observe real payment-method mix at pilot schools.
- **A4** — ASSUMPTION: Schools will accept per-term pricing and not demand monthly/annual billing, given the company directive. **Validated when:** Pricing conversations confirm willingness-to-pay.
- **A5** — ASSUMPTION: Schools will not require SCOLAIRA to replace their existing academic/attendance systems; interoperability is sufficient. **Validated when:** Pilot school discovery confirms.
- **A6** — ASSUMPTION: English is sufficient for pilot UI and communications; Hausa/Igbo/Yoruba/Pidgin are post-pilot enhancements. **Validated when:** Pilot school staff and parents report no language barrier.

## Financial Model

- **A7** — ASSUMPTION: Naira-only for pilot. No multi-currency. **Validated when:** Confirmed with founder (D-currency decision point).
- **A8** — ASSUMPTION: All fees are per-student per-term; there is no monthly billing in pilot. **Validated when:** Pilot school fee structures are observed.
- **A9** — ASSUMPTION: Invoices are the canonical billing instrument; there is no need for more complex contracts, installments, or scholarships beyond simple adjustments/credit notes in Phase 1. (Scholarships and discounts can be modeled as fee lines with 0 or reduced amounts, or as credit-note invoice lines.)
- **A10** — ASSUMPTION: Kobo is the smallest unit that matters; schools do not need half-kobo precision.
- **A11** — ASSUMPTION: Default allocation order (overdue → current → prior-term; amount-desc within categories) is acceptable and finance officers can reallocate. **Validated when:** Reconciliation workflow tested with real finance officers.
- **A12** — ASSUMPTION: A school will have a single cash account / does not need to split collections across multiple bank accounts in Phase 1. (Multi-bank-account support deferred.)

## Technical

- **A13** — ASSUMPTION: Supabase + Vercel provide acceptable latency and reliability for Nigerian schools (given that both have global CDN; Supabase region choice D12 matters). **Validated when:** Latency tests from Nigerian networks confirm acceptable (<2s TTFB for critical pages).
- **A14** — ASSUMPTION: Next.js SSR + React is appropriate for low-end Android devices in Nigeria; bundle size will be budgeted (<200KB JS for parent pages, <400KB for authenticated shell). **Validated when:** Tested on real low-end Android on Nigerian networks.
- **A15** — ASSUMPTION: Supabase Auth is sufficient for our auth needs (email/password) and does not become a bottleneck when adding 2FA or SSO. **Validated when:** We prototype auth flows and review Supabase roadmap for 2FA.
- **A16** — ASSUMPTION: Paystack's webhook delivery is at-least-once with occasional out-of-order messages — our idempotency layer is the source of truth.
- **A17** — ASSUMPTION: Cursor-based pagination is preferred over offset for large lists (students, payments, audit log).
- **A18** — ASSUMPTION: Reports can run against live tables in pilot (school size 150–800 students → <10k invoices/term → live aggregation is fast enough with proper indexes). Denormalized materialized views can be added later if needed.
- **A19** — ASSUMPTION: No requirement for offline-first mobile app for finance officers in pilot; browser-based responsive UI is acceptable.

## UX & Design

- **A20** — ASSUMPTION: The "private bank × distinguished school × modern financial software" aesthetic (emerald/gold/white/near-black) communicates trust to Nigerian proprietors. **Validated when:** Proprietors see designs and react positively.
- **A21** — ASSUMPTION: Proprietors want a dense, information-rich Command Center rather than a sparse dashboard with a few big numbers. Both conciseness and density can be achieved, but the bias is toward showing enough to answer "where is my money" within seconds.
- **A22** — ASSUMPTION: Parents do not want accounts; signed links + SMS/WhatsApp reminders are enough. **Validated when:** Parent payment funnel conversion supports this.
- **A23** — ASSUMPTION: Printed receipts remain important; the system must produce professional print-ready receipts. **Validated when:** Observed at pilot school.
- **A24** — ASSUMPTION: The palette (emerald `#046A38`, gold `#C9A961`, near-black `#0B1F16`, paper `#F7F3EC`) works until a final brand system is delivered (D8).

## Security & Privacy

- **A25** — ASSUMPTION: NDPR compliance can be achieved with Supabase (selected region D12, DPA in place) plus our documented controls; no local on-prem hosting is required for pilot. **Validated when:** Legal review confirms.
- **A26** — ASSUMPTION: Supabase RLS is reliable enough to serve as defense-in-depth (but is not relied on as sole isolation).
- **A27** — ASSUMPTION: Argon2id password hashing (Supabase default) meets security requirements; no custom password hashing is needed.
- **A28** — ASSUMPTION: 12-hour sliding sessions balance security and usability for finance officers using shared devices in a school office; "remember me" opt-in extends to 30 days. **Validated when:** D13 approved and pilot UX confirms.

## Operational

- **A29** — ASSUMPTION: Vercel + Supabase are acceptable production vendors for the first 10–50 schools; we can migrate if economics/reliability demand.
- **A30** — ASSUMPTION: Pilot monthly spend under $100 is achievable with Vercel+Supabase free/Pro tiers.
- **A31** — ASSUMPTION: Founder will own and manage domain, Vercel, Supabase, Paystack, and Resend accounts, granting engineering access rather than engineering owning credentials.
- **A32** — ASSUMPTION: Weekly off-site backup (in addition to PITR) is sufficient for pilot; daily off-site backup post-pilot.

## Open Questions Implying Assumptions

See `/docs/ARCHITECTURE.md` §S (Unknowns) and §T (Decisions Required). Each item is an assumption until resolved.
