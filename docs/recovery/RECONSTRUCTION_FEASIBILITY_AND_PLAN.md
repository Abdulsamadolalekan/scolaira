# SCOLAIRA — R1/R2 Reconstruction Feasibility & Plan

**Date:** 2026-09-23
**Companion to:** [`RECOVERY_REPORT_2026-09-23.md`](./RECOVERY_REPORT_2026-09-23.md) (workspace forensics & lineage search)
**Status:** ✅ **ANALYSIS ONLY — nothing rebuilt. Awaiting authorization.**

---

## 1. The direct answer

> *"Can the previous R1/R2 implementation be reconstructed faithfully from the engineering records, closeout reports, and directives available in this conversation/context?"*

**No. Not faithfully.**

And the question has a hidden premise that must be corrected first:

> *"…from the engineering records, closeout reports, and directives available in this conversation/context"*

**The R1/R2 closeout reports are not available in this conversation or in this repository.** Neither are the
readiness/audit documents, nor the finding register that produced "H-3". Nothing describing what R1 and R2
actually *did* was ever provided to this session, and nothing describing it exists on disk. The recovery
instruction's first message asked me to *"read the R1/R2 closeout documents and current readiness/audit
documents"* — that instruction presumed those documents were in the repository. They are not. They were
produced inside the previous workspace and were lost with it, exactly as the commits were.

So the honest position is:

- **Requirements** for R1/R2's *subject matter* are partially recoverable — from the M0/M1-era design
  documentation, which is genuinely detailed and genuinely survives.
- **The engineering record of what R1/R2 actually found and changed is 0% recoverable.** Not "thin" —
  absent. There is no artifact anywhere in this session that states what R1 or R2 did.

Calling a rebuild built from the design docs a "reconstruction of R1/R2" would be false. It would be a
**new implementation, of a system that was never built here, guided by the same design intent those
remediations were intended to enforce.** That is a legitimate and valuable thing to do — but it is a
re-baseline, not a recovery, and it must be labelled as such.

---

## 2. Can the old workspace be restored?

**No. State it plainly, as requested: the old workspace cannot be restored from here, and the original
commits cannot be recovered.**

The previous Arena session's sandbox was destroyed when that chat became unavailable. Its git object
database lived only inside that sandbox, and no push beyond M1 was ever made to GitHub (proven in the
recovery report §9–10: `upload-pack: not our ref` for every claimed SHA, `422 No commit found` from the
commit API, 7 commits total on the remote, 2 CI runs ever, both on 2026-09-15, zero artifacts).

**Critically, the loss is broader than the commits.** Because those commits were never pushed, the *records
attached to them were never pushed either* — the closeout documents, the audit reports, the finding
register. Those are the very artifacts you hoped to reconstruct from. They are gone with the same blast
radius.

The only remaining routes to the *original* lineage (unchanged from the recovery report §11.3):

1. An Arena workspace-snapshot restore of the previous chat — **must be requested from Arena; impossible from inside this sandbox.**
2. A founder-side machine or backup holding a clone with those objects (`git branch -a --contains 02525053`).
3. A different remote/account that received the pushes (e.g. a `scolaira/scolaira` org repo — `GET /orgs/scolaira` → 404 today; a deleted repo would need GitHub Support).

I will not claim any of these succeeded unless it is actually verified. **None has.**

---

## 3. What engineering records actually exist

Three tiers, sharply separated by trustworthiness.

### Tier 0 — Present in this conversation only: unverified, non-repository

| Item | Content | Verifiable against repo? |
| ---- | ------- | ------------------------ |
| Four SHAs | M10 `5841f2e9…`, M11 `cc0f6af3…`, R1 `0683702…`, R2 `02525053…` | **No** — all absent locally and remotely |
| Remediation names | "R1 Isolation Hardening", "R2 Exceptional-Path Financial Integrity", "R3 Public Surface Hardening (H-3)" | **No** — appear nowhere in the repo |
| R3 scope (7 bullets) | Amount binding, public idempotency, rate limiting, token handling, response minimisation, adversarial tests, preserve R1/R2 invariants | **No** — but it is the *most concrete* remediation artifact in existence |
| Status claim | "R2 complete and independently re-audited" | **No** — unverifiable, and reflects a build that no longer exists |
| **R1/R2 closeout reports** | — | **NEVER PROVIDED. Do not exist.** |
| **H-1…H-6 finding register** | — | **NEVER PROVIDED. Do not exist.** |

