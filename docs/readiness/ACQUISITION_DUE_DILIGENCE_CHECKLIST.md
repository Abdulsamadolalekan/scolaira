# SCOLAIRA — Acquisition / Technical Due-Diligence Checklist

**Companion to:** `docs/readiness/POST_M11_READINESS_AUDIT.md`
**Frozen revision:** `cc0f6af378015aa6c4deba10a4e126ef9d8ff165` (tag `m11-collections-control-plane`)
**Purpose:** map every diligence question a technical buyer will ask to the current answer, the evidence that exists today, and the finding that must close first.
**Status at time of writing:** **NOT DILIGENCE-READY.** Architecture is a genuine asset; isolation enforcement, exceptional-path financial controls, and evidence are not.

> **R1 update (2026-09-23).** Section A is now answered by evidence rather than
> by argument: C-1, C-2 and C-3 are independently demonstrated closed, and a
> newly discovered privilege defect (C-4) was closed in the same milestone. See
> `docs/security/R1_ISOLATION_HARDENING_CLOSEOUT.md`. Section B (exceptional-path
> financial controls) and the remaining HIGH findings are unchanged and still
> block diligence readiness.

Legend — **Ready**: evidence exists. **Partial**: exists but incomplete or unexercised. **Gap**: missing. Evidence classes (E1–E4) as defined in the audit.

---

## A. Tenant isolation & data boundary

| # | Diligence question | Status | Evidence today | Must close |
|---|---|---|---|---|
| A1 | Is tenant data provably isolated per request? | **Ready** (R1, 2026-09-23) | **Proven:** scope-owned connection; transaction-local context reverted by Postgres; all 11 identity variables cleared and read back; fail-closed. `tests/db/r1-context-isolation.test.ts` (14), `tests/db/r1-independent-reaudit.test.ts` §E, closeout §2/§7. No reliance on `max: 1`. | closed (C-1) |
| A2 | Are financial FKs tenant-composite? | **Ready** (R1, 2026-09-23) | **Proven:** 16 parent unique `(organization_id, id)` indexes + 37 composite FKs over 17 tables (`0038`); catalog completeness and per-relationship forged-insert tests in `tests/db/r1-composite-fk.test.ts` (48). | closed (C-2) |
| A3 | Is the public context derived from validated proof? | **Ready** (R1, 2026-09-23) | **Proven:** proof bound to (token, org, backend); self-asserted setters revoked; public context is not tenant context; submission goes through a credential-gated entry point with no direct table-write privileges (`0040`/`0042`/`0043`). `tests/db/r1-public-context.test.ts` (20). | closed (C-3) |
| A4 | Can the runtime role escalate privileges? | **Ready** (R1, 2026-09-23) | **Proven:** DML-only on all tables (no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN), `app_meta` owner-only, no `CREATE` on schema `public`; 7 escalation attempts refused `42501` (`tests/db/r1-independent-reaudit.test.ts` §F; migration `0044`). | closed (C-4/H-1) |
| A5 | Is RLS forced everywhere it matters? | **Partial** | `reminders` and `app_meta` lack `FORCE ROW LEVEL SECURITY` (`0019_reminders.sql:61-78`) | H-1 |
| A6 | Is there a cross-tenant negative test? | **Ready** (R1, 2026-09-23) | **Proven:** 99 added tests across four R1 suites — forged context, concurrency across two organisations, 37 cross-tenant parent relationships, forged/revoked/expired/replayed public bearers, direct-SQL and privilege escalation attempts. | closed (C-1, C-2, C-3) |

## B. Financial integrity

| # | Diligence question | Status | Evidence today | Must close |
|---|---|---|---|---|
| B1 | Is there one authoritative source of financial truth? | **Ready** | Ledger design, append-only tables, trigger-enforced invariants | — |
| B2 | Are corrections/reversals idempotent at the database? | **Gap** | No unique constraint on `(payment_id, reference)` in `reversals`; SELECT-then-INSERT only (`app/api/payments/[id]/reverse/route.ts:44-57`) | H-7 |
| B3 | Is receipt issuance atomic with its audit event and amount snapshot? | **Gap** | Read/insert/audit outside a transaction (`app/api/receipts/route.ts:33-107`) | H-7 |
| B4 | Is a receipt reproducible after later reversals? | **Gap** | Rendered from live ACTIVE allocations vs frozen `amount_kobo` (`app/api/receipts/[id]/route.ts:22-40`) | M-3 |
| B5 | Is invoice void atomic? | **Gap** | Balance read, void and audit on `db`, not in one transaction (`app/api/invoices/[id]/void/route.ts:28-52`) | M-2 |
| B6 | Is payment creation idempotent by default? | **Partial** | `Idempotency-Key` is optional (`app/api/payments/route.ts:127-245`) | H-7 |
| B7 | Are partial refunds supported? | **Gap** | Hard-fails: "Partial allocation reversal not supported in M2" (`0001_integrity.sql:549-551`, `0002_financial_fixes.sql:173-175`) | M-4 |
| B8 | Is REFUND accounting treatment documented? | **Gap** | Trigger behaviour only (`0002_financial_fixes.sql:191-212`) | M-5 |
| B9 | Do KPIs tie to source rows across term boundaries? | **Gap** | Current-term KPIs beside all-term queues (`app/api/dashboard/summary/route.ts:102-250`) | H-2 |

