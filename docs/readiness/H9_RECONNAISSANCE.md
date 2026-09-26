# SCOLAIRA — H-9 Reconnaissance Report

**Status:** READ-ONLY RECONNAISSANCE — no implementation, no commit, no migration, no source/test/CI change.
**Commissioned against:** H-8 complete and frozen (`e919d40`, PR #3 open/draft, hosted CI green).
**Purpose:** establish the exact, evidence-backed boundary of H-9 before any implementation is authorized.

> Every finding below is tied to an existing readiness finding, an H-8 residual, or a concrete
> operational evidence gap. Nothing is proposed because it "could be improved". Where a claim is
> documentary rather than demonstrated, it is recorded as such and **not** upgraded into a fact.

---

## 1. Executive Summary

H-9 is the register's **operational-evidence** milestone: `POST_M11_READINESS_AUDIT.md` §H-9 —
*"Operations and recovery are documented but unevidenced; documentation partly precedes
implementation"* (Severity High, evidence class E4, **Pilot requirement: Required**), reinforced by
`ACQUISITION_DUE_DILIGENCE_CHECKLIST.md` rows **D4** (backup/restore/PITR — Gap) and **E3**
(ownership/IP — Gap), and by audit §10 item **11** (*"H-9 backup/restore evidence and a named
recovery owner"*) on the pilot-blocker list.

The reconnaissance confirms the audit's characterisation with measured evidence, and sharpens it
in three ways:

1. **There is no backup of anything, anywhere — and no system to back up.** No `pg_dump`,
   `pg_restore`, PITR configuration, scheduled job, off-site target or provider integration exists
   in the tree. `ci.yml` is the only workflow and has no `schedule:`/`cron:` trigger. Every
   `DATABASE_URL` in the repository points at `localhost:5432`. `M5_CLOSEOUT_REPORT.md:25` already
   recorded this as `❌ NOT VERIFIED … No pg_dump/pg_restore drill was executed; no backup target
   configured. Blocker: environment permissioning + no scheduled job.` H-9's headline defect is
   therefore **not** a broken backup; it is the absence of one, stated as present in
   `docs/DISASTER_RECOVERY.md`.
2. **The gap is a direct contradiction of an approved decision.** `DECISIONS.md` **D-012** (MUST)
   says *"Backups are not claimed unless verified."* `docs/DISASTER_RECOVERY.md:19` states PITR is
   *"enabled on production from day one"*, and §II/§V/§VII describe daily backups, an off-site
   weekly job, monitoring alerts and a testing cadence with named owners. None of it exists. This is
   the documentation-truth defect the audit names, in the highest-severity place it can sit.
3. **A meaningful part of H-9 is not engineering work.** Provider selection, the data-residency
   region (`D12` PENDING, `DATA_RESIDENCY_AND_PRIVACY.md` = DRAFT), DPAs, legal review, and
   ownership/IP artefacts are founder and counsel decisions. They must be excluded from an
   engineering H-9 or H-9 will silently absorb legal scope.

**What H-9 can close inside this repository, on evidence:** the *honesty* of the operational
documents, the *operability* of the recovery procedure as written, the *decision* about what a
required readiness dependency is, the *operator tooling* a restore needs to be verifiable, and the
*durable evidence index* that makes any of it reviewable. **What it cannot close without
decisions:** a real backup (needs a host), a real restore drill (needs a backup), a named recovery
owner (needs a person), and the residency/provider gate (needs founder + counsel).

**Recommendation:** authorize H-9 as **two tranches** — T1 (repository-closeable: documentation
truth + operability + tooling + evidence index + dependency decision), and T2 (contingent: backup
and restore exercise) which **cannot start** until the founder selects a host and names a recovery
owner. See §16.

---

## 2. Starting SHA / Repository State

| Item | Value | Verified by |
| --- | --- | --- |
| Branch | `arena/h8-platform-support` | `git rev-parse --abbrev-ref HEAD` |
| Branch HEAD | `547232c0827fb675ca2edd075398323b066490e6` (docs correction) | `git rev-parse HEAD` |
| Parent | `e919d4074a5333540b7ef9eb3cbe749cc003777e` (H-8 implementation) | `git rev-parse HEAD^` |
| H-8 base | `dca6a84dde48254b45f233fe09d4654098a5ab48` (H-6 verified) | branch creation point |
| `main` (remote) | `2c5a50644da86f77ccd1ad9ce21a8b80bad7b21a` — untouched | `gh api …/branches` |
| PR #3 | **OPEN**, `draft=true`, base `main`, head `547232c`, `MERGEABLE` | `gh pr view 3` |
| Other remote branches | `arena/h6-ci-verification` `dca6a84`; `arena/h6-hosted-diagnostic` `ae2c14e`; `arena/01a0ce9b-scolaira` `f7d7e83` | `gh api …/branches` |
| Hosted CI | run `36238146341` @ `547232c` — 3/3 jobs pass (53 files/642 tests; readiness gate; release gate 68/68 + 32/32 across chromium + webkit) | `gh run view` |
| Working tree | clean apart from intentional untracked `.env.local.bak` | `git status --porcelain` |
| Migrations | `0000`–`0050`; `scolaira`, `scolaira_test`, `scolaira_e2e` all at 50; `/api/ready` → `ready`, schema 50/50 | earlier verification |

No H-9, A5 or M12 work has started. This report changes nothing in the repository.

---

## 3. Existing H-9 Inputs (source of truth, reconciled)

| Source | What it says about H-9 | Status of the claim |
| --- | --- | --- |
| `docs/readiness/POST_M11_READINESS_AUDIT.md` §H-9 | Operations/recovery documented but unevidenced; docs partly precede implementation. Severity **High**, class **E4**, Pilot requirement **Required**, ADQ requirement "evidence pack index with owners and dates". Remediation: *"Either evidence each claim (config, drill log, contract, owner) or downgrade the document to match reality. Add a documentation-truth pass."* | The governing definition of H-9 |
| Same, §9 (consolidated) | *"H-9 in full, plus M-9, M-8 and L-4."* Missing: backup existence, restore exercise, measured RTO/RPO, named off-site ownership, provider contracts, data-residency proof, ownership/IP artefacts, docs-truth pass | Boundary statement: H-9 is the operational core of this list |
| Same, §10 item 11 | *"H-9 backup/restore evidence and a named recovery owner"* — pilot blocker, before real data/real money | Elevates it from hygiene to gate |
| Same, §11 | H-9 grouped with H-2/H-5/H-7 as acquisition blockers | Diligence consequence |
| Same, §12 grouping **R6** | *"Observability and release evidence (H-6, H-9)"* — readiness probe, seeded CI E2E, multi-browser pass, **backup/restore drill record**. H-6 half is done and hosted-proven | Sequencing: H-6 → H-9 |
| `ACQUISITION_DUE_DILIGENCE_CHECKLIST.md` **D4** | *"Gap (E4): `docs/DISASTER_RECOVERY.md` describes intent; no drill record, no measured RTO/RPO, no named off-site owner"* → must close **H-9** | Direct mapping |
| Same **D5** | Data residency `Partial (E4)`, doc partly draft → **H-9** | Decision-gated (see F19) |
| Same **E3** | Ownership/IP artefacts `Gap (E4)`, not located in the audited tree → **H-9** | Non-engineering (see F18) |
| Same **E6** | Handover completeness `Partial` → **H-9, M-9** | Split ownership |
| Same §F item 3 | *"Operational evidence pack — a dated, owned backup and test-restore record, readiness-probe output, and a seeded authenticated E2E CI run."* | Concrete artefact list for H-9 |
| `docs/DECISIONS.md` **D-012** | *"Backups are not claimed unless verified."* (MUST) | The rule the current docs break |
| `docs/DECISIONS.md` **D-013** | All critical infrastructure ultimately founder/company-owned (GitHub, Domain, Vercel, Supabase, Paystack, Resend, monitoring) | Ownership frame; also the list of unintegrated providers |
| `docs/DECISIONS.md` **D-017** | Data-residency decision document required before production student data; *"selecting a hosting region does not itself equal legal compliance"* | Gate for residency |
| `M5_CLOSEOUT_REPORT.md:25` | Backup/restore **NOT VERIFIED**; no drill executed; no backup target; blocker = environment permissioning + no scheduled job | The earliest honest record; still true |
| `M6_RECONNAISSANCE_REPORT.md:511`, `M8_RECONNAISSANCE_REPORT.md:282`, `M9_CLOSEOUT_REPORT.md:229` | Backup/restore drill repeatedly *not claimed as verified* by repository execution | Consistent, dated disclosure |
| `docs/RISK_REGISTER.md` **R-010** (key-person / bus-factor, P1) | Mitigation incl. *"runbooks for deploy/backup/restore; cross-train"* — the runbooks are not yet produced | Ownership/runbook gap |
| `docs/RISK_REGISTER.md` **R-011** (no remote git back-up, P0) | Code-exists-only-in-sandbox risk; mitigation = GitHub remote + push per milestone. Distinct from *data* backup, and already mitigated for this workspace (branch pushed, remote verified) | Not an H-9 gap |
| `docs/RISK_REGISTER.md` **R-024** (NDPR/legal sign-off before real data, P1) | Residency decision + legal review gate before production data; test data only until then | Confirms F19 is a founder/counsel gate |
| `docs/PRODUCT_ROADMAP.md` Phase 9 item 8 | *"Automated backup verification + quarterly restore drills"* — **post-pilot scale phase** | Distinguish: roadmap = automation later; H-9 = evidence now |
| H-8 inputs | H-8 `D-1` — *"Email delivery is H-9 territory"* (founder-approved link-only v1); H-8 closeout §6 residuals; H-6 closeout residual #4 (logs only) and #5 (readiness dependency decision is H-9) | The H-8 → H-9 handoff |

---

## 4. Current Evidence by Area

### 4.1 Backup and restore

| Aspect | Documented | Implemented | Evidenced |
| --- | --- | --- | --- |
| Backup mechanism | Supabase daily logical backups; PITR from day one; 30-day retention; weekly encrypted `pg_dump` off-site (`DISASTER_RECOVERY.md` §II) | **Nothing.** No `pg_dump`/`pg_restore` in the tree (`grep` over `*.ts|*.tsx|*.sh|*.mjs|*.yml|*.sql` → only two unrelated prose comments in `app/api/payment-links/route.ts:139` and `0046_r3_public_surface_hardening.sql:27`). No scheduled workflow (`ci.yml` only; no `schedule:`/`cron:`). No storage target | **No** |
| Restore procedure | Five scenarios (§IV A–E): data-fix, PITR restore, catastrophic loss, bad deploy, secret compromise | No `/docs/ops/`, no `/ops/scripts/`, no maintenance-mode feature flag, no replay tool, no `Vercel` project to roll back | **No** |
| Restore verification | Cadence table (§V): monthly local `pg_dump`→empty Postgres, quarterly PITR-to-staging, bi-annual tabletop; *"Every test records: time taken, issues found, manual steps required, whether RPO/RTO met"* | No record of any test; no tooling that would produce one; no ops invariant-check script (`scripts/` holds `apply-migrations.ts`, `bootstrap-roles.sql`, `e2e-https-proxy.mjs`, `e2e-tls-cert.ts`, `migrate.ts`, `provision-db.sh`, `public-surface-ops.ts`, `seed-e2e.ts`, `verify-m8-concurrency.ts`) | **No** |
| Ownership | Cadence table names "Engineering" / "Founder + Engineering"; §IX promises `/docs/ops/emergency_contacts.md` | No named individual; file does not exist | **No** |
| Recovery assumptions | RPO ≤1h pilot / ≤5min mature; RTO ≤4h pilot / ≤1h mature; `ASSUMPTIONS.md` **A32** assumes weekly off-site + PITR is sufficient | Never measured against anything | **No** |
| PITR / off-site | Supabase Pro PITR (7-day pilot), separate-region encrypted dump, "off-site backup location chosen with legal review" | No provider, no region, no account | **No** |

### 4.2 Production operational readiness

| Aspect | State |
| --- | --- |
| Deployment/release evidence | **None.** No `vercel.json`, `Dockerfile`, compose file, `fly.toml`, `render.yaml` or `Procfile`. No environment has ever been deployed from this repository. The only release evidence is CI (a run, its artifacts, and the hosted PR checks) |
| Environment requirements | `.env.example` is the only schema; it documents Supabase, Paystack, Resend, Sentry, DB and session vars. `README.md:94` says later milestones "add DB, Supabase, Paystack, Resend" |
| Readiness/health evidence | **Implemented and hosted-proven.** `/api/ready` asserts `database`, `schema`, `auth` and fails closed; `/api/health` is liveness only. Evidence: `e2e/readiness.spec.ts` (4 tests), `tests/auth/h6-readiness.test.ts`, CI jobs "Readiness gate" and "Release gate", `H6_RELEASE_EVIDENCE_CLOSEOUT.md`, hosted run `36238146341` |
| Operational checks | `instrumentation.ts` emits one `startup_configuration` JSON line per boot (`lib/ops/log.ts`); one `readiness_failed` line per non-ready probe. Nothing consumes them |
| Failure handling | Structured refusal reasons with a documented diagnosis table (`docs/OPERATIONS.md` §III). Application-level only |
| Recovery procedures | Documented as intent, referencing infrastructure that does not exist (see 4.1) |

### 4.3 Provider / infrastructure evidence

| Provider | Declared in env | Referenced by code | Integrated | Documented as |
| --- | --- | --- | --- | --- |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `…_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (`lib/security/env.ts:39-43`) | No | No | The database/auth/storage stack (`README.md:35`, `OPERATIONS.md` §II/§X, `DISASTER_RECOVERY.md`, `DATA_RESIDENCY_AND_PRIVACY.md` §IV) |
| Paystack | public/secret/webhook keys (`:44-48`) | No | No | Payments + webhooks (`README.md:36`, `API_CONTRACTS.md` §S/§T) |
| Resend | `RESEND_API_KEY`, `FROM_EMAIL_ADDRESS` (`:49-52`) | No | No | Transactional email; `FROM_EMAIL_ADDRESS` "referenced by no code" (measured in `H8_SCOPE_MAP.md` §2 D1) |
| Sentry | `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (`:53-55`) | No | No | The error-tracking tool (`OPERATIONS.md` §II), contradicted by `OPERATIONS.md` §IV ("does not exist yet") |
| Uptime monitor | — | — | No | Named as needed for `/api/ready` (`OPERATIONS.md` §II) |
| Payment/webhook routes | — | — | **Missing**: `app/api/comms/send-receipt`, `app/api/webhooks/*`, `app/api/pay/:token/initiate` are documented (`API_CONTRACTS.md:179,228,232`) and do not exist |

**Implemented payment surface:** tokenised public payment **links** plus a credential-gated submission path (R1/R3). There is no outbound provider call anywhere; `webhook_events` exists as a table (M5 foundation) with no webhook route.

### 4.4 H-8 deferred items that touch H-9

- **Invitation delivery (H-8 `D-1`, founder-approved).** Expiring/single-use/org-scoped links; the inviter copies the URL from `app/(app)/members/invite/invite-form.tsx`; the migration records the decision (`0050` header: *"this phase ships a link, not email"*). `H8_SCOPE_MAP.md` §2 D1 states: *"provider work belongs to H-9"*.
- **Reminder channel precedent.** `lib/db/repo/reminders.ts:66-67`: PRINT is delivered synchronously; unsupported external channels are *queued as PENDING until a provider actually delivers them*. The queue exists; the drain does not.
- **Support-mode operator identity (D-3).** The platform-support plane is built and audited (H-8), and the boundary is pinned: a **membership-less** platform administrator can never hold a session (DB-level). Operational consequence: a real support operator must hold a membership somewhere.
- **H-8 residual #6 (e2e DB reuse).** Local runs reuse `scolaira_e2e` and assert audit **deltas**; hosted CI provisions a fresh database, so the delta assertions pass there for the right reason. The residual is local-only.
- **H-8 residual #5 (WebKit not in the local default path).** Hosted CI runs both engines.
- **H-6 residual #4/#5.** Error reporting is logs only (`SENTRY_DSN` parsed, unused); the readiness **required-dependency set** is explicitly *"a decision for H-9"*.

### 4.5 Acquisition / diligence evidence

| ADQ row | Status | What exists | What is missing |
| --- | --- | --- | --- |
| **D4** backup/restore/PITR | Gap (E4) | Intent document | Config, drill record, measured RTO/RPO, named off-site owner |
| **D5** data residency | Partial (E4) | DRAFT document with candidates, sub-processor list, retention, erasure, NDPR sections | Region decision (D12), DPAs, latency tests, counsel sign-off |
| **E3** ownership/IP | Gap (E4) | Nothing (no `LICENSE`, `COPYRIGHT`, `CONTRIBUTING`, `NOTICE`, terms or privacy artefacts at root) | Assignments/ownership artefacts |
| **E6** handover | Partial | Operations/DR/API/architecture + readiness package | Executable runbooks, owners, dated evidence index |
| ADQ §F.3 operational evidence pack | Partial | Readiness probe output (CI artifact), seeded authenticated CI run (hosted, both engines) | **Dated, owned backup + test-restore record** |
| D2/D3/D6/D7 | closed by H-6 / ready / tracked | CI E2E on migrated seeded DB, product screenshots, typecheck+unit evidence | D7 hygiene remains M-8 |

### 4.6 Documentation hygiene relevant to H-9

| Document | Defect | Measured |
| --- | --- | --- |
| `docs/DISASTER_RECOVERY.md` | States PITR/backups/off-site/monitoring/cadence as facts | §II A–B, §V, §VII; nothing exists; contradicts `D-012` |
| `docs/DISASTER_RECOVERY.md` | References `/docs/ops/` and `/docs/ops/emergency_contacts.md` | Neither exists |
| `docs/DISASTER_RECOVERY.md` §VI | *"Every migration is applied to staging first"*; *"Each migration has a rollback plan"* | No staging; **no migration contains a rollback plan** (`grep` for rollback text → none) |
| `docs/DISASTER_RECOVERY.md` §IV.D | Rollback via "Vercel Instant Rollback" | No Vercel project |
| `docs/OPERATIONS.md` §I | Environments table (preview/staging/production URLs, deploy triggers) | Only `local` exists |
| `docs/OPERATIONS.md` §II | Observability stack names Sentry, Vercel Analytics, an uptime vendor | §IV of the same file says Sentry "does not exist yet"; no vendor integrated |
| `docs/OPERATIONS.md` §III example | `"applied":49,"expected":49,"latest":"0049_…"` | Now **50** / `0050_member_invitations` — stale after H-8 |
| `docs/OPERATIONS.md` §V | Alert list (readiness >2min, backup failure, invariant violation, 5xx spike) | No delivery mechanism exists |
| `docs/OPERATIONS.md` §XII | Cost table (Vercel, Supabase, Sentry, Resend) | Spend lines for unintegrated providers |
| `README.md:35-37` | `Auth: Supabase Auth (M3)`; `Payments: Paystack webhook integration (Phase 2)`; `Hosting: Vercel + Supabase` | Auth is bespoke (`lib/auth`, H-4); no Paystack; no hosting |
| `docs/DATA_RESIDENCY_AND_PRIVACY.md` | Header says DRAFT, correctly; §XI lists unresolved gates incl. a breach-notification runbook | No breach runbook exists |
| `docs/security/M11_STAGING_VERIFICATION.md` | Audit **L-4** said untracked | **Now tracked** — L-4 is resolved; recorded here so it is not re-opened |

---

## 5. H-9 Findings

Each finding: **ID · source · current implementation/evidence · gap · classification · affected
surface · frozen-history impact · remediation direction · verification required.**

### H9-F1 — No backup mechanism exists; the document states one does
- **Source:** audit §H-9; ADQ **D4**; audit §10.11; `DISASTER_RECOVERY.md` §II; `M5_CLOSEOUT_REPORT.md:25`; `DECISIONS.md` D-012.
- **Current implementation/evidence:** none. No `pg_dump`/`pg_restore`, no PITR config, no scheduled workflow (`ci.yml` has no `schedule:`), no off-site target, no provider. All env files point at `localhost:5432`. The only truthful record is M5's "NOT VERIFIED".
- **Gap:** the artefact the pilot is told exists does not exist; there is no environment in which it could.
- **Classification:** **PRODUCTION/PILOT BLOCKER** (audit §10 item 11; `D-012`).
- **Affected surface:** `docs/DISASTER_RECOVERY.md`; host/provider choice; `scripts/`; `.github/workflows/`; `.env.example`.
- **Frozen-history impact:** none if scoped to new scripts/docs; **any** change to `lib/ops/readiness.ts` (H-6 verified) or `scripts/migrate.ts` (H-2 provenance) is a frozen-adjacent edit and must be a new commit, never an amend.
- **Remediation direction:** first *decide* the host (F5); then either implement (managed PITR + scheduled off-site dump) or downgrade the document to "no backup exists yet — recovery is not assured", naming the risk. Do not leave the current state, which asserts the opposite of the truth.
- **Verification required:** a backup artefact that can be listed (timestamp, size, location) and a restore that has been performed from it.

### H9-F2 — Restore procedures reference artefacts that do not exist
- **Source:** `DISASTER_RECOVERY.md` §IV A–E, §IX; `OPERATIONS.md` §VII, §XI.
- **Current implementation/evidence:** the procedures read as operational runbooks but depend on: `/ops/scripts/` (absent), a maintenance-mode feature flag (absent), a documented replay tool (absent), `Vercel Instant Rollback` (absent), `/docs/ops/` (absent), emergency contacts file (absent).
- **Gap:** the procedure cannot be executed as written by anyone; there is no operator runbook at all.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/DISASTER_RECOVERY.md`, `docs/OPERATIONS.md`, a new `docs/ops/` tree.
- **Frozen-history impact:** none (documentation only).
- **Remediation direction:** mark each step that depends on a non-existent artefact, and either implement the artefact or rewrite the step in terms of what an operator can actually do today (e.g. "stop the app, restore the dump into a new database, repoint `DATABASE_URL`, redeploy").
- **Verification required:** an operator following the document on a throwaway database reaches a working system without improvisation; every referenced path exists.

### H9-F3 — No restore has ever been verified; RTO/RPO are unmeasured
- **Source:** audit §H-9 (`E4`); ADQ **D4**; `DISASTER_RECOVERY.md` §V; `M9_CLOSEOUT_REPORT.md:229`; `D-012`.
- **Current implementation/evidence:** the cadence table promises monthly/quarterly/bi-annual tests and a record per test; no record exists. RPO/RTO targets (≤1h/≤4h pilot) have never been measured.
- **Gap:** *"A backup that has never been restored is an assumption, not a recovery strategy"* (the document's own epigraph) — and it has never been restored.
- **Classification:** **PRODUCTION/PILOT BLOCKER**.
- **Affected surface:** evidence artefacts (new `docs/ops/` drill record), `DISASTER_RECOVERY.md` §V.
- **Frozen-history impact:** none.
- **Remediation direction:** a dated drill record produced from an actual restore into a throwaway database, with measured times and RPO/RTO outcome, committed as evidence; repeat cadence owned by a named person.
- **Verification required:** the record exists, is dated, names the artefact restored, states the measured RTO/RPO, and is reproducible by a second operator.

### H9-F4 — No named recovery owner
- **Source:** audit §10.11 (*"a named recovery owner"*); `DISASTER_RECOVERY.md` §V ("Engineering", "Founder + Engineering"); `RISK_REGISTER.md` **R-010** (bus-factor mitigation names the missing deploy/backup/restore runbooks).
- **Current implementation/evidence:** role words only; no individual; `/docs/ops/emergency_contacts.md` does not exist.
- **Gap:** §10.11 is only half met even if a drill exists — nothing is owned.
- **Classification:** **PRODUCTION/PILOT BLOCKER** (audit §10 item 11).
- **Affected surface:** `docs/DISASTER_RECOVERY.md` §V/§IX; new contacts/ownership page.
- **Frozen-history impact:** none.
- **Remediation direction:** name the individual for backup verification, restore drills and SEV1 recovery; record them in-repo (not only in a personal store).
- **Verification required:** the document names a person; a reviewer can identify who performs the next scheduled drill.

### H9-F5 — Host / PITR / off-site location are undecided
- **Source:** ADQ **D5**; `DECISIONS.md` D-017; `DATA_RESIDENCY_AND_PRIVACY.md` §I (D12 PENDING); `ASSUMPTIONS.md` A32; `RISK_REGISTER.md` **R-024** (NDPR/legal sign-off before real data).
- **Current implementation/evidence:** candidate regions listed; engineering recommendation recorded; final decision explicitly pending founder approval and legal review; nothing provisioned.
- **Gap:** every backup/restore/residency evidence item is blocked on this decision.
- **Classification:** **DEFERRED / NOT H-9** (founder + counsel decision; engineering cannot decide a residency/DPA question).
- **Affected surface:** `docs/DATA_RESIDENCY_AND_PRIVACY.md`; provider accounts; `DISASTER_RECOVERY.md` §II.
- **Frozen-history impact:** none.
- **Remediation direction:** record it as an explicit founder gate in the H-9 plan; do **not** let H-9 pick a region under engineering cover.
- **Verification required:** a dated decision entry (region + provider + rationale) or an explicit "not decided; consequence: no backup exists".

### H9-F6 — No operator tooling to verify a restored database
- **Source:** `DISASTER_RECOVERY.md` §IV.B step 5 (*"run financial invariant health-check queries: totals match, orphaned allocations absent, no negative balances"*).
- **Current implementation/evidence:** invariant coverage exists **as tests** (`tests/db/financial-invariants.test.ts`, `M8_DATABASE_INVARIANTS.md`), not as an operator-runnable check. `scripts/` has no invariant probe.
- **Gap:** a restore cannot be *verified* by an operator without a tool, which is a precondition for F3.
- **Classification:** **OPERATIONAL HARDENING**.
- **Affected surface:** new `scripts/` entry point (owner credential, read-only), `docs/OPERATIONS.md`.
- **Frozen-history impact:** none if new; must not touch `scripts/migrate.ts` (frozen-provenance) or §14 frozen paths.
- **Remediation direction:** a read-only ops command that runs the financial-invariant queries and the RLS/privilege sanity checks and prints one pass/fail block.
- **Verification required:** running it against a deliberately damaged disposable database reports the damage; against a healthy one it reports clean.

### H9-F7 — Environment and deployment claims describe surfaces that do not exist
- **Source:** `OPERATIONS.md` §I; `DEPLOYMENT.md` §II, §VIII, §IX; README `Hosting`.
- **Current implementation/evidence:** no deployment configuration of any kind; no preview/staging/production environment has existed; no deploy checklist has been executed.
- **Gap:** documents present an operating environment that does not exist, including a rollback path.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/OPERATIONS.md` §I, `docs/DEPLOYMENT.md`.
- **Frozen-history impact:** none.
- **Remediation direction:** mark environments not yet provisioned as intent, or reduce the tables to the environments that exist plus a provisioning checklist.
- **Verification required:** every environment named in the documents either exists or is explicitly labelled unprovisioned.

### H9-F8 — No deployment/release evidence for any environment
- **Source:** audit §H-9 (*"release evidence"* is the H-6/H-9 group); ADQ §F.3.
- **Current implementation/evidence:** release evidence today = CI jobs + artifacts (`artifacts/ready.json`, `playwright-report`, `test-results`, `e2e/.artifacts/seed.json`, retention 7–14 days) + the build-pinned migration manifest (`lib/ops/migration-manifest.ts`, H-6 G11). No deployed-environment evidence exists.
- **Gap:** "the build runs and is ready" is evidenced in CI; "this was deployed and stayed ready" is evidenced nowhere.
- **Classification:** **EVIDENCE GAP**.
- **Affected surface:** release evidence artefacts; `docs/DEPLOYMENT.md`.
- **Frozen-history impact:** none (evidence artefacts only).
- **Remediation direction:** define what a deployment record contains (commit, migration tag, `/api/ready` payload, timestamp, operator) and produce one for the first real environment.
- **Verification required:** a commit-pinned record exists for a real environment.

### H9-F9 — The required readiness dependency set is undecided
- **Source:** `H6_RELEASE_EVIDENCE_CLOSEOUT.md` §6 item 5 — *"Disk, queue depth and payment-provider reachability are not part of readiness… adding more checks means deciding what 'required' means (H-9)."*
- **Current implementation/evidence:** `/api/ready` asserts exactly `database`, `schema`, `auth`; pinned by `e2e/readiness.spec.ts` (`names` must equal those three).
- **Gap:** no decision on whether anything else (e.g. backup freshness, queue depth, migration drift past a build) is required — a decision H-6 explicitly left to H-9.
- **Classification:** **OPERATIONAL HARDENING**.
- **Affected surface:** `lib/ops/readiness.ts` (**H-6 verified artefact**), `app/api/ready/route.ts`, `docs/OPERATIONS.md`, `docs/API_CONTRACTS.md`.
- **Frozen-history impact:** **⚠ Flag.** `lib/ops/readiness.ts` is part of the H-6 verified change set (`6c6bd37`), which H-8 built on and which was accepted at `dca6a84`. Adding a check means a **new commit** on a later branch — never an amend of any H-6 commit, and the `dca6a84` tested SHA must remain resolvable. The three-check contract is also pinned by an e2e test, so the *decision* and the *test* must move together.
- **Remediation direction:** decide in writing; if the answer is "still three", record the decision and its rationale so it stops being an open item; if a fourth check is added, it must degrade safely (a missing backup schedule must not make the app unready unless that is the decision).
- **Verification required:** the decision is recorded; the test asserts exactly the decided set; `/api/ready` behaviour under each new failing condition is measured.

### H9-F10 — No alert delivery path
- **Source:** `OPERATIONS.md` §V; `H6_RELEASE_EVIDENCE_CLOSEOUT.md` §6 item 4; `H6_SCOPE_MAP.md` G10.
- **Current implementation/evidence:** single-line JSON events (`readiness_failed`, `startup_configuration`) written to stdout; `SENTRY_DSN`/`SENTRY_AUTH_TOKEN` parsed and unused; no uptime monitor, webhook, mail or SMS delivery.
- **Gap:** the alert list cannot fire. Someone must watch stdout.
- **Classification:** **OPERATIONAL HARDENING**.
- **Affected surface:** `docs/OPERATIONS.md` §II/§V; optionally a provider integration (F12).
- **Frozen-history impact:** none if provider-neutral; `lib/security/env.ts` is M0-era (not frozen-provenance) but is shared.
- **Remediation direction:** either integrate a consumer (uptime checker on `/api/ready` + one alert route) or state plainly that during the pilot the operator polls the probe; do not list alerts that cannot be delivered.
- **Verification required:** a demonstrated alert from a real failing condition, or a documented manual check with a cadence.

### H9-F11 — Migration-safety claims are contradicted by the repository
- **Source:** `DISASTER_RECOVERY.md` §VI.
- **Current implementation/evidence:** claims every migration is applied to staging first, that destructive migrations need founder approval, and that **each migration has a rollback plan with a compensating migration tested before landing**. Measured: no staging exists; **no migration in `0000`–`0050` contains a rollback plan**; the runner is forward-only and tag-only.
- **Gap:** an operational safety claim unsupported by the artefacts, on the path that touches financial data.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/DISASTER_RECOVERY.md` §VI; migration practice documentation.
- **Frozen-history impact:** **⚠ Flag.** Correcting the *practice* (adding down-migrations or a rollback policy) would touch applied migrations — forbidden. Only the documentation may move.
- **Remediation direction:** document what is actually true (forward-only, expand/contract discipline, no down-migrations, restore-from-backup as the recovery path) and state the consequence: recovery depends on F1/F3.
- **Verification required:** the claim matches the tree; a reviewer can find the rollback policy and it describes the runner as it is.

### H9-F12 — Providers are documented as the stack but integrated nowhere
- **Source:** audit §H-9 (*"provider contracts"*, *"documentation partly precedes implementation"*); ADQ **E1/E2**; `D-013`.
- **Current implementation/evidence:** Supabase, Paystack, Resend and Sentry appear in `.env.example`, `README`, `OPERATIONS.md` (stack + cost table), `DATA_RESIDENCY_AND_PRIVACY.md` (sub-processor list) and `API_CONTRACTS.md` (routes). None is integrated; none of the documented provider routes exists.
- **Gap:** documentation asserts a stack (and sub-processors) that does not exist; "provider contracts" cannot be evidenced because there are no providers.
- **Classification:** **DOCUMENTATION GAP** for the operational documents named here. **The API-surface half is M-9** (`ARCHITECTURE.md`, `API_CONTRACTS.md`) and must not be absorbed.
- **Affected surface:** `README.md`, `docs/OPERATIONS.md`, `docs/DATA_RESIDENCY_AND_PRIVACY.md`, `.env.example`; provider decisions.
- **Frozen-history impact:** none.
- **Remediation direction:** mark unintegrated providers as planned; remove spend lines and sub-processor entries that imply live processing; keep the env declarations (they are harmless) but note them as unused.
- **Verification required:** every provider the operational docs call current either has code references or is labelled planned.

### H9-F13 — No delivery channel beyond link copy / PRINT
- **Source:** H-8 `D-1` (*"provider work belongs to H-9"*); `H8_SCOPE_MAP.md` §2 D1; `lib/db/repo/reminders.ts:66-67`; `0050` header.
- **Current implementation/evidence:** invitations are link-only with an explicit copy step; reminders deliver PRINT synchronously and queue other channels as `PENDING` *"until a provider actually delivers them"*. No mail/SMS transport exists.
- **Gap:** the operational path for a pilot school that expects email/SMS is manual, and queued rows have no drain.
- **Classification:** **OPERATIONAL HARDENING** — *not* a blocker: the founder approved link-only delivery (H-8 `D-1`), so the pilot path works without a provider.
- **Affected surface:** `lib/members/invitations.ts`, invite UI, `lib/db/repo/reminders.ts`, `communications`/`reminders` tables, `.env.example`, new provider module; a **new additive migration** if delivery state must be recorded.
- **Frozen-history impact:** **⚠ Flag two things.** (a) `lib/db/repo/reminders.ts` sits under frozen M-era history — verify provenance and do not modify a frozen file to add a drain; a new module is safer. (b) `0050` is applied; any change is **`0051` or later**, never an edit to `0050`.
- **Remediation direction:** if authorized, add one provider behind a single module with an outbox drain over the existing queue, env-gated and off by default; if not authorized, document the manual delivery step as the pilot procedure and mark queued channels as undrained.
- **Verification required:** either a provider dependency is injected in tests and a delivery state is recorded, or the docs state manual delivery and the queue's PENDING rows are explained.

### H9-F14 — `communications` is a provider-shaped queue with no writer or reader
- **Source:** discovery during this reconnaissance; schema at `lib/db/schema/platform.ts:66` and `0000_init.sql:324`.
- **Current implementation/evidence:** the table has `channel`, `status`, `address`, `subject`, `body`, `template`, `entity_type/id`, `sent_at`, `delivered_at`, `failed_reason`, `provider_ref` — and is referenced by **no application code** (only the schema barrel). `reminders` is what AR actually uses.
- **Gap:** a dead provider-shaped surface: ambiguous whether it is foundation or debris, which confuses the H-9 provider boundary.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/DATABASE.md`/schema docs; possibly the H-9 provider design.
- **Frozen-history impact:** **⚠ Flag.** It is created by `0000_init.sql` (applied, frozen) — it may be *used* or *documented*, but the migration may not be edited and the table must not be dropped while history is frozen.
- **Remediation direction:** decide in H-9: either adopt it as the outbox for F13 or annotate it as unused foundation.
- **Verification required:** the schema documentation states which of the two it is.

### H9-F15 — Platform support identity has no membership-less session path
- **Source:** H-8 `D-3`; `tests/auth/h8-platform-boundary.test.ts` (*"a membership-less platform administrator can never hold a session (D-3 fixture, boundary pinned)"*); H-8 closeout.
- **Current implementation/evidence:** the support plane is built and audited; the DB-level boundary deliberately prevents a membership-less platform admin from authenticating. In the e2e fixture the support operator holds a `STAFF` membership in one school and operates on another.
- **Gap:** an operational question rather than a defect — for a real pilot, who is the support operator, how is their identity provisioned, and what membership do they hold? This determines whether support access is attributable in production.
- **Classification:** **OPERATIONAL HARDENING**.
- **Affected surface:** operational provisioning documentation; the platform console (`app/platform/*`, H-8); **not** the auth boundary.
- **Frozen-history impact:** **⚠ Flag, stop-and-ask.** Any move to give platform identities a session without a membership would touch `lib/auth/index.ts` (H-4 frozen) and the M4 identity boundary. The standing instruction is *no M4 identity-boundary redesign*; hence this stays an operational provisioning question, not an implementation item.
- **Remediation direction:** document the support-operator model (identity, membership, audit expectations) in the operations runbook for the pilot.
- **Verification required:** the runbook names the operator, the membership model, and how support entries appear in the audit trail.

### H9-F16 — The operational evidence pack is incomplete
- **Source:** ADQ §F item 3; audit §H-9 ADQ requirement (*"Evidence pack index with owners and dates"*).
- **Current implementation/evidence:** readiness probe output ✔ (CI artifact, 7-day retention); seeded authenticated CI run ✔ (hosted run `36238146341`, both engines); backup + test-restore record ✘.
- **Gap:** one third of the required pack does not exist, and there is no index tying artefacts to owners and dates.
- **Classification:** **EVIDENCE GAP**.
- **Affected surface:** a new evidence index (e.g. `docs/readiness/H9_EVIDENCE_INDEX.md`).
- **Frozen-history impact:** none.
- **Remediation direction:** build the index; add rows as artefacts are produced; include the drill record when it exists (blocked on F1/F5).
- **Verification required:** each row names artefact, owner, date, and where it can be inspected.

### H9-F17 — Hosted-CI evidence is ephemeral
- **Source:** measured — `.github/workflows/ci.yml` artifact retention 7 (`unit-evidence`, `readiness-evidence`) and 14 (`release-evidence`) days; no evidence artefacts committed.
- **Current implementation/evidence:** the strongest release evidence in the project (hosted runs, both engines, `/api/ready` gate) expires; the closeout references runs by URL; there is no committed, durable record and no `artifacts/release-manifest.json` (H-6 G11 shipped the manifest *into the build* instead).
- **Gap:** a buyer or a new engineer cannot inspect the evidence after the retention window.
- **Classification:** **EVIDENCE GAP**.
- **Affected surface:** `.github/workflows/ci.yml` (retention or upload policy), a committed evidence index; a release-manifest artefact if wanted.
- **Frozen-history impact:** **⚠ Flag.** `ci.yml` is part of the H-6 accepted change set (D1/D2/format-policy edits authorized for H-6). Any edit is a **new commit** on a later branch; the H-6 accepted SHA and the H-8 tested SHA must both remain resolvable.
- **Remediation direction:** commit a short, dated evidence record per accepted milestone (run id, SHA, job results, gate outputs) into the readiness folder, and/or raise retention.
- **Verification required:** evidence for an accepted milestone is inspectable from the repository alone, without GitHub.

### H9-F18 — Ownership / IP artefacts absent
- **Source:** ADQ **E3** (`Gap (E4)`); `RISK_REGISTER.md` R-022 (pre-code GitHub/ownership).
- **Current implementation/evidence:** no root `LICENSE`, `COPYRIGHT`, `CONTRIBUTING` or `NOTICE`; nothing in the audited tree.
- **Gap:** diligence cannot see ownership assignment.
- **Classification:** **OUT OF SCOPE** for engineering H-9 (founder + counsel artefact); ADQ maps it to H-9 for *tracking*, which must not be read as an engineering deliverable.
- **Affected surface:** repository root.
- **Frozen-history impact:** none.
- **Remediation direction:** track as a founder/legal action in the H-9 plan; do not manufacture.
- **Verification required:** the artefact exists with a date, or the gap is explicitly carried as non-engineering.

### H9-F19 — Data-residency decision pending
- **Source:** ADQ **D5**; `DECISIONS.md` D-017; `DATA_RESIDENCY_AND_PRIVACY.md` §I/§XI; `RISK_REGISTER.md` **R-024** (P1 before production go-live).
- **Current implementation/evidence:** DRAFT document, candidates listed, six-step action list, and an eleven-item go-live gate — all unchecked.
- **Gap:** cannot be asserted to a school or buyer; blocks F1/F5.
- **Classification:** **DEFERRED / NOT H-9** (needs counsel and founder sign-off).
- **Affected surface:** `docs/DATA_RESIDENCY_AND_PRIVACY.md`.
- **Frozen-history impact:** none.
- **Remediation direction:** keep as a founder gate; H-9 must not claim residency is decided.
- **Verification required:** a dated decision + counsel review, or the gap carried openly.

### H9-F20 — Stale operational facts after H-8
- **Source:** measured; `docs/OPERATIONS.md:51`.
- **Current implementation/evidence:** the readiness example still shows `"applied":49,"expected":49,"latest":"0049_…"` while all three databases are at 50 / `0050_member_invitations`.
- **Gap:** an operator reading the example will mis-diagnose a healthy system.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/OPERATIONS.md` §III (and any other schema-count example).
- **Frozen-history impact:** none.
- **Remediation direction:** make the example version-agnostic or update it; add "keep the example current" to the release checklist.
- **Verification required:** no operational document contains a stale migration count.

### H9-F21 — README describes a stack the product does not use
- **Source:** measured; `README.md:35-37`.
- **Current implementation/evidence:** `Auth: Supabase Auth (M3)` (auth is bespoke, `lib/auth`), `Payments: Paystack webhook integration (Phase 2)` (absent), `Hosting: Vercel + Supabase` (absent).
- **Gap:** the first document an engineer or a buyer reads is wrong about three of the system's foundations.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `README.md`.
- **Frozen-history impact:** none (`README.md` last modified at `main`).
- **Remediation direction:** describe the implemented system; label planned integrations as planned.
- **Verification required:** every stack claim in the README has a code reference or a "planned" marker.

### H9-F22 — Internal contradictions and undeliverable alert lists in the operations pair
- **Source:** measured; `docs/OPERATIONS.md` §II vs §IV vs §V vs §XII; `docs/DISASTER_RECOVERY.md` §V/§VII/§IX.
- **Current implementation/evidence:** the observability table names Sentry as the tool while §IV of the same file says it does not exist; §V lists alerts with no delivery path; §XII budgets for providers that are not used; DR §V names owners and a record-keeping discipline that produces nothing.
- **Gap:** an operator cannot tell intent from reality; the documents disagree with themselves.
- **Classification:** **DOCUMENTATION GAP**.
- **Affected surface:** `docs/OPERATIONS.md`, `docs/DISASTER_RECOVERY.md`.
- **Frozen-history impact:** none (`OPERATIONS.md` was last touched by H-6 `6c6bd37` — edit in a **new** commit, never by amending H-6).
- **Remediation direction:** one pass with a single rule — every operational claim is either implemented (point at it) or labelled intent. Prefer a short "what is true today" section at the top of each document.
- **Verification required:** no operational document contains an unlabelled claim contradicted elsewhere in the repository.

### H9-F23 — No breach-notification runbook
- **Source:** `DATA_RESIDENCY_AND_PRIVACY.md` §VIII (NDPR: notify controllers without undue delay, target ≤24h) and §XI checkbox (*"Breach notification runbook drafted"*).
- **Current implementation/evidence:** the obligation is documented; `docs/OPERATIONS.md` §XI gives a generic incident-response summary; no breach-specific runbook, no notification templates, no contact path.
- **Gap:** a legal obligation with a stated 24-hour target has no procedure.
- **Classification:** **DOCUMENTATION GAP** (contractual/legal action, engineering writes the runbook).
- **Affected surface:** `docs/OPERATIONS.md` or a new runbook under `docs/ops/`; contact list.
- **Frozen-history impact:** none.
- **Remediation direction:** a short runbook: detect → assess → contain → notify school within 24h → support NITDA notification → record.
- **Verification required:** the runbook exists, names the notifier and the record location.

**Findings deliberately not raised:** the A5 `reminders`/`app_meta` RLS no-op and the migration runner's `DELETE` re-grant (H-8 residuals 1–3) are **A5**, not H-9; M-9 owns `ARCHITECTURE.md`/`API_CONTRACTS.md` truth; M-8 owns formatting/lint debt; the M4 identity door (F11 in H-6) stays closed-by-decision. `meta/_journal.json` and local e2e reuse are not operational evidence gaps.

---

## 6. Classification of Each Finding

| ID | Finding | Classification |
| --- | --- | --- |
| H9-F1 | No backup mechanism exists; document says one does | **PRODUCTION/PILOT BLOCKER** |
| H9-F2 | Restore procedures reference non-existent artefacts | **DOCUMENTATION GAP** |
| H9-F3 | No restore ever verified; RTO/RPO unmeasured | **PRODUCTION/PILOT BLOCKER** |
| H9-F4 | No named recovery owner | **PRODUCTION/PILOT BLOCKER** |
| H9-F5 | Host/PITR/off-site location undecided | **DEFERRED / NOT H-9** |
| H9-F6 | No operator tool to verify a restore | **OPERATIONAL HARDENING** |
| H9-F7 | Environment/deployment claims describe nothing real | **DOCUMENTATION GAP** |
| H9-F8 | No deployment/release evidence | **EVIDENCE GAP** |
| H9-F9 | Required readiness dependency set undecided | **OPERATIONAL HARDENING** |
| H9-F10 | No alert delivery path | **OPERATIONAL HARDENING** |
| H9-F11 | Migration-safety claims contradicted | **DOCUMENTATION GAP** |
| H9-F12 | Providers documented as the stack, integrated nowhere | **DOCUMENTATION GAP** (API half = M-9) |
| H9-F13 | No delivery channel beyond link/PRINT | **OPERATIONAL HARDENING** |
| H9-F14 | `communications` dead provider-shaped queue | **DOCUMENTATION GAP** |
| H9-F15 | Support-operator identity/provisioning model undocumented | **OPERATIONAL HARDENING** |
| H9-F16 | Operational evidence pack incomplete | **EVIDENCE GAP** |
| H9-F17 | Hosted-CI evidence ephemeral | **EVIDENCE GAP** |
| H9-F18 | Ownership/IP artefacts absent | **OUT OF SCOPE** |
| H9-F19 | Data-residency decision pending | **DEFERRED / NOT H-9** |
| H9-F20 | Stale migration count in operations example | **DOCUMENTATION GAP** |
| H9-F21 | README describes an unused stack | **DOCUMENTATION GAP** |
| H9-F22 | Operations pair contradicts itself | **DOCUMENTATION GAP** |
| H9-F23 | No breach-notification runbook | **DOCUMENTATION GAP** |

**Distribution:** 3 blockers · 5 operational hardening · 4 evidence gaps · 8 documentation gaps ·
2 deferred/not-H-9 · 1 out of scope.

**Blocker set is exactly audit §10 item 11**, split into its three measurable parts (backup exists,
restore verified, owner named). Two of the three are gated by a founder decision (F5/F19), which is
itself the most important finding of this reconnaissance.

---

## 7. Exact Files / Tables / Routes / Workflows Involved

**Documents (primary H-9 surface — all editable in new commits):**
`docs/DISASTER_RECOVERY.md` · `docs/OPERATIONS.md` · `docs/DATA_RESIDENCY_AND_PRIVACY.md` ·
`docs/DEPLOYMENT.md` · `README.md` · `docs/API_CONTRACTS.md` (M-9 boundary) · new `docs/ops/`
runbooks · new evidence index under `docs/readiness/`.

**Code / scripts (only for F6, F9, F10, F13 — each a new commit):**
`lib/ops/readiness.ts` ⚠H-6 · `app/api/ready/route.ts` ⚠H-6 · `lib/ops/log.ts` ·
`lib/security/env.ts` · `.env.example` · `instrumentation.ts` · `scripts/` (new entry point only) ·
`lib/members/invitations.ts` / invite UI (F13) · `lib/db/repo/reminders.ts` ⚠frozen-provenance (F13).

**Tests that would move with them:** `e2e/readiness.spec.ts` (pins the three checks) ·
`tests/auth/h6-readiness.test.ts` · `tests/auth/h8-invitations.test.ts` (if delivery state is added).

**Tables:** `communications` (unused; F14) · `reminders` (PENDING queue; F13) · `member_invitations`
(F13 delivery state, requiring `0051`+ if needed) · `idempotency_keys`, `webhook_events` (unused
provider foundation).

**Routes:** `/api/ready`, `/api/health` (F9/F22) · documented-but-absent `/api/comms/send-receipt`,
`/api/webhooks/*`, `/api/pay/:token/initiate` (F12, M-9 half).

**Workflows:** `.github/workflows/ci.yml` only — ⚠H-6 change set. No `schedule:`/`cron:` exists, which
is the structural reason F1 has no automated backup.

---

## 8. Frozen-File Impact

| Proposed work | Frozen surface touched | Verdict |
| --- | --- | --- |
| F1/F3/F4/F5/F8/F16/F17 — evidence, ownership, decisions, index | none | **Safe** (docs + new artefacts) |
| F2, F7, F11, F12, F20, F21, F22, F23 — documentation truth | none; note `docs/OPERATIONS.md` was last touched by H-6 `6c6bd37` | **Safe as a new commit** — never amend an H-6 commit |
| F6 — restore-verification tool | none if new file; must not edit `scripts/migrate.ts` | **Safe** |
| F9 — add/keep readiness checks | **`lib/ops/readiness.ts`, `app/api/ready/route.ts`** = H-6 verified (`6c6bd37`/`dca6a84`), plus `e2e/readiness.spec.ts` which pins the three-check set | **Flag** — new commit on a later branch; the tested SHA `dca6a84` and H-8's `e919d40`/`547232c` must remain resolvable; contract + test move together |
| F10 — alert delivery | provider-neutral code; touches `lib/security/env.ts` (M0 provenance, not frozen-provenance) | **Safe**, but do not entangle with `ci.yml` unless required |
| F13 — email/SMS provider | `lib/db/repo/reminders.ts` (frozen M-era provenance), `0000`/`0050` migrations; new delivery state ⇒ `0051`+ | **Flag** — prefer new modules; never edit applied migrations; if a frozen file must change, stop and ask |
| F15 — platform session without a membership | **`lib/auth/index.ts` (H-4 frozen) + M4 identity boundary** | **STOP** — this reconnaissance does not authorize it; keep as documentation |
| F11 — real rollback plans for migrations | applied migrations `0000`–`0050` | **STOP** — forbidden; documentation only |
| F14 — dropping/altering `communications` | `0000_init.sql` | **STOP** — use or document it; do not edit or drop while history is frozen |
| Any A5 material (RLS no-ops, runner re-grant) | `0019`, `scripts/migrate.ts`, post-0044 tables | **NOT H-9** — belongs to A5 |

**No frozen milestone needs to be modified to close any finding classified DOCUMENTATION GAP,
EVIDENCE GAP, or PILOT BLOCKER as scoped in §10.** The three `Flag` rows are the only ones that touch
verified territory, and each can be satisfied without a rewrite.

---

## 9. Dependencies

1. **Founder decisions gate the blockers.** F1 ← F5 (host/PITR/off-site) and F19 (region/legal). Until
   both are decided, "backup exists" cannot be produced; the honest interim state is "no backup
   exists", which F2/F22 require the documents to say.
2. **F4 (owner) gates F3 (drill).** A drill record needs an owner to hold the cadence.
3. **F1 gates F3.** A restore drill needs a backup.
4. **F6 gates a *verifiable* F3.** Without an invariant probe, a restore cannot be signed off.
5. **H-8 is the prerequisite and it is done:** the support plane, invitations and mobile shell are
   closed; F13/F15 are the only H-8-adjacent items left.
6. **H-6 is the prerequisite for F9/F17 and it is hosted-proven:** the readiness contract, the CI
   gates and the build-pinned manifest exist; H-9 extends them rather than creating them.
7. **A5 is independent and must not be merged into H-9** (RLS no-ops, runner re-grant).
8. **M-9 is adjacent:** the documentation-truth pass must split — operational documents here
   (`OPERATIONS`, `DISASTER_RECOVERY`, `DATA_RESIDENCY`, `DEPLOYMENT`, `README`), architecture/API
   contracts there.
9. **Environment reality gates F8/F10:** no deployed environment exists, so deployment and alerting
   evidence cannot be produced until one does.

---

## 10. Proposed H-9 Execution Order

Ordered so that repository-closeable work lands first and nothing claims more than it can prove.

**Tranche 1 — Repository-closeable (no external dependency).**

1. **H9-1 · Operational truth pass (F2, F7, F11, F12, F20, F21, F22, F14).** Rewrite the operational
   documents so every claim is either implemented-and-pointed-at or labelled intent; add the "what is
   true today" section; remove or mark undeliverable alerts, unprovisioned environments, unused
   providers, stale schema counts, and the rollback-plan/staging claims. Decide and record the
   `communications` verdict. *No code changes.*
2. **H9-2 · Readiness dependency decision (F9).** Decide the required set in writing; if it changes,
   change `readiness.ts`, `/api/ready` and `e2e/readiness.spec.ts` in one commit and measure each new
   failing condition. If it stays at three, record the decision and the rationale.
3. **H9-3 · Restore-verification tool (F6).** A read-only ops command that runs financial-invariant,
   privilege and RLS sanity checks and prints one pass/fail block; prove it detects deliberate damage
   on a disposable database.
4. **H9-4 · Operator runbooks (F2, F23, F15).** Create `docs/ops/`: restore-to-clean-database (the
   path that actually exists today), incident/SEV summary, breach notification with a 24-hour target,
   and the support-operator model (identity, membership, audit expectations).
5. **H9-5 · Evidence index and durable records (F16, F17, F8).** A committed, dated index naming
   artefact, owner, and inspection path — including the hosted runs already produced
   (`36238146341`, H-6 runs) so the evidence survives the 7–14-day artifact retention. Define the
   deployment-record shape for F8.
6. **H9-6 · Alert path decision (F10).** Either integrate a consumer for `readiness_failed`/`/api/ready`
   or document the manual pilot check with a cadence. No half-measures.

**Tranche 2 — Contingent on founder decisions and a real environment.**

7. **H9-7 · Backup mechanism (F1, F5).** In the selected host/region: automated backups + PITR + a
   scheduled off-site dump. Requires the founder decision; cannot be started before it.
8. **H9-8 · First restore drill (F3, F4).** Restore from a real backup into a throwaway database,
   verify with H9-3's tool, record measured RTO/RPO, name the owner, commit the record.
9. **H9-9 · Deployment record (F8) and alerting evidence (F10).** First real environment: readiness
   gate green, deployment record committed, one alert demonstrated end to end.
10. **H9-10 (optional, separate authorization) · Provider boundary for delivery (F13).** Only if the
    founder wants email/SMS for the pilot; one provider behind one module, off by default, outbox over
    the existing queue, new migration if state is recorded.

**Explicitly not in any tranche:** A5, M-9's architecture/API truth pass, M12, the M4 identity
boundary, provider *selection* (F5/F19 — founder), ownership artefacts (F18 — counsel).

---

## 11. Proposed Acceptance Gates

| Gate | Statement | Measurement |
| --- | --- | --- |
| G1 | **No operational document asserts an unimplemented capability as current.** | For each claim in `OPERATIONS.md`, `DISASTER_RECOVERY.md`, `DEPLOYMENT.md`, `DATA_RESIDENCY_AND_PRIVACY.md`, `README.md`: either a code/config reference or an explicit "planned/intent" label. Reviewer-checkable list in the closeout |
| G2 | **Backup exists and can be listed.** | A command an operator can run that prints backup artefacts with timestamps and locations, plus their schedule configuration. *(T2 only)* |
| G3 | **Restore has been performed and verified.** | A dated drill record: source artefact, target, steps, wall-clock times against the stated RTO, measured data-loss window against the stated RPO, issues found, sign-off. *(T2 only)* |
| G4 | **A named recovery owner exists in-repo.** | The owner is named for backup verification, drill cadence and SEV1 recovery |
| G5 | **A restore can be verified by a tool, not a person's judgement.** | H9-3's command reports PASS on a healthy restored database and FAIL (naming the violation) on a deliberately damaged one |
| G6 | **The required readiness set is decided and pinned.** | The decision is recorded; `e2e/readiness.spec.ts` asserts exactly that set; each failure mode of any new check is measured |
| G7 | **The operational evidence pack is complete and indexed.** | Index rows for readiness output, seeded authenticated CI run (both engines), backup artefact, and drill record — each with owner and date |
| G8 | **Evidence survives artifact expiry.** | An accepted milestone's evidence is inspectable from the repository without GitHub |
| G9 | **Runbooks are executable by a second operator.** | A second operator follows the restore runbook on a disposable database and reaches a working system without improvisation |
| G10 | **Frozen history intact.** | The nine named frozen files blob-identical to base; no frozen commit amended; no applied migration edited; `0000`–`0050` unmodified; new migrations (if any) numbered `0051`+ |
| G11 | **Scope discipline.** | No A5, M-9-architecture, M12 or M4 work in the change set; the closeout states which findings were deliberately left |

---

## 12. Required Adversarial / Regression Tests

1. **Restore-verification tool detects damage** (H9-3): seed a disposable database, then apply each
   class of damage in turn — orphaned allocation, negative balance, invoice total ≠ allocation sum,
   a payment without its audit event, a tenant row readable from another tenant's context — and require
   the tool to name the violated invariant each time. A tool that reports PASS on a damaged database
   is worse than no tool.
2. **Tool is read-only:** run it as the runtime role against a live-shaped database and assert no
   `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` is attempted (the operator path must not be able to change
   financial truth).
3. **Readiness contract regression** (H9-2): the existing four `e2e/readiness.spec.ts` assertions plus
   `tests/auth/h6-readiness.test.ts` must still pass; if the set changes, add a test per new failure
   mode asserting `503` + the machine-readable reason, and one asserting `/api/health` still says
   nothing about dependencies.
4. **Restore runbook rehearsal:** following the written steps from a fresh dump into an empty
   database, the app serves `/api/ready` = `ready` and the seeded journey passes.
5. **Documentation-truth negative test (manual, but enumerated):** the closeout must contain the claim
   matrix from G1 — this is the anti-regression for F22 (the pair contradicting itself).
6. **Evidence-index integrity:** every row resolves to an artefact that exists and is dated; a missing
   artefact fails the check rather than being silently dropped.
7. **If F13 is authorized:** provider dependency injected and asserted absent-by-default; queued
   `PENDING` rows remain undrained when no provider is configured; a drain is idempotent under
   replay; delivery state is org-scoped and RLS-enforced like every other tenant table; the
   invitation token remains hashed/single-use (H-8 invariants must not regress).
8. **No frozen-history regression:** the existing frozen-history diff gate, re-run; plus the full
   Vitest suite (currently 53 files / 642 tests) and the non-`@design-system` e2e suite on both engines.

---

## 13. Required Hosted / Rehearsal Evidence

1. **Hosted CI green on the H-9 commits** — the existing three jobs, one of which already exercises the
   seeded, authenticated, two-engine release gate (`36238146341` is the current precedent).
2. **A committed evidence record per H-9 milestone** (G8): run id, SHA, job results, `/api/ready`
   output, format-gate verdict — the thing that makes the evidence outlive the artifact retention.
3. **Drill record committed as evidence** (T2): dated, signed, with measured RTO/RPO and the operator
   who ran it — the artefact ADQ D4 is missing.
4. **A rehearsal of the restore runbook in a disposable environment**, with the transcript attached to
   the drill record (mirrors how H-6 rehearsed its pipeline before claiming it).
5. **If the readiness set changes:** hosted evidence of the gate refusing a real broken state
   (the pattern H-6 established: measured `503 database_unreachable` with Postgres stopped).
6. **Statement of what H-9 does *not* prove:** no production deployment, no provider contract, no
   residency decision — carried in the closeout so it cannot be read as a production-readiness claim.

---

## 14. Explicit Non-Scope

- **A5** — `reminders_no_delete`/`reminders_no_update` RLS no-ops, `app_meta` FORCE RLS, the migration
  runner's re-grant, default-privilege leaks. Separate milestone; the H-8 closeout already routes it.
- **M12** — not proposed, not started; the audit's own note is that *"M12 adds nothing to this list"*.
- **M-9 broad truth pass** — `docs/ARCHITECTURE.md`, `docs/API_CONTRACTS.md` (the documented-but-absent
  provider routes). H-9 touches only the operational documents; the boundary is recorded in F12.
- **M4 identity boundary / the F11 door** — closed by decision; F15 stays documentation.
- **Provider selection and region (F5, F19)** — founder + counsel.
- **Ownership/IP artefacts (F18)** — counsel.
- **New product surface** — no dashboards, no metrics platform, no SLOs, no multi-school admin tooling
  (roadmap Phase 9), no billing automation.
- **Email/SMS provider integration** unless separately authorized (F13/§10 item 10).
- **Editing any frozen file, applied migration, or verified change set**; **no migration is created by
  H-9 unless F13 is authorized**, in which case it is `0051`+.
- **M-8 formatting/lint debt**, `meta/_journal.json`, local e2e state reuse.

---

## 15. Risks and Open Questions

| # | Risk / question | Why it matters | Disposition |
| --- | --- | --- | --- |
| Q1 | **Will the founder choose a host and region before H-9 T1 completes?** | T2 (the actual blocker closures) cannot start without it; if the answer is "not yet", the honest H-9 output is a *documented absence* plus the T1 work | Founder decision required first |
| Q2 | **Is the pilot expected to run without any backup?** | The audit calls this a pilot blocker. If a pilot starts before F1/F5, that is an accepted-risk decision that must be written down, not implied by an untrue document | Founder risk acceptance |
| Q3 | **Who is the recovery owner?** | Audit §10.11 names it explicitly; a role word has already been insufficient once | Founder to name |
| Q4 | **Does the readiness contract change?** | Touching `lib/ops/readiness.ts` edits H-6-verified code on a line that also carries H-8; the tested SHAs must stay resolvable and the pinned e2e contract must move with it | Decide before coding; new commit only |
| Q5 | **Is link-only invitation delivery acceptable through the pilot?** | Already approved as H-8 `D-1`; if pilot schools reject manual delivery, F13 becomes a blocker mid-pilot | Confirm expectation |
| Q6 | **Can "no backup" honestly coexist with `DISASTER_RECOVERY.md` as a document?** | The document's own epigraph and `D-012` forbid the current state; the interim rewrite must state the absence plainly or the truth pass is cosmetic | H9-1 must handle |
| Q7 | **Artifact retention** | Evidence that expires is not evidence for a diligence review months later | H9-5 commits records |
| Q8 | **Scope creep** | "Ops" easily expands into observability platforms, SLOs and monitoring stacks that belong to roadmap Phase 9 | §14 binds the tranches |
| Q9 | **A5 adjacency** | Restore verification touches privilege/RLS sanity; it must *check* them, not *fix* them (those fixes are A5 and, for `0019`, frozen) | Explicit in H9-3 |
| Q10 | **Legal/regulatory exposure** | NDPR 24-hour breach notification with no runbook, no DPAs, no residency decision | F19/F23; engineering writes only the runbook |

---

## 16. Final Recommendation

**Authorize H-9, but split it at the decision boundary.**

- **Authorize H-9 Tranche 1 now** (H9-1 … H9-6). It is entirely closable inside this repository, needs
  no provider, touches no frozen file, and converts the register's High/E4 finding from *"documented
  but unevidenced"* into *"documented as it is, with the gaps named and owned"*. It also produces the
  three artefacts the ADQ explicitly asks for (executable runbooks, a restore-verification tool, and a
  dated evidence index) minus the one that requires a backup to exist.
- **Do not authorize H-9 Tranche 2 yet.** Backup, first restore drill, deployment record and alerting
  evidence all require a host, a region and a named owner — i.e. F5, F18-adjacent and F4, which are
  founder/counsel decisions. Starting T2 without them would produce exactly the defect H-9 exists to
  remove: documents asserting what the system cannot yet do.
- **Carry three items out of engineering scope explicitly:** provider/region selection (F5/F19),
  ownership/IP artefacts (F18), and any platform-session change (F15) — the last because it would
  reopen the H-4/M4 identity boundary, which the standing directive forbids.
- **Keep A5, M-9 and M12 out.** H-9 is the operational evidence milestone; it is not a general cleanup.

**The one-line answer to "where does H-9 stand?"** — Every operational claim in the repository is
intent; none of the recovery claims is true; three findings are pilot blockers (audit §10 item 11);
two of those three are blocked by decisions only the founder and counsel can make; and the rest is a
bounded, repository-closeable truth-and-tooling pass that can start immediately.

**Awaiting explicit authorization. Nothing has been changed, committed, pushed or opened.**
