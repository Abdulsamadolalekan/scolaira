# H-6 — Release Evidence, Health/Observability & Deployment Verification (CLOSED)

> **Status:** CLOSED, PROVEN — commit `6c6bd3728aea407061c7065f8b8a8c1589288a58` (parent `ba451855bec3151f7ad8caf0503fd397ac3aca81`, 38 files, +3195/−148)
> **Scope measured first:** `docs/readiness/H6_SCOPE_MAP.md` (G1–G11), read-only against the H-4 tree.
> **Baselines preserved:** M1–M11, R1, R2, R3, H-5, H-2, H-4 untouched; `/api/health`'s false green is removed, not hidden.
> **Out of scope, unchanged:** H-8 (platform-support journey), H-9 (provider/backup drill), A5, M12, and the M4 identity-visibility door (measured, documented, not redesigned).

## 1. The defect this closes

The readiness audit says it in one line (`ACQUISITION_DUE_DILIGENCE_CHECKLIST.md` D1):
*"Does health prove the system is usable?"* — **Gap: always `ok`; `database`/`auth` = `not_configured`.*

Everything else followed from that: the deploy gate was `/api/health`, CI had no
database at all, the "release" E2E suite walked mock `/preview/*` pages with no
session, the runbook promised a readiness endpoint that did not exist, and the
provisioning script documented in the deployment path exited 2. A deployment
could be unable to serve a single request and every gate in the pipeline would
still be green.

## 2. Measured before / after (same host, same build, production server)

| Scenario | Before H-6 | After H-6 |
| --- | --- | --- |
| Database stopped (`pg_ctlcluster stop`) | `/api/health` `200 {"status":"ok"}`; login `500` | `/api/ready` **`503 database_unreachable`**; `/api/health` `200` **liveness only** (no dependency claim); login `500`; one `readiness_failed` log line |
| Database 47 or 48 of 49 migrations | `200 ok` | `/api/ready` **`503 schema_behind`** (`expected: 49`) |
| Database one migration ahead of the build | `200 ok` | `/api/ready` **`503 schema_ahead`** (`applied: 50, expected: 49, latest: 0050_…`) |
| `SCOLAIRA_SESSION_SECRET` = `"too-short"` | `200 ok`; login `500` HTML | `/api/ready` **`503 auth_unconfigured`** (`{"secretConfigured":false}`); boot line reports `authSecretConfigured:false` |
| `DATABASE_URL` unset | `200 ok` | `/api/ready` **`503 database_not_configured`** |
| Fresh database (0 migrations) | `200 ok` | `/api/ready` `503` until migrated; `200` at 49/49 |
| Readiness endpoint | `/api/ready` → `401` (middleware, route does not exist) | `200`/`503` with `Cache-Control: no-store`, probeable without a session |

Recovery was verified in the same run: with Postgres stopped and then started
again, `/api/ready` returned `503` → `200` without restarting the process (no
cached "ready").

## 3. What was implemented (G1–G11)