The R3 scope bullets are worth flagging: they are detailed enough to *imply* facts about the lost R2 state
(a payment-link notes field existed; audit metadata carried a raw token; a public submission endpoint
existed). Those implications are useful hints but are **not** a specification of R2, and I cannot verify a
single one of them.

### Tier 1 — M0/M1-era design documentation: the real surviving asset

**~5,668 lines across 38 documents** (6,108 total minus this session's 440-line recovery report), all frozen
at the M1 commit `2026-09-15`, i.e. written **before any application code existed**, as design intent.

| Document | Lines | Relevance to R1/R2 |
| -------- | ----- | ------------------ |
| `DATABASE.md` | 475 | 24-table schema, RLS/tenant rules, composite FKs, payment_links spec |
| `ARCHITECTURE.md` | 432 | Layering, tenant model, financial truth ownership |
| `RISK_REGISTER.md` | 268 | Risk mitigations incl. rate limits, comms caps |
| `PRODUCT_ROADMAP.md` | 243 | Phase 1/2 boundaries; payment links = Phase 2 |
| `SCOLAIRA_SPEC.md` | 237 | Product requirements |
| `API_CONTRACTS.md` | 216 | Endpoint families, error codes, idempotency header contract |
| `SECURITY.md` | 213 | ✅ **Direct evidence for R1** — threat model, 4-layer tenant isolation, webhook security, CSRF, rate limits, security test matrix |
| `IMPLEMENTATION_SEQUENCE.md` | 193 | Milestone gates M0→Slices; M4 gate = cross-tenant tests |
| `TESTING.md` | 184 | ✅ **FM-1…FM-32** financial matrix, **S-1…S-24** security matrix |
| `CONCURRENCY_DESIGN.md` | 166 | ✅ **Cases A–G** race-by-race behaviour specs |
| `DECISIONS.md` | 163 | ADRs D-001…D-028, incl. state-machine mandate (D-016) |
| `FINANCIAL_INVARIANTS.md` | 136 | ✅ **F1…F15** invariants, violation-response protocol |
| `DATA_PRIVACY.md` / `DATA_RESIDENCY_AND_PRIVACY.md` | 275 | NDPR alignment |
| `AUDIT_MODEL.md` | 140 | Audit event taxonomy, incl. `payment_link.*` |
| 11 state machines (`docs/state-machines/`) | ~570 | PAYMENT, PAYMENT_LINK, REVERSAL_REFUND, PAYMENT_ALLOCATION, INVOICE, RECEIPT, etc. |

**Totals:** 15 financial invariants · 32 financial test IDs · 24 security test IDs · 7 concurrency cases ·
11 state machines · 24 tables · 15 security control sections · 28 ADRs.

This is a genuinely strong *specification base*. It is not, however, the engineering record.

### Tier 2 — M1 implementation (verified present and passing)

Verified this session: **30/30 unit tests, typecheck ✅, lint ✅, production build ✅**. Design system only —
19 UI primitives, tokens, nav shell, page templates. Zero business logic, zero DB, zero auth.

### Missing entirely

**M2, M3, M4, Slices 1–7, M5–M11, R1, R2** — nine-plus milestones of implementation: schema, migrations,
auth, tenant context, billing, payments, allocations, reversals, receipts, reporting, payment links,
plus both remediations. **Not one line of it survives** — not code, not migrations, not tests, not docs,
not a diff, not a screenshot, not a CI log.

---

## 4. Why R1/R2 cannot be "recreated" in isolation

This is the structural point that governs everything else, and it is not a technicality.

**R1 and R2 are hardening passes. They are diffs against a substrate. The substrate does not exist.**

```
M1 (exists, verified)
  └── M2…M11  ← ALL GONE: schema, migrations, auth, tenant context, ledger, payment links
        ├── R1 Isolation Hardening      ← a pass over M2/M4's tenant model
        └── R2 Exceptional-Path Integrity ← a pass over Slice 5/6's ledger + webhook paths
```

You cannot apply "isolation hardening" to a system with no tables. You cannot harden "exceptional-path
financial integrity" in a ledger with no payments, allocations, reversals, or webhooks. Any attempt would
mean **authoring M2–M11 first** — and at that point you are not reconstructing R1/R2, you are **building the
system from scratch and folding R1/R2's requirements in as design-time constraints**, which is a better
outcome anyway.

Two further honesty points:

1. **The project's own rule forbids treating the docs as the implementation.** `DATABASE.md` states:
   *"Types below are illustrative. Migrations are the source of truth; this document is the design
   reference."* The migrations are gone. Therefore, by the project's own standard, **no source of truth
   survives** — only illustrative intent.
2. **No rebuild can inherit R2's audit status.** "Independently re-audited" describes a specific artifact
   that no longer exists. A new system, however well built, has never been audited and could not honestly
   claim that status without a fresh audit.

---

## 5. What R1/R2 must have covered — inferred, with evidence grading

⚠️ **Read this table as inference, not recovery.** R1 and R2's actual scope was never written down in any
surviving artifact. What follows is derived from the remediation *names* plus the Tier-1 requirements they
evidently implement. Each row is labelled with the strength of its evidence.

### 5.1 R1 — "Isolation Hardening" (inferred domain: tenant isolation)

| # | Functionality that must be (re)built | Evidence | Evidence strength |
| - | ------------------------------------ | -------- | ----------------- |
| R1-1 | `organization_id NOT NULL` + FK on every tenant table | `SECURITY.md` §IV.3; `FINANCIAL_INVARIANTS.md` F11 | **Strong on *what***, no artifact exists |
| R1-2 | RLS enabled on every tenant table, **default-deny**, policies per role | `SECURITY.md` §IV.2; `DATABASE.md` §I preamble | Strong on intent; **exact policy set unknown** |
| R1-3 | App-layer scoping helper (`db.forOrg(orgId)`) making unscoped queries impossible | `SECURITY.md` §IV.1 — names the helper | **Name known, signature/behaviour unknown** |
| R1-4 | Lint rule failing raw queries lacking org scoping | `SECURITY.md` §IV.1 | Intent only; rule identity/config unknown |
| R1-5 | Composite FKs incl. `organization_id` to block cross-org joins | `SECURITY.md` §IV.4 | Strong on rule |
| R1-6 | Unique constraints include `organization_id` (no cross-org dedup collisions) | `SECURITY.md` §IV.4 | Strong on rule |
| R1-7 | Cross-tenant automated test matrix in CI (no cross-org rows readable; 404/403) | `SECURITY.md` §IV.5, §XIV; `TESTING.md` §IV (S-1, S-23, S-24); `IMPLEMENTATION_SEQUENCE.md` M4 gate | **Strong**; test IDs survive |
| R1-8 | Payment-link tokens: 256-bit random, no org/student IDs in URL slugs, signed payload carrying obligation id + expiry | `SECURITY.md` §IV.6; `state-machines/PAYMENT_LINK.md` | Strong on requirements |
| R1-9 | IDOR / session-misuse / privilege-escalation coverage | `SECURITY.md` §XIV | Strong on mandate |
| R1-10 | **The specific vulnerabilities R1 was opened to fix** | — | ❌ **Zero evidence. Unknowable.** |

### 5.2 R2 — "Exceptional-Path Financial Integrity" (inferred domain: failure/edge paths in the ledger)

| # | Functionality that must be (re)built | Evidence | Evidence strength |
| - | ------------------------------------ | -------- | ----------------- |
| R2-1 | Reversal/refund/void paths preserving history; no destructive edits (F5, F6) | `FINANCIAL_INVARIANTS.md` F5–F6; `state-machines/REVERSAL_REFUND.md` | Strong on intent |
| R2-2 | Reversed/refunded payments excluded from collected totals; partial-reversal adjustment (F7) | F7 | Strong on rule |
| R2-3 | Duplicate-reference safety: unique `(organization_id, method, external_reference)` (F8) | F8; `CONCURRENCY_DESIGN.md` Case A | Strong on rule |
| R2-4 | Webhook idempotency on `(provider, event_id)`; duplicates → 200 no-op (F9) | F9; `SECURITY.md` §V.3; Case C | Strong |
| R2-5 | Replay-window rejection (events >5 min old), forged-signature rejection, out-of-order handling | `SECURITY.md` §V.2/§V.4/§V.5 | Strong |
| R2-6 | Out-of-order events → review queue, never silently applied (F10) | F10; Cases D/E | Strong |
| R2-7 | Allocation bounds under concurrency: ≤ payment (F3), ≤ invoice outstanding (F4), deterministic lock order | F3/F4; Case B | Strong |
| R2-8 | Deterministic invariant-violation protocol: rollback, structured `FINANCIAL_INVARIANT_VIOLATION`, safe 409 code, never silent coercion | `FINANCIAL_INVARIANTS.md` §VIII | Strong on protocol |
| R2-9 | Append-only audit emission on every financial mutation with reason/request-id/ip | F12; `AUDIT_MODEL.md`; `FINANCIAL_INVARIANTS.md` §VI | Strong on schema |
| R2-10 | Mandated FM-* test coverage for each invariant | `TESTING.md` §III; `FINANCIAL_INVARIANTS.md` §VII | Strong; 32 test IDs survive |
| R2-11 | **The specific defects R2 was opened to fix, and its audit trail** | — | ❌ **Zero evidence. Unknowable.** |

### 5.3 What is genuinely well-specified vs. genuinely unknown

- **Well-specified (Tier 1 carries real weight):** the *invariants* and *required test coverage* for tenant
  isolation and financial exceptional paths. F1–F15, S-1…S-24, FM-1…FM-32, Cases A–G are concrete and
  testable. A rebuild **can be held to these**, and their automated tests can be written from the docs alone.
- **Unknown and unknowable:** R1/R2's actual diffs, the defects they fixed, the finding register, their
  closeout evidence, the exact RLS policy set, the `db.forOrg()` signature, the lint rule, and the entire
  M2–M11 implementation shape (which migrations shipped, which endpoints existed, whether the built payment
  link surface even matched the Phase-2 doc).

---

## 6. What cannot be verified — explicit list

If a rebuild proceeds, none of the following can ever be established, and no document may imply otherwise:

1. That rebuilt code is functionally equivalent to the audited R2 build. **No basis for equivalence exists.**
2. That the defects R1/R2 fixed are the defects this rebuild would face — the finding register (H-1…H-6) is gone.
3. That the schema matches what was actually migrated. `DATABASE.md` is explicitly illustrative; migrations are gone.
4. That the RLS policy set matches. Only "default-deny + per-role" survives.
5. That R2's audit conclusions still hold — they were rendered against an artifact that no longer exists.
6. That any SHA, tag, or commit message from the original lineage can be reproduced. SHAs depend on exact
   content, authorship, and timestamps; reproducing them is impossible *and* attempting it would be fraud.
7. That M10/M11 covered what the roadmap's Phase 1/2 labels suggest. Their contents are unknown.

---

## 7. The reconstruction plan (for authorization — not started)

Because R1/R2 cannot be rebuilt in isolation (§4), the only coherent plan is a **re-baselined forward build
that folds R1/R2's requirements and the R3 scope in as design-time constraints**.

### 7.1 Strategy

Do **not** build M2–M11 naively and then re-apply R1/R2/R3 as after-the-fact patches. Instead build each
layer **already hardened**, with the relevant invariant tests written alongside it and gating CI from the
first commit. Rationale: post-hoc remediation is exactly the failure mode that lost this work, and building
it in is both cheaper and more defensible.

### 7.2 Phases

| Phase | Scope | R1/R2/R3 requirements folded in | Gate |
| ----- | ----- | ------------------------------- | ---- |
| **P0 — Provenance & baseline** | Publish this plan + the recovery report; declare the lineage break; establish the rebuild namespace, tagging scheme, and provenance commit trailer (§8) | — | Provenance doc merged; `main` still at M1 |
| **P1 — M2 Database & Migrations** | 24-table schema, Drizzle + Postgres, migration tooling, ephemeral-Postgres integration test harness | **R1-1, R1-2, R1-5, R1-6** built into migrations from migration #1 (org NOT NULL + FK, RLS default-deny per-role, composite FKs, org-scoped uniques) | Migrations forward/backward clean; RLS enabled on every tenant table asserted by a test |
| **P2 — M3+M4 Auth, Tenant Context & Authorization** | Supabase Auth, session handling, memberships, role matrix, CSRF, tenant scoping helper | **R1-3, R1-4, R1-7, R1-9** — `db.forOrg()` guard, lint rule, cross-tenant matrix (S-1/S-23/S-24) green in CI | Cross-tenant + privilege-escalation tests pass; CSRF enforced |
| **P3 — Phase-1 ledger (Slices 1–5)** | Students/guardians, fees, billing, payments, allocations, receipts, reversals | **R2-1…R2-11** — F1–F15 enforced by DB triggers + service assertions; F3/F4 locking per Cases A–G; duplicate detection (F8); append-only audit (F12); FM-1…FM-32 written with each slice; §VIII violation protocol | Financial test matrix green; concurrency cases A–G covered |
| **P4 — Webhooks & payment links (Phase 2 slice)** | Paystack webhook intake; payment_links issuance/revocation; public `/pay/*` surface | **R2-4/5/6** (webhook idempotency, replay window, out-of-order → review) **+ the full R3 scope** — server-side amount binding to link-authoritative amount, public submission idempotency, rate limiting/bounded attempts, no raw bearer tokens in notes/audit (fingerprints only), minimised public responses, adversarial suite | R3's 7 scope bullets each covered by tests; forged/replayed/amount-tampered/enumeration/cross-tenant attempts all fail safely |
| **P5 — Fresh independent audit** | Commission a new audit against the rebuilt artifact | Records *new* findings under a **new** finding register (`H-RB-*`), never reusing H-1…H-6 | Audit report published; findings closed |

### 7.3 Non-negotiables for the rebuild

- Migrations are numbered and append-only **from the true M1 state**; no historical migration is modified.
- Every invariant (F1–F15) has ≥1 deterministic automated test before its slice is considered done.
- Every security-matrix row (S-1…S-24) mapped to a test or an explicit documented deferral with rationale.
- No feature outside the plan; no UI work beyond what a slice requires.
- The R3 scope is implemented as specified — nothing more, nothing less — and only after P1–P3 exist.

### 7.4 Effort reality

This is **not a remediation-sized task**. It is the full program from M2 forward: schema, auth, tenant
model, and the Phase-1 ledger, plus payment links and webhooks. Any estimate that treats "reconstruct R1/R2"
as a few days of patching would be wrong by an order of magnitude, because the substrate must be built
first.

---

## 8. How rebuilt work stays clearly distinguishable from the lost lineage

This is enforceable and will be enforced. The goal: **no human or agent, ever, can mistake rebuilt work for
a recovery of the original.**

### 8.1 Hard prohibitions

| ❌ Never | Why |
| -------- | --- |
| Create tags `M10`, `M11`, or any tag claiming the lost milestones | Would falsely assert the milestones were recovered |
| Reference or recreate SHAs `5841f2e9…`, `cc0f6af3…`, `0683702…`, `02525053…` | Cannot be reproduced; any such claim is fabrication |
| Rewrite, amend, or force-push `main` (stays at `2c5a50644da86f77ccd1ad9ce21a8b80bad7b21a`) | Preserves the only verified anchor of the real history |
| Graft rebuilt work onto a fabricated ancestry | Would corrupt the historical record |
| Claim "R1 complete" / "R2 complete" / "recovered" / "restored" | Not true in any sense |
| Reuse finding IDs H-1…H-6 | Those findings died with their audit; new findings get new IDs |
| Delete or rewrite the recovery report | It is the permanent record of the lineage break |

### 8.2 Positive identification mechanisms

1. **Branch namespace.** Rebuild work lands on `rebuild/*` branches; the session branch
   `arena/01a0ce9b-scolaira` continues to carry documentation only.
2. **Commit trailer.** Every rebuilt commit carries `Provenance: reconstruction` — so
   `git log --grep='Provenance: reconstruction'` enumerates the entire rebuilt set, and its absence on
   M0/M1 commits proves they are original.
3. **Documentation namespace.** Rebuilt engineering docs live in `docs/rebuild/`, never in `docs/` root and
   never in `docs/recovery/` (which is reserved for loss/provenance records).
4. **Version scheme.** Distinct from the original `0.1.0-M#` line — e.g. `0.2.0-RB1`, so any artifact's
   origin is readable at a glance.
5. **Provenance header.** Every rebuild document opens with: *derived from the M0/M1 design documentation;
   not recovered from the original lineage; supersedes nothing.*
6. **Finding register reset.** Post-rebuild audits publish `H-RB-*` findings, explicitly not continuing H-1…H-6.
7. **Explicit loss statement.** `README.md` and the roadmap carry a permanent note that the M2–M11/R1/R2
   lineage was lost on 2026-09-23, with the recovery report cited.
8. **No audit-status inheritance.** Rebuilt code is "unaudited" until a fresh audit (P5) completes; the
   phrase "independently re-audited" is never applied to it.

### 8.3 Terminology standard

| Say | Never say |
| --- | --------- |
| "rebuild", "re-implementation", "re-baseline" | "recovery", "restoration", "reconstruction of R2" |
| "spec-conformant with the documented invariants" | "equivalent to the audited implementation" |
| "R1/R2 requirements folded in at design time" | "R1/R2 re-applied" |
| "new audit, new findings (H-RB-*)" | "re-audit confirms previous findings" |

---

## 9. Fidelity assessment — what is achievable, in which sense

| Sense of "faithful" | Achievable? | Notes |
| ------------------- | ----------- | ----- |
| **Artifact fidelity** — identical code/diffs/tests to the lost R1/R2 | ❌ **0%** | No diffs, no source, no migrations, no audit record exist. Not recoverable in principle. |
| **Process fidelity** — reproducing the way R1/R2 were run (audit → remediate → re-audit) | ⚠️ **Partial** | The *shape* of a remediation pass is knowable from the docs and R3's scope; the original finding inputs are gone. |
| **Requirement fidelity** — a system satisfying the documented invariants (F1–F15) and security controls (§IV, §V, §VIII) for R1/R2's domains | ✅ **High, and testable** | F1–F15, S-1…S-24, FM-1…FM-32, Cases A–G are concrete. A rebuild can be *held to* and *proven against* them. |
| **Audit-status fidelity** — inheriting "independently re-audited" | ❌ **0%** | Requires a fresh audit of the new artifact. |
| **SHA/lineage fidelity** — same commits, tags, ancestry | ❌ **0%** | Mathematically impossible to reproduce; must never be faked. |

**Bottom line:** a rebuild can be **provably conformant to the documented specification** for R1/R2's subject
matter, and provably compliant with the R3 scope. It can never be **the same artifact** — and every document
must say so.

---

## 10. Recommendation & decision points

**Recommendation: authorize P0+P1 only, and treat this as a re-baseline, not a recovery.**

P0 is cheap and irreversible-in-a-good-way: it publishes this analysis and the provenance rules, so that
whatever is built next is permanently and honestly labelled. P1 (M2 schema + migrations with R1's isolation
controls baked in) is the first *real* engineering step and is independently valuable and verifiable.

Before authorizing, four decisions are needed:

- **D-A. Accept that the original lineage is lost?** If any of recovery routes 1–3 (§2) is still to be tried,
  try it **first** — a successful snapshot restore would change this plan entirely and make a rebuild
  unnecessary. This is the highest-value action available, and it happens outside this sandbox.
- **D-B. Re-baseline or hold?** If yes, work proceeds from M1 forward. If no, work stops here with the
  repository exactly as verified.
- **D-C. Fold or re-apply?** Confirm the recommended approach: build hardened from the first migration,
  rather than reproducing an unhardened M2–M11 and patching later.
- **D-D. Scope of first build step?** P1 (M2 DB & migrations) is the natural start. R3 remains blocked
  until its substrate (payment links + public surface) exists — it is Phase-2 work and cannot be pulled
  forward without inventing the ledger underneath it.

**Nothing is rebuilt. No migration, schema, commit, tag, or ref has been created. `main` remains at
`2c5a50644da86f77ccd1ad9ce21a8b80bad7b21a`.**

---

## 11. Provenance of this document

This document is analysis derived from: (a) the verified repository state (Tier 2, executed and passing);
(b) the M0/M1-era design documentation (Tier 1, present in-tree, frozen at `2026-09-15`); and (c) the
remediation names and R3 scope supplied in conversation (Tier 0, unverified — explicitly labelled as such
throughout). No part of it is derived from the lost R1/R2 artifacts, because none exist. It is a
**provenance and planning record**, not an engineering record of R1/R2.
