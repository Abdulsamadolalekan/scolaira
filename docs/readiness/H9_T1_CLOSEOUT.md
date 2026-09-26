# H-9 · Tranche 1 Closeout

**Milestone:** H-9 (Backup, Disaster Recovery & Operational Readiness) — **Tranche 1 only**
**Date:** 2026-09-26
**Status:** T1 complete and awaiting explicit authorisation. **T2 not started. A5 not started. M12 not proposed. PR #3 not merged. `main` untouched.**

---

## 1. Shas

| Item                            | Value                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| Starting SHA (T1 base)          | `547232c0827fb675ca2edd075398323b066490e6`                                  |
| H-9 reconnaissance baseline     | `1094414527068adbab7ad79223617683fcd4c62d` (docs-only, the frozen baseline)  |
| T1 implementation commit        | `d9c9b4b2f3bd2fcabd99757f619f8c3456904090` — "H-9 T1: make the operational claims true, and make a restore verifiable" |
| T1 closeout commit              | this commit (adds this file; no code)                                       |
| Branch                          | `arena/h8-platform-support`                                                 |
| `main`                          | `2c5a506` — **unchanged**                                                   |
| PR #3                           | open, draft, **not merged**                                                 |

Chain: `main 2c5a506` → … → `547232c` (H-8 docs) → `1094414` (H-9 recon) → `d9c9b4b` (T1) → this commit.

## 2. Files changed by T1 (18 files, +2327 / −66)

**New — tooling and tests**

- `lib/ops/restore-verification.ts` (597) — the verification engine: read-only guard, 10 checks, report.
- `scripts/verify-restored-db.ts` (177) — the operator CLI (`--json`, `--platform-admin`, `--database-url`).
- `tests/db/h9-restore-verification.test.ts` (341) — 12 tests, including deliberate-damage detection.
- `lib/ops/evidence-index.ts` (156) + `lib/ops/evidence-index.test.ts` (81) — evidence-index integrity.

**New — operations documentation**

- `docs/ops/README.md`, `RESTORE_TO_CLEAN_DATABASE.md`, `INCIDENT_SEVERITY.md`, `BREACH_NOTIFICATION.md`, `SUPPORT_OPERATOR_MODEL.md`, `DEPLOYMENT_RECORD.md`.
- `docs/readiness/H9_EVIDENCE_INDEX.md`.

**Modified — operational truth pass**

- `docs/OPERATIONS.md`, `docs/DISASTER_RECOVERY.md`, `docs/DEPLOYMENT.md`, `docs/DATA_RESIDENCY_AND_PRIVACY.md`, `README.md`, `docs/DECISIONS.md` (Section IV appended; Sections I–III untouched).

**Migrations:** **none.** No file under `lib/db/migrations/` was created or modified; the chain remains `0000`–`0050`, newest `0050_member_invitations`. Any future migration takes `0051`+.

## 3. Findings addressed vs deliberately left open

| Finding | Classification | T1 outcome                                                                                                                                                     |
| ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2      | DOC GAP        | **Addressed.** Restore procedures rewritten around the path that exists; every referenced artefact either exists or is stated absent. `docs/ops/RESTORE_TO_CLEAN_DATABASE.md`. |
| F6      | DOC GAP        | **Addressed.** Read-only verification command, damage-tested.                                                                                                  |
| F7      | DOC GAP        | **Addressed.** Every environment marked unprovisioned; provider claims labelled intent.                                                                        |
| F9      | DOC GAP        | **Addressed by decision (D-029).** Required set stays the three H-6 checks; no verified file touched.                                                          |
| F10     | DOC GAP        | **Addressed as a decision (D-030).** Manual daily check recorded as the interim control; **no alerting claimed**.                                              |
| F11     | DOC GAP        | **Addressed by correction.** The rollback-plan and staging claims are corrected; retroactive plans not written (would edit applied migrations).                 |
| F12     | DOC GAP        | **Addressed.** Providers explicitly labelled not-integrated in every document that names them.                                                                 |
| F14     | DOC GAP        | **Addressed by decision (D-031).** `communications` kept, documented as having no writer/reader; not dropped.                                                  |
| F16     | EVIDENCE GAP   | **Addressed.** Evidence index with owner/date/path per row, machine-checked.                                                                                   |
| F17     | EVIDENCE GAP   | **Addressed in part.** Hosted runs committed to the index (durable past the 7–14 day window). `ci.yml` retention **not** changed — it is H-6-frozen.            |
| F20     | DOC GAP        | **Addressed.** Stale 49-migration figures and `0049` examples corrected to 50 / `0050_member_invitations`.                                                      |
| F21     | DOC GAP        | **Addressed.** README stack section corrected with an explicit stack-reality note.                                                                            |
| F22     | DOC GAP        | **Addressed.** The operations/DR pair no longer contradicts itself; undeliverable alerts are named as undeliverable.                                            |
| F23     | DOC GAP        | **Addressed.** Breach-notification runbook with a 24-hour internal target, flagged as not legally reviewed.                                                    |
| F8      | EVIDENCE GAP   | **Partially addressed.** Deployment-record *shape* defined; **no record exists** because nothing has been deployed.                                             |