| Finding | Fix |
| --- | --- |
| **G1** `/api/health` constant green | Rewritten as **liveness only**: `{status, probe:"liveness", readiness:"/api/ready", version, commit, environment, timestamp}`. The `checks` block is gone; it could not be made honest, because a process probe has no business claiming database health. |
| **G2** no readiness surface | `app/api/ready/route.ts` — `200 ready` / `503 unavailable`, `nodejs`, `force-dynamic`, `no-store`, allow-listed in `middleware.ts`. Assertions live on the three checks: `database`, `schema`, `auth`. |
| **G3** migration state invisible to the runtime role | Migration `0049_h6_release_evidence.sql`: `ops_migration_state()` (`SECURITY DEFINER`, `STABLE`, pinned `search_path`) returning **only** `{applied, latest}`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO scolaira_app`, plus a self-auditing `DO $audit$` NOTICE at apply time. The runtime role still has no `SELECT` on `drizzle.__drizzle_migrations`. |
| **G4** auth readiness unverifiable | The `auth` check round-trips the real shapes: a 32-byte base64url session id and a `<token>.<sig>` CSRF header through `signSessionCookie`/verify. A short secret fails as `auth_unconfigured`; a broken crypto path fails as `auth_crypto_broken`. |
| **G5** no fail-closed path | Readiness is ready **iff** all checks are `ok`; any probe exception maps to `probe_failed`; the endpoint never throws and never returns a "degraded" middle state. |
| **G6** CI could not fail on any of it | `.github/workflows/ci.yml` rewritten: Postgres 17 service, provisioning via the (fixed) `bootstrap-roles.sql`, migrate-from-zero, unit/integration tests with a real database, production build, **a step that proves `/api/ready` returns `503` on an unmigrated database before trusting the gate**, a seeded release-gate job running the built artefact in **chromium + webkit**, evidence uploads. |
| **G7** E2E never established the product | `scripts/seed-e2e.ts` (drop/recreate a disposable database, real migrations, real repository fixtures, real identities, artefact for the specs) + `e2e/{readiness,school-journey,parent-journey}.spec.ts` + `e2e/auth.setup.ts` (real `/api/auth/login`, stored session) + a TLS front end so the suite runs the way the product is served. A missing seed fails the journey — it never skips. |
| **G8** docs promised a health surface that never existed | `docs/OPERATIONS.md` §III rewritten to the implemented contract with a diagnosis table; `docs/DEPLOYMENT.md` §VIII/IX now migrate-then-serve-then-verify-readiness; `docs/API_CONTRACTS.md` §II.V holds the wire contract; `/api/health/ready` and the fictional `checks` shape are gone from the docs. |
| **G9** provisioning script broken | `scripts/bootstrap-roles.sql`: database creation via `\gexec` (not inside a `DO` block), per-database grants behind `-v boot_db=1`, `\echo` instead of the non-existent `\warning`. Both documented invocations exit 0 (verified). |
| **G10** no machine-readable failure signal | `lib/ops/log.ts` single-line JSON events, provider-neutral: `readiness_failed` (with the failed `name:reason` list) and `startup_configuration` (build, expected migration count/tag, whether the database and auth secret are configured). `SENTRY_DSN` is documented as **parsed but unused** — no vendor is promised. (The `authSecretConfigured` flag is computed by the same predicate the probe uses, after measurement showed the naive `Boolean(process.env…)` version contradicting `/api/ready`.) |
| **G11** no release manifest | `lib/ops/migration-manifest.ts` pins the expected migration count and newest tag **into the build**; a drift test reads `lib/db/migrations/` and fails if the constant stops describing it. Readiness compares the database to that expectation, so "is this deployment ready" is always answered against the build that is running. |

## 4. Evidence index

### 4.1 Contract and adversarial tests

| Suite | Result | What it pins |
| --- | --- | --- |
| `tests/auth/h6-readiness.test.ts` | **8/8** | Positive contract: all three checks pass on a migrated database; no secret/DSN disclosure; the failure log; the 200/503 mapping of the route. |
| `tests/auth/h6-readiness-faults.test.ts` | **10/10** | Real faults, not mocks: dead socket, unconfigured DSN, an N-1 database built from the shipped migration files, a short journal, a hollow schema, ahead/skewed journals, and three auth configurations. Scratch databases are created and dropped by the suite. |
| `tests/auth/h6-release-gate.test.ts` | **17/17** | Independent re-audit (see §4.2). |
| `lib/ops/migration-manifest.test.ts` | **3/3** | The build's migration expectation matches the shipped files. |

### 4.2 Independent adversarial re-audit (separate pass)

Run as its own pass, `npx vitest run tests/auth/h6-release-gate.test.ts` → **17/17**.
It does not re-test the readiness logic; it attacks the *guarantees*:

* liveness cannot reach for a dependency (no `lib/db` / readiness import, no `process.env.DATABASE_URL`), and its payload cannot be mistaken for a dependency claim;
* readiness exists, is dynamic, `no-store`, and public;
* **CI**: has a real database, migrates it, gates on `/api/ready`, and every step that waits on liveness must also gate on readiness *or* prove readiness fails closed; a seeded run in two engines; the design-system previews stay off the release path;
* the four evidence specs exist, and the seed harness fails (not skips) when the artefact is missing;
* the seed really migrates + seeds + refuses to touch `scolaira`/`scolaira_test`;
* the suite runs the built artefact over TLS with a non-Chromium engine;
* `bootstrap-roles.sql` contains no `CREATE DATABASE` inside `DO`, no executable `\warning`, and does use `\gexec`;
* the docs describe only endpoints that exist and state the vendor integration as unimplemented;
* the startup line cannot contradict readiness about auth, and the boot hook cannot import the database layer.

The re-audit found and forced three sharpenings during development (assertions
that were too crude to be meaningful, a step that was allowed to gate on
liveness, and the `authSecretConfigured` self-contradiction — the last one was a
real defect in the new code, fixed and re-verified).

### 4.3 Full regression

* `npm test` → **50 files, 582 tests passed** (H-4 baseline was 46/544; H-6 adds four files, +38 tests).
* `npx tsc --noEmit` → clean. `npm run lint` → warnings only (pre-existing `no-explicit-any` in `lib/reconciliation/index.ts`), no errors.
* `npm run build` → production build succeeds; the boot hook emits its configuration line at startup.

### 4.4 Release gate (Playwright, production build, seeded database, TLS)

`npm run e2e:seed` → `npm run build` → `E2E_SERVER_COMMAND="npm run start" npx playwright test --grep-invert @design-system`
→ **42 passed (34.9 s)**, exit 0, on **chromium and webkit**:

* readiness gate 4/4 (database + schema + auth proven, no-store, anonymous-probeable, no disclosure)
* authenticated school journey 6/6 (real login, seeded roster, dashboard figures, a payment written and read back through a second surface, invoice journal)
* parent/payer journey 3/3 (anonymous bearer link, unknown token is not an oracle, submission logged as pending)
* platform identity authenticates 1/1 (evidence only; visibility behaviour is H-8)
* H-4 sign-out lifecycle, H-5 public-surface closure, liveness contract, `/` → `/login`: 9/9
* auth setup 2/2 (real `/api/auth/login`, state stored for the journeys)

Design-system previews (dev-only surfaces, `@design-system`): **14 passed** (a11y + preview smoke) and **8 passed** (screenshot capture subset, byte-identical output). They are deliberately excluded from the release gate because `/preview/*` is a mock surface that 404s in a production build.

### 4.5 Fresh install (from zero)

* Documented provisioning: `sudo -u postgres psql -f scripts/bootstrap-roles.sql` then `psql -d <db> -v boot_db=1 -f scripts/bootstrap-roles.sql`, both exit 0.
* `createdb -O scolaira_owner scolaira_h6fresh` + `npm run db:migrate` → **`new=49 total=49`**.
* Readiness against that database: **`200 ready`**, `applied: 49, expected: 49, latest: "0049_h6_release_evidence"`, `auth` ok.
* The release-gate database is built the same way on every run (`npm run e2e:seed` drops and recreates it, migrates from zero, then runs the journeys) — a fresh install that serves the product.

### 4.6 Upgrade (48 → 49, with the intermediate state measured)

A real 48-state database was built by applying every shipped migration except
`0049` (so the migration set is the previous release's, not a simulation):

1. **Before the migration**: `/api/ready` → **`503 schema_behind`** (`applied: null` — the state is unreadable to the 0048 runtime role, which is exactly why 0049 exists), `/api/health` → `200` liveness. A half-upgraded deployment is *not* reported ready.
2. `npm run db:migrate` (owner credential) → **`new=1 total=49`**, no errors; the migration's own audit NOTICE reported the state it could then read.
3. Journal after: `49` rows, newest tag `0049_h6_release_evidence`, **0 duplicate tags**.
4. Privilege probe: `has_function_privilege('scolaira_app','ops_migration_state()','EXECUTE') = t`, `…('public', …) = f`.
5. Same database, same build: `/api/ready` → **`200 ready`** (`applied: 49, latest: 0049_h6_release_evidence`) with no process restart.

The same migration was applied to `scolaira` and `scolaira_test` (`new=1 total=49` each).

### 4.7 Deployment verification exercises the real dependencies

The CI pipeline (`.github/workflows/ci.yml`) now:

1. starts Postgres 17 and provisions roles/databases with the shipped script;
2. migrates a database **from zero**;
3. runs the unit + integration suites against a real database;
4. builds the production artefact;
5. **proves the gate can fail**: on an unmigrated database it requires `503` from `/api/ready` and fails the job otherwise;
6. migrates, then requires `200` from `/api/ready` before continuing;
7. seeds a disposable database and runs the release-gate suite against the built artefact in chromium **and** webkit;
8. runs the dev-only design-system suite separately;
9. uploads readiness evidence, the seed artefact, the Playwright report and test results.

(The pipeline was validated by executing each command locally — that is how the
`wait-on` semantics, the unmigrated-database `503`, the seed and the two-engine
suite were confirmed. The workflow itself has not been executed on GitHub
Actions from this environment; that is a residual item.)

## 5. Invariants checked, not weakened

* **No security control was relaxed to make anything pass.** The opposite happened: the suite now runs over TLS *because* a production build marks its cookies `Secure`, and WebKit correctly refused those cookies over plain http. Rather than turning off `Secure`, the run serves the app the way the product is served (`scripts/e2e-https-proxy.mjs` + `NODE_EXTRA_CA_CERTS`; certificate verification stays on).
* The login rate limit (10 attempts / 15 min per identity and per address) is a control, not an obstacle: sessions are established once per run through the real login surface, and each run seeds a fresh database. No limit was raised.
* `TRUSTED_PROXY_HOPS` semantics (H-4/F9) are respected: the suite supplies a per-run client address the way a real proxy would, and the app still ignores forwarded addresses unless the deployment declares its hops.
* RLS, tenant scoping, authorization, CSRF, idempotency and append-only invariants are unchanged; the full regression (582 tests) plus the R1/R2/R3/H-2/H-4/H-5 suites inside it are green.
* `ops_migration_state()` is `SECURITY DEFINER` and returns two numbers: the runtime role still cannot read the journal, and `PUBLIC` cannot execute the function.
* The readiness payload was scanned for leaks in every scenario above: no DSN, password, secret, token, SQLSTATE, stack trace or row data (asserted in `readiness.spec.ts` and in the fault suite).

## 6. Residual NOT-YET-VERIFIED (honest list)

1. **The GitHub Actions workflow has not run on GitHub.** Every step was executed locally against the same services (`postgres:17`, the shipped scripts, the built artefact), and since the close-out all three jobs have been replayed end to end on the committed tree (§10, `docs/readiness/H6_CI_REHEARSAL.md`); the YAML's *runner* behaviour (service containers, artifact upload, runner image contents, `fetch-depth: 0`) is still unverified from this environment.
2. **No backup/restore drill, no scheduled jobs, no provider limits** — H-9, untouched.
3. **The platform-support journey** (platform admin operating on a tenant) is H-8: the seed provisions a platform identity and the suite proves it can authenticate; what it can *see* is the M4 identity-visibility door, measured (H-4/F11) and deliberately not redesigned.
4. **Error reporting is logs only.** `SENTRY_DSN` remains parsed and unused; alerting depends on someone watching stdout JSON.
5. **Disk, queue depth and payment-provider reachability are not part of readiness.** Only database, schema and auth are required dependencies today; adding more checks means deciding what "required" means (H-9).
6. **Repo-wide `prettier --check` is red on 226 pre-existing files** (measured at the H-4 commit as well). H-6 scopes the CI format step to changed files rather than reformatting the tree; the clean-up is its own task.
7. **`switchOrganization` remains unwired** (H-4 residual, unchanged).
8. **The design-system suite is dev-mode only** and was verified in chunks on this host (14 + 8 passing) because a dev server plus a browser exceeds the 2 GB sandbox when the full 18-screenshot capture runs in one go. The screenshots it writes are byte-identical to the committed ones.

## 7. Remaining readiness blockers (outside H-6)

The register's remaining high-severity items are unchanged: H-7/H-9 family work
(provider claims, reconciliation semantics beyond H-2/H-5), H-8 (UX and support),
and the M-list items that R8/R9 track. H-6 closes the *release-evidence* blocker
only: the system can no longer report itself healthy while it is unable to serve.

## 8. Files changed (H-6)

**New:** `lib/db/migrations/0049_h6_release_evidence.sql`; `lib/ops/{migration-manifest.ts,migration-manifest.test.ts,log.ts,build-info.ts,readiness.ts,auth-config-state.ts}`; `app/api/ready/route.ts`; `tests/auth/{h6-readiness.test.ts,h6-readiness-faults.test.ts,h6-release-gate.test.ts}`; `scripts/{seed-e2e.ts,e2e-tls-cert.ts,e2e-https-proxy.mjs}`; `e2e/{auth.setup.ts,readiness.spec.ts,school-journey.spec.ts,parent-journey.spec.ts,e2e/support/seed.ts}`; `docs/readiness/{H6_SCOPE_MAP.md,H6_RELEASE_EVIDENCE_CLOSEOUT.md}`.

**Modified:** `app/api/health/route.ts`, `middleware.ts`, `instrumentation.ts`, `playwright.config.ts`, `package.json`, `.gitignore`, `.github/workflows/ci.yml`, `scripts/bootstrap-roles.sql`, `e2e/{health.spec.ts,a11y.spec.ts,screenshots.spec.ts,h4-signout.spec.ts}`, `docs/{OPERATIONS.md,DEPLOYMENT.md,API_CONTRACTS.md}`, `docs/readiness/{POST_M11_READINESS_AUDIT.md,ACQUISITION_DUE_DILIGENCE_CHECKLIST.md}`.

## 9. How to re-run the evidence

```bash
# 1. contract + adversarial + re-audit
set -a; . ./.env.test; set +a
npx vitest run tests/auth/h6-readiness.test.ts tests/auth/h6-readiness-faults.test.ts \
                tests/auth/h6-release-gate.test.ts

# 2. release gate: seeded database, production build, both engines, TLS
npm run build
npm run e2e:seed
E2E_SERVER_COMMAND="npm run start" npx playwright test --grep-invert @design-system

# 3. the fail-closed proof, by hand
sudo pg_ctlcluster 17 main stop      # then:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/ready   # 503
curl -s http://127.0.0.1:3000/api/health                                  # 200, liveness only
sudo pg_ctlcluster 17 main start
```

## 10. Post-commit: local rehearsal of the pipeline, and the two defects it found

The workflow could not be pushed from this environment, so all three jobs were
replayed on the committed tree (`quality`, `readiness`, `e2e`) against purpose-built
databases. Full method, transcript of the gate, defects and re-verification:
**`docs/readiness/H6_CI_REHEARSAL.md`**. Two real defects surfaced and were fixed:

- the `quality` job did not declare `SCOLAIRA_DEV_ECHO_RESET_TOKEN`, which `.env.test`
  sets and the reset-lifecycle suite needs — the test was failing on the pipeline's
  environment, not on the product (fixed in `.github/workflows/ci.yml`);
- `tests/db/r1-context-isolation.test.ts` and `tests/auth/rls-bypass-regression.test.ts`
  rewrote the configured `DATABASE_URL` to a fixed database name while the fixture
  seeder used the configured database verbatim, so on a dedicated CI database the
  suites read one database and seeded another (fixed: both now use the configured
  URLs; the whitespace churn that prettier then required on those two files is
  confined to them and is semantics-free under `git diff -w`).

No frozen change set was reworked: `tests/auth/auth.test.ts`, last modified by the
frozen H-4 commit, was left untouched, and the interaction between that file's
pre-existing prettier debt and the diff-scoped format step is recorded as an open
item for the maintainer in `H6_CI_REHEARSAL.md` §4.
