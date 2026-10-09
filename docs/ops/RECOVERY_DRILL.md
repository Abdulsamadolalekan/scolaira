# Runbook — Recovery drill (back up → restore → verify)

> **A local drill was executed for the first time on 2026-10-09** (result at the end of this file).
> What still does not exist is a _scheduled_ backup and a provider-side drill (H9-F1, H9-F3) — so this
> procedure remains written-for-a-thing-that-isn't-there-yet, and that is the point of writing it now.
> This document defines the procedure, the evidence it must produce, and the ownership it needs.
> It does not claim a recovery capability. Until a drill has been run against a real backup, the
> honest answer to "can SCOLAIRA recover?" is **UNTESTED**.

**Audience:** the operator who will own recovery — a role that is currently **unassigned** (H9-F4).
**Status today:** procedure **PRESENT** · rehearsal script **PRESENT and locally verified** ·
scheduled backup **ABSENT** · point-in-time recovery **ABSENT** · named owner **ABSENT** ·
post-drill record **ABSENT**.

---

## 0. What a drill is, and what it is not

A drill answers one question with evidence: _given the backup mechanism we say we have, how long
does it actually take to get a working database back, and does the data survive?_

| A drill is                                              | A drill is not                                     |
| ------------------------------------------------------- | -------------------------------------------------- |
| Restoring a **real** backup taken by the real mechanism | Restoring a hand-made `pg_dump` from a dev machine |
| Timed, with the numbers written down                    | "It worked when we tried it once"                  |
| Repeatable from this document alone                     | Knowledge held by one person                       |
| Evidence for an acquisition/audit question              | A substitute for having a backup mechanism         |

**A drill that fails is a successful drill.** The finding is the product. Never adjust the drill to
make it pass.

## 1. Ownership — the slots, currently empty

Named people are a founder decision (H9-F4). The slots exist so the names can be dropped in without
redesigning anything:

| Slot                      | What it owns                                                 | Assigned to    |
| ------------------------- | ------------------------------------------------------------ | -------------- |
| Recovery owner            | The capability end to end; signs the drill record            | **UNASSIGNED** |
| Drill operator            | Runs the procedure, produces the evidence                    | **UNASSIGNED** |
| Evidence reviewer         | Confirms the evidence proves what it claims                  | **UNASSIGNED** |
| Incident commander (SEV1) | Runs a real recovery under pressure (`INCIDENT_SEVERITY.md`) | **UNASSIGNED** |
| Backup-verification owner | Monthly check that backups exist and are readable            | **UNASSIGNED** |
| Drill cadence             | Proposed: quarterly, plus after any schema/mechanism change  | **UNASSIGNED** |

Filling these in is the single cheapest H-9 improvement available, and it is the founder's to make.

## 2. Preconditions

| Precondition                                   | Today                                       |
| ---------------------------------------------- | ------------------------------------------- |
| A backup mechanism that actually runs (H9-F1)  | **ABSENT**                                  |
| A backup artefact to restore from (H9-F3)      | **ABSENT**                                  |
| A target that is not production                | available (any throwaway database)          |
| A dump credential that can bypass RLS (H9-F25) | superuser today; dedicated role **ABSENT**  |
| The restore verifier                           | **PRESENT** — `npm run db:verify`           |
| The rehearsal script                           | **PRESENT** — `scripts/rehearse-restore.sh` |

## 3. The procedure

### 3.1 Rehearsal (do this first, anytime, provider-independent)

Run the rehearsable half of the procedure — dump → clean target → restore → migrate → verify — with
no provider involved. It proves the _procedure and the tooling_, never that a backup exists:

```bash
export RESTORE_REHEARSAL_SOURCE_ADMIN_URL='postgresql://<admin-or-bypassrls-role>@<host>:5432/<source_db>'
export RESTORE_REHEARSAL_TARGET_OWNER_URL='postgresql://<owner-role>@<host>:5432/scolaira_rehearsal'
export RESTORE_REHEARSAL_PLATFORM_ADMIN='<platform-admin uuid|email>'   # omit → data checks SKIPPED
./scripts/rehearse-restore.sh
```