## C. Security

| # | Diligence question | Status | Evidence today | Must close |
|---|---|---|---|---|
| C1 | Is authorization centralized? | **Ready** | `lib/authz/index.ts` | — |
| C2 | Is CSRF enforced on unsafe methods? | **Partial** | Protected routes yes; logout not aligned (`app/api/auth/logout/route.ts:6-21`) | H-5 |
| C3 | Is the auth session context cleaned up on all failure paths? | **Partial** | Depends on outer wrappers (`lib/auth/index.ts:293-320,644-692`) | H-5 |
| C4 | Is password-reset single-use under concurrency? | **Gap** | `FOR UPDATE` not held across update/consume/revoke (`lib/auth/index.ts:199-290`) | H-5 |
| C5 | Is internal error text withheld from clients? | **Gap** | `String(e?.message ?? e)` (`app/api/auth/reset-confirm/route.ts:21-24`) | M-1 |
| C6 | Is actor attribution complete for privileged access? | **Partial** | Audit design present; no sanctioned support journey (shell) | H-8 |
| C7 | Public payment-link abuse controls? | **Gap** | No idempotency/rate limit; caller-influenced amount; tokens in notes/audit (`app/api/p/[token]/submit/route.ts`) | H-3 |
| C8 | Is registration provisioning atomic? | **Gap** | Four autocommit inserts (`lib/auth/index.ts:452-532`) | H-4 |

## D. Reliability, release evidence & operations

| # | Diligence question | Status | Evidence today | Must close |
|---|---|---|---|---|
| D1 | Does health prove the system is usable? | **Gap** | Always `ok`; `database`/`auth` = `not_configured` (`app/api/health/route.ts:17-40`) | H-6 |
| D2 | Does CI run the product end to end on a migrated seeded DB? | **Gap** | No migration/seed or authenticated journey; Chromium only; preview pages (`playwright.config.ts:7-30`, `tests/global-setup-db.ts`) | H-6 |
| D3 | Do screenshots show the shipped product? | **Gap** | Preview/mock surfaces (`e2e/screenshots.spec.ts`) | H-6 |
| D4 | Is backup/restore/PITR evidenced? | **Gap (E4)** | `docs/DISASTER_RECOVERY.md` describes intent; no drill record, no measured RTO/RPO, no named off-site owner | H-9 |
| D5 | Is data residency demonstrated? | **Partial (E4)** | `docs/DATA_RESIDENCY_AND_PRIVACY.md` partly draft | H-9 |
| D6 | Credible typecheck/unit evidence? | **Ready** | `package.json` scripts; Vitest suite | — |
| D7 | Code hygiene | **Partial** | Lint warnings; `npm run format:check` fails on 183 files — deliberately deferred under freeze | M-8 |

## E. Architecture, ownership & handover

| # | Diligence question | Status | Evidence today | Must close |
|---|---|---|---|---|
| E1 | Documented architecture matching the code? | **Partial** | `docs/ARCHITECTURE.md` claims providers/routes not in the frozen implementation | M-9 |
| E2 | API contracts accurate? | **Partial** | `docs/API_CONTRACTS.md` same concern | M-9 |
| E3 | Ownership / IP artefacts | **Gap (E4)** | Not located in the audited tree | H-9 |
| E4 | Migration discipline | **Ready** | `0000`–`0037`, sequential, applied-artefacts frozen | — |
| E5 | M10/M11 containment respected? | **Ready** | M10 guard; M11 workflow-only; `0037_m11_collections_control_plane.sql` | — |
| E6 | Handover completeness | **Partial** | Operations/DR/API/architecture present; readiness package is this pair of documents | H-9, M-9 |

---

## F. Three highest-value artefacts to produce before a data room opens

1. **Isolation proof pack** — after C-1/C-2/C-3 remediate: negative cross-tenant tests, the corrected concurrency probe output, and the privilege matrix.
2. **Financial exceptional-path pack** — reversal/receipt/void concurrency tests, the reversal uniqueness constraint diff, and a one-page statement of documented refund/reversal/void semantics.
3. **Operational evidence pack** — a dated, owned backup and test-restore record, readiness-probe output, and a seeded authenticated E2E CI run.

## G. Positive disclosures to lead with

Authoritative ledger with append-only history; trigger-enforced invoice/payment/allocation/reversal invariants; M10 case/evidence/candidate control plane that refuses to mutate financial truth and requires an accepted candidate plus a fully allocated confirmed payment before `ALLOCATED`; M11 deliberately constrained to a workflow/control layer with zero authority over financial truth; disciplined sequential migrations `0000`–`0037`; centralized authorization, CSRF, idempotency infrastructure and audit-event recording already in place.

## H. Bottom line for a buyer

The design is fundable. The **enforcement boundary** (three criticals), the **exceptional-path financial controls** (H-7 plus four medium financial findings), and the **evidence layer** (H-6, H-9) are what a competent technical reviewer will use to discount. None of them require redesign — they require remediation, negative tests, and honest artefacts. M12 adds nothing to this list.