| Finding | Left open deliberately | Why                                                                                                                        |
| ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| F1      | Backup mechanism       | Blocked on the host/provider decision (F5); explicitly out of T1 scope.                                                     |
| F3      | Production restore drill | Requires a backup (F1) and an owner (F4).                                                                                  |
| F4      | Named recovery owner   | Founder decision; T1 scope forbids assigning one.                                                                         |
| F5      | Host / PITR / region   | Founder + counsel.                                                                                                        |
| F13     | Provider delivery      | Separate authorisation; requires `0051`+ if state is recorded.                                                             |
| F15     | Membership-less session path | Frozen M4 identity boundary — documentation only (now described in `SUPPORT_OPERATOR_MODEL.md` §6).                  |
| F18     | Ownership/IP artefacts | Counsel.                                                                                                                  |
| F19     | Data residency decision | Founder + counsel; documented as open, including the NDPR→NDPA question.                                                 |

### Findings discovered during T1 (new, disclosed at discovery, not fixed)

**H9-F24 — the E2E seed path leaves the runtime role escalated.**
`scripts/seed-e2e.ts` re-applies a blanket `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` after
migrations and then re-applies only **three** of the append-only revokes
(`reminders, audit_events, webhook_events`). It calls `applyAllMigrations` directly rather than the
runner in `scripts/migrate.ts`, so the runner's full revoke list never runs. Measured consequence in
`scolaira_e2e`: `scolaira_app` holds `DELETE` on `invoices` and `payments` and `UPDATE` on
`audit_events` (in `scolaira` and `scolaira_test`, all absent — those paths do not have the defect).
Found by the new tool on its first use. **Not fixed: the fix is in H-6-frozen material**
(`scripts/seed-e2e.ts` is H-6's `6c6bd37`, and its grant block mirrors H-2's
`tests/global-setup-db.ts`) — a **frozen-history collision, reported rather than worked around**.
Impact is confined to local/rehearsal databases created by `npm run e2e:seed`: it does not affect a
production install (which uses `scripts/migrate.ts`), and that script refuses any database whose name
is not an E2E database. The honest reading is that an e2e database under-represents production's
append-only protections, which is exactly the kind of drift the tool exists to surface.

**H9-F25 — `pg_dump` cannot run as the schema owner.**
Every tenant table runs `FORCE ROW LEVEL SECURITY`, so `pg_dump` as `scolaira_owner` fails with
`query would be affected by row-level security policy for table "academic_sessions"`. A backup
therefore requires a role with `BYPASSRLS` or the database superuser. **No such role exists and none
was created** — adding one is a privilege-model decision (and the standing rule forbids adding a
third role to work around least privilege). This is a dependency of F1/T2, recorded in
`DISASTER_RECOVERY.md` §II and in the restore runbook's credential trap.

## 4. Evidence produced (all local; no production claim anywhere)

