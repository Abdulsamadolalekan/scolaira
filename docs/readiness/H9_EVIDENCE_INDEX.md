# H-9 Evidence Index

> The acquisition checklist asks for an evidence pack with **owners and dates** (ADQ §F.3). Hosted CI
> artefacts expire after 7–14 days, so this file is the durable record: every row names the artefact,
> who owns it, when it was produced, and exactly where it can be inspected. Rows that describe
> something which **does not exist** stay in the table, marked `MISSING` — a missing artefact must fail
> a check rather than quietly disappear (H9-F16, H9-F17).
>
> Machine-checked by `lib/ops/evidence-index.test.ts`: a `PRESENT` row whose path does not resolve, or
> that carries no date, fails the test suite.

**Compiled:** 2026-09-26 (H-9 Tranche 1) · **Milestone:** H-9 · **Owner of this file:** unassigned
(H9-F4 — no individual is named for recovery duties; the index records that rather than inventing one).

---

## Index

| Artefact                                                  | Owner                                  | Date       | Status  | Where it can be inspected                                            |
| --------------------------------------------------------- | -------------------------------------- | ---------- | ------- | -------------------------------------------------------------------- |
| Readiness probe output — hosted CI, H-8                   | Engineering (no named individual, H9-F4) | 2026-09-25 | PRESENT | Run `36238146341`; gate outputs recorded in `docs/readiness/H8_CLOSEOUT.md` |
| Readiness probe output — hosted CI, H-6                   | Engineering (no named individual, H9-F4) | 2026-09-25 | PRESENT | Run `36211198924`; `docs/readiness/H6_RELEASE_EVIDENCE_CLOSEOUT.md`   |
| Seeded, authenticated CI run — both engines (H-8)         | Engineering (no named individual, H9-F4) | 2026-09-25 | PRESENT | Run `36238146341` — 642 unit / 68 release / 32 design-system / format gate |
| Release gate: `/api/ready` refusing a real broken state   | Engineering (no named individual, H9-F4) | 2026-09-25 | PRESENT | Measured `503 database_unreachable` with Postgres stopped; `docs/readiness/H6_RELEASE_EVIDENCE_CLOSEOUT.md` §4 |
| Restore-verification tool                                 | H-9 change set                          | 2026-09-26 | PRESENT | `lib/ops/restore-verification.ts`, `scripts/verify-restored-db.ts`    |
| Restore-verification adversarial evidence (damage detected) | H-9 change set                        | 2026-09-26 | PRESENT | `tests/db/h9-restore-verification.test.ts` (12 tests)                 |
| Restore runbook rehearsal transcript                      | H-9 change set                          | 2026-09-26 | PRESENT | `docs/ops/RESTORE_TO_CLEAN_DATABASE.md` §Rehearsal (local, disposable database) |
| Backup artefact (any environment)                         | **Unassigned**                          | —          | MISSING | No backup mechanism, host or schedule exists (H9-F1). Blocked on H9-F5/H9-F19 |
| Restore drill record with measured RTO/RPO                | **Unassigned**                          | —          | MISSING | No backup exists to restore from (H9-F3). Tranche 2, gated on H9-F1/H9-F4 |
| Deployment record (any environment)                       | **Unassigned**                          | —          | MISSING | No environment has ever been deployed (H9-F7/H9-F8). Shape only: `docs/ops/DEPLOYMENT_RECORD.md` |
| Alert delivery evidence                                   | **Unassigned**                          | —          | MISSING | No alert path exists; manual daily check is the interim control (H9-F10, D-030) |
| Emergency contact list                                    | **Unassigned**                          | —          | MISSING | `docs/ops/emergency_contacts.md` does not exist; naming people is a founder decision (H9-F4) |

## Hosted run ledger (so the evidence outlives GitHub's retention window)

| Run id        | Commit                                     | What it proves                                                             | Result |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ------ |
| `36211198924` | `dca6a84dde48254b45f233fe09d4654098a5ab48` | H-6 gate: quality + readiness jobs, seeded authenticated run, both engines   | green  |
| `36238146341` | `e919d40` (H-8 docs commit `547232c`)       | H-8 change set: 642 unit / 68 release / 32 design-system; format gate 303 touched · 189 grandfathered | green |

These runs are **hosted CI evidence**, not production evidence: nothing was deployed. Their artefacts
expire (7–14 days); the results above are recorded here so a later reader can still see what was
verified and against which commit.

## What the evidence pack does and does not contain

- **Does:** readiness output, a seeded authenticated CI run on both engines, the release gate refusing
  a genuinely broken state, the restore-verification tool and its adversarial tests, and a local
  rehearsal transcript.
- **Does not:** any backup artefact, any restore drill record, any deployment record, any alert
  delivery evidence. Four of the eight evidence classes ADQ §F.3 expects are **absent**, and their
  absence is a recorded finding (H9-F1/F3/F8/F10) rather than a blank cell.

## Currency rule

Any change to what H-9 claims must update this file in the same change set. A row is `PRESENT` only
when its path resolves **and** the artefact is dated; anything else is `MISSING` with the finding that
explains it.
