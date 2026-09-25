# H-6 — Local rehearsal of the rewritten CI pipeline

**Purpose.** H-6's first residual item was *"the GitHub Actions workflow has not run
on GitHub"* — the rewritten pipeline could not be pushed from this environment, so
the strongest available substitute is to execute every job's steps locally, in
order, against the same services the workflow declares (`postgres:17`, the shipped
scripts, the built artefact), on the **committed** tree
(`99538122d2ce022186104900dc00d00705e587b3`). This document records that rehearsal,
the two defects it exposed, and what it does and does not prove.

Date: 2026-09-25 · Tree: H-6 commit + doc follow-up · Host: 2 GB sandbox, PostgreSQL 17.11.

---

## 1. Method

Each job ran against its own database, provisioned the way the workflow provisions
them (`scripts/bootstrap-roles.sql` via the superuser over TCP, then migrations), so
that the rehearsal could not pass by borrowing state from the developer databases
`scolaira` / `scolaira_test`:

| Job in `ci.yml` | Rehearsal database | Notes |
| --- | --- | --- |
| `quality` | `scolaira_cidry` (migrated 0 → 49) | mirror of the `scolaira_test` service DB in the workflow |
| `readiness` | `scolaira_cidry_unmigrated` (provisioned, never migrated) | the workflow's negative proof needs a database that has never been migrated |
| `e2e` | `scolaira_e2e` (drop/recreate by `npm run e2e:seed`) | identical to the workflow, which also uses `scolaira_e2e` |

The `quality` and `readiness` steps were replayed verbatim (`prettier` on changed
files → lint → typecheck → `npm test` → `npm run build`; then *build → start → wait
for liveness → assert `/api/ready` is 503 → migrate → assert 200*). One substitution
was necessary: **`npx --no-install wait-on` is not installed on this host**, so the
wait-for-2xx loop was reproduced with `curl` (identical semantics — resume only on a
2xx, so a 503 keeps the rehearsal waiting). The `e2e` job's own `wait-on` calls were
exercised through Playwright's `webServer`, which already gates the app on
`/api/ready`.

## 2. Result

| Job | Steps | Outcome |
| --- | --- | --- |
| `quality` | prettier (changed files) · lint · `tsc --noEmit` · `vitest run` · `next build` | **OK** — "All matched files use Prettier code style!"; lint exit 0; tsc clean; **50 files / 582 tests passed**; production build completed |
| `readiness` | 503 proof → migrate → 200 proof | **OK** — `/api/ready` `503` with `schema_behind, applied:null, expected:49` while `/api/health` stayed `200`; after `npm run db:migrate` (`new=49 total=49`) `/api/ready` returned `200` `applied:49 latest:0049_h6_release_evidence` |
| `e2e` | `e2e:seed` → release suite on the built artefact, chromium + webkit | **OK** — `42 passed (35.0s)`, exit 0 |

The first rehearsal pass of the `quality` job **failed**, 11 tests red
(`571 passed / 11 failed`). That failure is the reason this rehearsal was worth
running: the two causes are recorded below and both are fixed.

## 3. Defects the rehearsal exposed (both fixed)

**D1 — the `quality` job omitted `SCOLAIRA_DEV_ECHO_RESET_TOKEN` (1 test red).**
`tests/auth/auth.test.ts` asserts the password-reset lifecycle end to end: it calls
`POST /api/auth/reset-request` and consumes the token it gets back. That route only
returns the token when the deployment opts in with
`SCOLAIRA_DEV_ECHO_RESET_TOKEN=1` **and** `NODE_ENV !== 'production'`
(`app/api/auth/reset-request/route.ts`). The documented local environment
(`.env.test`) sets it; the workflow did not, so the assertion read `null`. The test
was measuring the pipeline's environment, not the product.
*Fix:* the workflow's `quality` env now declares `SCOLAIRA_DEV_ECHO_RESET_TOKEN: '1'`,
matching `.env.test`. This cannot affect production: the route's own guard disables
the echo there. No test file was touched.

**D2 — two suites rewrote the configured database name (9 tests red).**
`tests/db/r1-context-isolation.test.ts` and `tests/auth/rls-bypass-regression.test.ts`
replaced whatever `DATABASE_URL` they were given with a fixed `…/scolaira_test`. The
fixture seeder, however, uses `DATABASE_URL` verbatim
(`tests/support/concurrent-seed.ts`). On a dedicated CI database the result was a
suite **reading one database while seeding another**: the org membership it had just
written was invisible to the connection it asserted on, producing nine failures of
the form *"User … is not an active member of organization …"*. A verification suite
must exercise the database it was told to use — the same rewrite would also have made
the result depend on filesystem luck rather than on the code under test.
*Fix:* both suites now use `DATABASE_URL` / `DATABASE_MIGRATION_URL` verbatim. Both
files were already unformatted under prettier at the previous commit, so the
diff-scoped format step required formatting them; that churn is whitespace-only
(`git diff -w` shows only the two URL constants and their comment).

### Re-verification after the fixes

| Check | Result |
| --- | --- |
| `vitest run` with the workflow's env *exactly as now declared* (dedicated DB) | **50 files / 582 passed** |
| `vitest run` with the documented local env (`.env.test`, `scolaira_test`) | **50 files / 582 passed** |
| `readiness` rehearsal on a never-migrated database | `503` → migrate → `200` |
| Release gate (`e2e:seed`, production build, both engines) | **42 passed**, exit 0 |
| `tsc --noEmit`, `next build`, prettier on changed files | clean |

## 4. What this rehearsal proves, and what it does not

*Proves:* the rewritten jobs are mutually consistent with the repository's own
environment contract, that they pass on a freshly provisioned database with no
developer state, that the `readiness` gate genuinely fails first and opens only after
migration, and that the release suite runs green against the built artefact on a
seeded database.

*Does not prove:* runner-specific behaviour. Service containers, `actions/setup-node`
caching, `actions/upload-artifact`, `fetch-depth: 0` availability, runner image
contents (Node/Chromium versions) and the workflow's YAML interpretation remain
unexercised until the workflow actually runs on a GitHub-hosted runner. That residual
stays open.

**Open item found while doing this (not fixed deliberately).** The diff-scoped format
step checks whole files, so a change that touches a file which was *already*
unformatted before the change fails the step for a reason unrelated to the change.
Measured: `tests/auth/auth.test.ts` (last modified by the frozen H-4 commit
`ba451855…`) is already unformatted at that commit, and formatting it would rewrite a
frozen change set — so the correct handling is an explicit pre-existing-debt rule for
that step, or a deliberate, recorded reformat, not a silent widening. Recorded rather
than changed: it belongs with the repo-wide prettier debt (226 files) already listed
as a residual, and it must be decided by the maintainer rather than absorbed here.