| Evidence                                            | Result                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vitest run` (unit + integration)                    | **55 files / 660 tests passed** (baseline 53/642; +2 files, +18 tests)                    |
| `tests/db/h9-restore-verification.test.ts`           | **12/12 passed** — healthy PASS, read-only proof, damage detection per class, no poisoned-check misattribution |
| `lib/ops/evidence-index.test.ts`                     | **6/6 passed** — the index resolves, and a vanished `PRESENT` artefact fails the suite     |
| `npx tsc --noEmit`                                   | clean                                                                                     |
| Prettier gate (formattable files in the change set)  | **clean**, none of them grandfathered (debt baseline unchanged)                            |
| `playwright test e2e/readiness.spec.ts`              | **10/10 passed, chromium + webkit** — the H-6 readiness contract this decision rests on     |
| Restore rehearsal (`docs/ops/RESTORE_TO_CLEAN_DATABASE.md`) | dump (superuser) → empty database → restore (owner) → tool **NOT VERIFIED** (inherited escalation) → `db:migrate` → tool **VERIFIED (10/10, exit 0)** |
| Aggregated suite (`npx vitest run` repeatedly)       | stable across repeats; run twice at the final change set                                   |

**The full Playwright suite did not complete locally and no result is claimed for it.** First
attempt failed at browser launch (the sandbox had been recycled and Playwright's browsers were
absent); after `npx playwright install --with-deps chromium webkit`, the non-design-system suite
exceeded the local time budget (28 minutes, 59/68 reached, at least one WebKit sign-in timeout
observed mid-run). This change set contains **no application, route, component or schema change**, so
the e2e surface it can affect is nil; the branch's e2e coverage remains CI's job, and the standing
residual (reused E2E state; WebKit coverage outside H-8) stays recorded rather than being treated as
resolved.

## 5. Frozen history — verified untouched

Verified as an empty diff from `547232c` for every frozen path, with all frozen refs still
resolving (`07ab6e8`, `ba45185`, `6ba8b14`, `66f4a0c`, `dca6a84`, `e919d40`, `547232c`, `1094414`,
`2c5a506`):

`app/(app)/members/page.tsx` · `app/api/members/route.ts` · `lib/ops/readiness.ts` ·
`app/api/ready/route.ts` · `e2e/readiness.spec.ts` · `tests/global-setup-db.ts` ·
`scripts/seed-e2e.ts` · `scripts/migrate.ts` · `.github/workflows/ci.yml` ·
`lib/ops/migration-manifest.ts` · `.github/prettier-debt.txt` — all unchanged.
`lib/db/migrations/` — **0 files changed**. No frozen commit was amended; no history was rewritten.
`.env.local.bak` remains untracked and unmodified.

## 6. Acceptance gates

| Gate | Statement                                                    | Verdict                                                                                             |
| ---- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| G1   | No operational document asserts an unimplemented capability   | **MET** — claim matrix in §7; every vendor and control is labelled.                                   |
| G2   | Backup exists and can be listed                               | **NOT MET — T2.** No backup exists (F1).                                                             |
| G3   | Restore performed and verified                                | **NOT MET — T2.** Local rehearsal only; no production restore.                                        |
| G4   | A named recovery owner exists                                 | **NOT MET — T2/founder.** Deliberately not assigned (F4).                                             |
| G5   | A restore can be verified by a tool, not judgement            | **MET** — PASS on healthy, FAIL naming the violation on damaged; asserted in tests.                   |
| G6   | Required readiness set decided and pinned                     | **MET** — D-029; the three checks are pinned by `e2e/readiness.spec.ts`, which passes on both engines. |
| G7   | Evidence pack complete and indexed                            | **PARTIAL** — index exists and is machine-checked; 4 of 8 evidence classes are absent and recorded as `MISSING`. |
| G8   | Evidence survives artefact expiry                             | **MET** — hosted runs and gate results recorded in `docs/readiness/H9_EVIDENCE_INDEX.md`.             |
| G9   | Runbooks executable by a second operator                      | **PARTIAL** — the restore runbook was rehearsed end to end locally with a transcript; steps 7–8 (repoint, record) not rehearsed, as no environment exists. |
| G10  | Frozen history intact                                         | **MET** — §5.                                                                                        |
| G11  | Scope discipline                                              | **MET** — no A5, M-9-architecture, M12 or M4 work in the change set; findings left open listed in §3.  |

## 7. G1 claim matrix — what the documents now assert

| Claim in an operational document                | State asserted after T1        | Where the truth lives                                  |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Environments (preview/staging/production)        | Not provisioned                | `OPERATIONS.md` §0/§I, `DEPLOYMENT.md` §0/§II          |
| Deploy pipeline / Vercel integration             | Does not exist                 | `DEPLOYMENT.md` §0/§X                                  |
| Automated backups / PITR / off-site backup       | Absent                         | `DISASTER_RECOVERY.md` §0/§II, `docs/ops/README.md`    |
| Restore ever verified / RTO / RPO                | Never; unmeasured              | `DISASTER_RECOVERY.md` §0/§V                           |
| Recovery owner                                   | Absent (a decision, not an oversight) | `docs/ops/README.md`, `DISASTER_RECOVERY.md` §V  |
| Restore verification tooling                     | Present, read-only, damage-tested | `lib/ops/restore-verification.ts`, `docs/ops/RESTORE_TO_CLEAN_DATABASE.md` §6 |
| Alert delivery                                   | Absent; manual daily check     | `OPERATIONS.md` §V, `docs/ops/INCIDENT_SEVERITY.md` §3 |
| Sentry / Resend / Supabase Auth / Paystack       | Not integrated                 | `README.md` stack note, `OPERATIONS.md` §0, `DATA_RESIDENCY_AND_PRIVACY.md` §0 |
| Readiness contract (3 checks)                    | Present, hosted-proven in CI   | `OPERATIONS.md` §III (50/50 figures corrected)         |
| Migration rollback plans / staging-first         | Absent — corrected in place    | `DISASTER_RECOVERY.md` §VI, `DEPLOYMENT.md` §IX        |
| `communications` table                           | Present, unused, documented    | `DECISIONS.md` D-031                                   |
| Deployment record                                | Shape defined, none exists     | `docs/ops/DEPLOYMENT_RECORD.md`                        |
| Breach notification                              | Procedure adopted, not legally reviewed | `docs/ops/BREACH_NOTIFICATION.md`              |

## 8. Remaining T2 dependencies

1. **F5/F19** host, provider, region and legal decisions (founder + counsel) — gate everything below.
2. **F1** backup mechanism, which must also resolve the `BYPASSRLS` question (H9-F25) rather than
   disabling RLS.
3. **F4** a named recovery owner.
4. **F3** the first restore drill from a real backup, verified with the T1 tool and recorded.
5. **F8** the first deployment record, once an environment exists; **F10** the first delivered alert.
6. **H9-F24** the e2e seed privilege divergence — needs authorisation to change H-6-frozen material
   (a one-line class of fix: apply the same revoke set the migration runner applies).

## 9. Residual risks (explicit)

1. **There is still no backup.** Every T1 document now says so; nothing about T1 reduces the loss
   exposure. A disk failure today is unrecoverable beyond whatever dumps someone took by hand.
2. **The verification tool could still be wrong in a way its tests do not cover.** It checks six
   financial invariants and the privilege/RLS posture; it does not check row counts against a source,
   sequence continuity, or storage objects. It is a floor, not a proof of fidelity.
3. **The evidence pack is incomplete by design** (4 of 8 classes absent), and the index will fail CI
   if a `PRESENT` row's artefact disappears — that is intended, and it means the index must be updated
   in the same change as any artefact it references.
4. **Manual detection depends on a person.** A readiness failure that starts and ends between daily
   checks is invisible (D-030).
5. **A dump taken today is taken as superuser**, because the least-privilege dump role does not
   exist. Any ad-hoc dump leaves no audited, least-privilege trail.
6. **`H9-F24` means local e2e databases are less protected than production.** Tests that rely on the
   runtime role being unable to delete financial rows are *not* exercising that property in an
   e2e-seeded database.
7. **No production evidence of any kind exists.** All H-9 T1 evidence is local or hosted-CI.

## 10. Final readiness status

**T1 complete. H-9 is NOT complete, and the product is NOT production-ready.**

What T1 changed is the *quality of the claim*: the repository now tells the truth about its
operational state, an operator has an executable and rehearsed restore path, a restored database can
be verified by a tool that fails when it should, and the evidence that would otherwise expire is
written down. What T1 explicitly did **not** do is reduce any risk that depends on a decision nobody
has made yet — there is still no backup, no recovery owner, no environment, and no delivered alert.

**Stopping here as instructed. Awaiting explicit authorisation before T2, A5, M12, or any merge.**