It writes `summary.json`, `restore-verification.json` and `transcript.log` under
`h9-evidence/restore-rehearsal-<UTC stamp>/` (git-ignored — evidence must never be committed, and a
dump never belongs in a repository). It exits non-zero on any STOP, and it refuses to run against
`scolaira`, `scolaira_test`, `postgres`, `template0` or `template1` unless explicitly overridden,
because it **drops its target**.

### 3.2 Full drill (once a real backup mechanism exists)

1. **Announce** the drill and the maintenance window; confirm the target is not production.
2. **Record** the start time (UTC) and the backup's own timestamp → this is the **RPO** measurement
   (how much data was at risk between the backup and the incident).
3. **Produce the backup** with the real mechanism (§ not defined — mechanism absent, H9-F1).
4. **Restore** it into a clean database — `RESTORE_TO_CLEAN_DATABASE.md` §1–§6.
5. **Time the restore** from "start restore" to "`/api/ready` returns 200" → this is the **RTO**.
6. **Verify** with the read-only verifier; a `SKIPPED` check is not a pass:
   ```bash
   DATABASE_MIGRATION_URL="$TARGET_URL" \
     npm run db:verify -- --platform-admin <platform-admin uuid|email> --json \
     > h9-evidence/drill-<stamp>/restore-verification.json
   ```
7. **Prove the application, not just the database:** point a non-production instance at the restored
   copy, confirm `/api/ready` → `200 {"status":"ready"}`, log in, open one invoice.
8. **Write the record** (§4) and file the evidence. Then, and only then, the drill is done.

## 4. Evidence structure

Every drill produces a directory; the names are fixed so drills are comparable over time:

```
h9-evidence/drill-<UTC stamp>/
  drill-record.md              # the filled-in §5 template — the human summary
  transcript.log               # raw commands and output
  dump.txt                     # artefact name, size, sha256, timestamp (never the dump itself)
  restore-verification.json    # machine-readable verifier output
  timings.txt                  # backup start/end, restore start/end, ready-at, RTO/RPO
  screenshots/                 # optional: /api/ready output, restored record in the UI
```

Classification is mandatory on every line of a record — one of:

**VERIFIED** (measured here, raw evidence retained) · **PROVIDER-DOCUMENTED** (the provider says so;
not measured by us) · **INFERRED** (reasoned, not safe for a commitment) · **UNTESTED** (not
measured — no conclusion may be drawn) · **MISSING** (does not exist).

**Never present a local rehearsal as production or provider verification.** The rehearsal in §3.1 is
labelled _LOCAL REHEARSAL_ in its own output for exactly this reason.

## 5. Drill record template

```markdown
# Recovery drill — <YYYY-MM-DD>

Owner: <name or UNASSIGNED>
Operator: <name>
Evidence reviewer: <name>

Mechanism tested: <what produced the backup — MISSING today>
Backup timestamp: <UTC> Backup size: <bytes> sha256 <…>
Target: <database/host — non-production>

RPO measured: <backup timestamp → last known good transaction>
RTO measured: <restore start → /api/ready 200> seconds

Verification: <ok=true/false> · passed <n> · failed <n> · skipped <n>
Application check: /api/ready 200 at <UTC>; journey performed: <one line>

Findings: <what broke or was surprising — a clean run still records "none">
Follow-ups: <owner, date>
Classification: VERIFIED (this drill) / everything else labelled explicitly
Sign-off: <recovery owner>
```

## 6. Rules that do not bend during a drill

1. **Never weaken RLS to make a dump or restore work** — no `NO FORCE ROW LEVEL SECURITY`, no policy
   edits, no `BYPASSRLS` on a runtime role (H9-F25 context: use a dedicated backup identity, or the
   superuser, and record which).
2. **Never restore over a live database.**
3. **Never delete a failed drill's evidence** — a failed drill is the most valuable kind.
4. **Never record a `SKIPPED` check as a pass.**
5. **Never let the drill touch production data**, including by pointing a rehearsal at it.

## 7. Local rehearsal evidence (2026-09-28)

Run on a disposable local database — **local evidence only; not a production drill**, and not a
substitute for one:

| Step                                   | Result                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| F25 guard — dump credential attributes | `postgres super=true bypassrls=true` → assertion passed                                   |
| `pg_dump` (custom format, timed)       | 536,288 bytes, sha256 `a2170468…`                                                         |
| Restore into a clean target            | 1 s, **1 ignored error** — `COMMENT ON EXTENSION pgcrypto` (`must be owner of extension`) |
| Rows present (read as the admin)       | 2 organizations, 4 users, 5 invoices                                                      |
| `npm run db:migrate`                   | `new=0 total=50`                                                                          |
| `npm run db:verify` (read-only)        | **`ok=true`, 10 passed, 0 failed, 0 skipped**, exit 0                                     |
| Target cleanup                         | dropped, **0 residue**                                                                    |

Two defects in the rehearsal script were found and fixed by this run (a boolean-format assumption in
the F25 guard; admin connections opened against the target database before it existed). That is the
rehearsal working as intended: **the first run validates the script as much as the platform.**

## 8. What must be true before this document can report a completed drill

- [ ] A backup mechanism exists and has produced at least one backup (H9-F1).
- [ ] The slots in §1 are named (H9-F4).
- [ ] A drill has been run against that real backup, timed, and recorded (§5).
- [ ] `/api/ready` reached 200 on the restored copy, and a real journey was performed.
- [ ] The record and its evidence are stored outside the repository.

Until every box is ticked, the state of recovery at SCOLAIRA is: **UNTESTED**.

## Related

- `RESTORE_TO_CLEAN_DATABASE.md` — the step-by-step restore itself.
- `INCIDENT_SEVERITY.md` — what to do when it is not a drill.
- `../DISASTER_RECOVERY.md` — strategy, with its own status block.
- `../DEPLOYMENT.md` — environment and deploy checklist.

---

## Executed: 2026-10-09 (local, first run of this drill in the project's history)

`scripts/rehearse-restore.sh` was run against the local PostgreSQL 17 cluster: source `scolaira_e2e`
(the seeded fixture database — synthetic data only), target `scolaira_rehearsal`, created and destroyed
by the drill itself.

| Stage                | Result                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dump                 | `source-20261009T125437Z.dump`, 555,840 bytes, sha256 `d25f838b64eba4e2dcb9b26c2bf42535096b8c9afc7e9df60e671307a92e4e72`, 0 s                                     |
| restore              | 1 s, `ignoredErrors: 1`, and the ignored error was confirmed to be `must be owner of extension pgcrypto` on the extension's `COMMENT` line — the expected one     |
| data landed          | `organizations=2 users=4 invoices=5`                                                                                                                              |
| schema vs this build | `migrations: new=0 total=52`                                                                                                                                      |
| verification         | `scripts/verify-restored-db.ts` → `ok=true passed=10 failed=0 skipped=0`, with a platform administrator supplied so the data checks ran rather than being skipped |
| verdict              | `RESULT: RESTORE REHEARSAL VERIFIED (local)` — wall clock 2 s                                                                                                     |

Two things this run taught that belong in the procedure, and were only known by doing it:

1. **F25 is real, not folklore.** `pg_dump` as `scolaira_owner` died with
   `ERROR: query would be affected by row-level security policy for table "academic_sessions"`, with the
   tempting hint `use ALTER TABLE NO FORCE ROW LEVEL SECURITY`. That hint was not followed. FORCE stays.
2. **The minimum working backup privilege is narrower and stranger than "make it a superuser".**
   It needs `BYPASSRLS`, read access via `pg_read_all_data` granted **`WITH INHERIT TRUE`** (a `NOINHERIT`
   role gets a non-inheritable membership on PostgreSQL 16+, which silently yields
   `permission denied for table organizations` even though `pg_has_role()` reports membership — this cost
   a full debugging cycle), and `USAGE` on schema `drizzle` plus `SELECT` on
   `drizzle.__drizzle_migrations`, because `pg_dump` locks the migration ledger before touching data.

Transcript and summary: `/home/user/backups/restore-drill-20261009/` and, archived,
`docs/evidence/2026-10-09-pilot-prep/`.

**What this does not prove:** that any _scheduled_ backup exists; that a provider's snapshot or PITR
works; anything about a production host. The schedule and the provider half are still open —
see `docs/PILOT_SECURITY_AND_BACKUP.md` §5–§7.
