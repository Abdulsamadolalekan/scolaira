# H-6 Scope Map — Release Evidence, Health/Observability & Deployment Verification

**Status:** reconnaissance complete (measure-first). Nothing below was implemented before the
findings were measured against the accepted H-4 tree (`ba45185…`).
**Baseline:** `ba451855bec3151f7ad8caf0503fd397ac3aca81` (H-4 accepted).
**Audit entry under remediation:** `docs/readiness/POST_M11_READINESS_AUDIT.md` → H-6
("health endpoint is a liveness-only false green and E2E never establishes a real seeded,
authenticated system"; remediation = readiness probe proving DB connectivity, migration state and
auth configuration, failing closed; CI step that provisions and seeds a database, then runs
authenticated school, parent-payment and platform journeys, with at least one non-Chromium pass).
**Related register entries:** R6 (observability and release evidence), ADQ checklist row D1
("Does health prove the system is usable?"), LOW L-3 (preview surfaces / screenshots).

## 1. How the findings were measured

Live servers (`next dev`, real HTTP) against real databases, plus static census of the evidence
pipeline. Raw evidence: `/tmp/dev-*.log`, `/tmp/h6body.json`, `/tmp/h6login.json`, and the
47-state fixture database `scolaira_h6stale` (built through the real migration runner from
`/tmp/mig47h6`, i.e. the first 47 migration files — the same technique as the H-2 upgrade fixture).

| Probe | Condition | Result |
| ----- | --------- | ------ |
| `GET /api/health` | database **unreachable** (`…/does_not_exist`) | **200 `{"status":"ok",…"database":"not_configured"}`** |
| `POST /api/auth/login` | same broken database | **500 INTERNAL** — authentication is dead, health is green |
| `GET /api/health` | schema at **47/48** (H-2 objects absent: `financial_periods`, `scoping_settings` = 0) | **200 `{"status":"ok"}`** |
| `GET /api/health` | auth secret misconfigured (short `SCOLAIRA_SESSION_SECRET`) | **200 `{"status":"ok"}`** |
| `POST /api/auth/login` | same misconfigured secret | **500 with an HTML error page** (auth module fails at import) |
| `GET /api/ready` | any | **401 UNAUTHENTICATED** — the route does not exist and middleware intercepts it, so a monitor cannot even distinguish "missing" from "protected" |
| `npx vitest run` (any integration test) | database unreachable (CI has **no** postgres service) | globalSetup throws `ECONNREFUSED` → whole run red |
| `.github/workflows/ci.yml` | — | `0` postgres references, no migrate/seed step, `wait-on /api/health` (the false green), `chromium` only, uploads only `.next` |
| `playwright.config.ts` | — | `1` project (chromium), no DB provisioning, server started from `npm run dev` |
| E2E census | 5 spec files | `3` touch `/preview` mocks; `1` performs a real login (H-4 sign-out); `0` school/parent/platform journeys |
| `scripts/bootstrap-roles.sql` | documented provisioning command | `ERROR: CREATE DATABASE cannot be executed from a function` (line 57) and `error: invalid command \warning` (exit 2 on the documented `-v boot_db=1` invocation) |
| `SENTRY_DSN` | `lib/security/env.ts` | parsed but never used — no error signal exists anywhere (observability claim unbacked) |
| `docs/OPERATIONS.md` / `docs/DEPLOYMENT.md` | — | document `GET /api/health/ready` ("authenticated, platform admin") and "`/api/health` green" as the deploy smoke — a readiness surface that was never built, described as the deployment gate |

## 2. Findings and scope decisions

| # | Measured finding | Severity | Decision |
| - | ---------------- | -------- | -------- |
| G1 | `/api/health` is a constant green: it never touches the database, and hard-codes `database`/`auth` as `not_configured` even when they are configured and broken (measured: dead DB → `ok`; 47/48 schema → `ok`; broken auth secret → `ok`). | **High (pilot hard gate)** | **FIX** |
| G2 | No readiness surface exists at all; `/api/ready` is not a route (401 from middleware), so there is nothing a deploy gate or uptime monitor can honestly use. | High | **FIX** |
| G3 | Migration state is invisible to the running app: no runtime check that the schema this build expects is applied. Measured: a 47-state database (missing H-2 objects) serves `ok`, and the app role has **no** SELECT on `drizzle.__drizzle_migrations` (`t` schema usage / `f` table select). | High | **FIX** (compiled-in migration manifest + a SECDEF reader; forward migration) |
| G4 | Auth readiness is unverifiable: the module throws at import on a bad/short secret, which surfaces as a 500 on the login route while health stays green. | High | **FIX** (readiness check reports it, fails closed, never throws out of the probe) |
| G5 | Fail-closed is absent: every dependency failure is reported as healthy, and no check has a non-200 path. | High | **FIX** (any required check failing ⇒ `503 unavailable`) |
| G6 | CI cannot fail on any of this: no database service, no migrations, no seed, gate on `/api/health`, chromium only, and its `Unit tests` step is red-or-accidental depending on whether a DB happens to exist. | High | **FIX** (postgres service, provision+migrate+seed, gate on `/api/ready`, chromium **+ webkit**) |
| G7 | E2E never establishes the product: 3/5 specs run against `/preview` mock surfaces, none exercises an authenticated school journey, the parent payment journey, or reads seeded data; the screenshot artefact therefore evidences mockups rather than the shipped product. | High | **FIX** (seeded database + authenticated school journey + public payer journey + authenticated screenshots; preview specs retained as visual smoke and labelled as such) |
| G8 | Deployment documentation promises a readiness endpoint that does not exist and instructs operators to treat `/api/health` as the deploy gate (`docs/DEPLOYMENT.md:106`, `docs/OPERATIONS.md:25,32,47`). | Medium | **FIX** (document the implemented liveness/readiness contract) |
| G9 | The documented fresh-install provisioning script is broken: `CREATE DATABASE` inside a `DO` block always errors and `\warning` is not a psql command (exit 2). `scripts/provision-db.sh` is the working path. | Medium | **FIX** (deployment verification: the documented path must work) |
| G10 | Failure signalling: nothing emits a machine-readable signal when a dependency check fails; `SENTRY_DSN` is parsed and unused. | Medium | **FIX (bounded)** structured single-line JSON events for readiness failures + startup configuration state, no provider promises (that is H-9) |
| G11 | No release manifest: the CI artefact is `.next` alone, with no record of which commit, schema version or seed produced the evidence. | Low | **FIX** (`artifacts/release-manifest.json` + readiness probe output uploaded) |

## 3. Deliberately out of scope

* **Platform-support journey surface.** No platform/admin route or UI exists (only the
  `isPlatformAdmin`/`isPlatformSession` session flags and `components/permission-guard.tsx`).
  Building one is H-8 ("absent support journey"). H-6 therefore proves the *public and school*
  journeys end to end and asserts the platform-admin **identity contract** at the API level
  (`/api/auth/me`), and records the absence of a platform journey surface as H-8's, not H-6's.
* **Provider observability claims (Sentry/uptime vendor, backup/restore drill).** These are H-9
  (recovery, residency, provider claims). H-6 ships provider-neutral signals only.
* **Production readiness.** Passing H-6 evidences that the shipped build runs, is migrated, is
  configured and is exercised through real journeys. It does not close H-7/H-8/H-9, does not
  evidence a real deployment, and is not a production-readiness claim.
* **The identity-visibility door.** Re-measured below and recorded open; M4's boundary is not
  redesigned under H-6 (per directive).
* **General documentation hygiene (M-9/L-4) and preview-surface removal (L-3).** Only the
  health/readiness documentation that H-6 makes false is corrected.

## 4. Identity-visibility door — re-measured, unchanged, not redesigned

Against the freshly rebuilt lab (migrations at 48, runtime role `scolaira_app`), with **no** new
measurement needed beyond the H-4 record: the door is a property of the RLS policies and the
app-callable `auth_enter_system_context()`, neither of which H-6 touches. H-6 adds exactly one
new app-callable SECURITY DEFINER (`ops_migration_state()`) and it exposes **only** the applied
migration count and latest tag — it grants no table access, sets no GUC, and cannot be used to
enter a context. Its privilege delta is recorded in the migration, the closeout and the register:
the door stays open, sized as before, and is not widened.

## 5. Fix plan (forward-only, one migration)

| Finding | Change |
| ------- | ------ |
| G3 | `lib/db/migrations/0049_h6_release_evidence.sql`: `ops_migration_state()` — SECDEF, pinned `search_path`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO scolaira_app`, self-audit notice; returns `{applied, latest}` only. |
| G3, G11 | `lib/ops/migration-manifest.ts` — compiled `EXPECTED_MIGRATION_COUNT` / `LATEST_MIGRATION_TAG`, guarded by a unit test that reads `lib/db/migrations/` so the constant cannot drift from the shipped files. |
| G1, G2, G4, G5 | `lib/ops/readiness.ts` + `app/api/ready/route.ts`: three required checks (`database`, `schema`, `auth`), each with a stable reason code, no DSN/secret/stack leakage, `200 ready` / `503 unavailable`, `Cache-Control: no-store`. `/api/health` becomes an honest liveness probe (no dependency claims, pointer to the readiness surface). Middleware exposes `/api/ready` publicly like `/api/health`. |
| G6, G7 | `scripts/seed-e2e.ts` (drop/create → real migrations → real seed fixtures → journey identity + artifact), `e2e/readiness.spec.ts`, `e2e/school-journey.spec.ts`, `e2e/parent-journey.spec.ts`, `e2e/support/seed.ts`; `playwright.config.ts` gains a non-Chromium (`webkit`) project and seeded-database server env; CI rewritten to provision postgres, migrate, seed, gate on `/api/ready`, run both projects, and upload the evidence. |
| G8, G9 | `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/API_CONTRACTS.md` corrected to the implemented contract; `scripts/bootstrap-roles.sql` fixed so the documented command works. |

---

**Status (2026-09-25): IMPLEMENTED AND CLOSED.** Every row above is implemented in the H-6 change set and evidenced in `docs/readiness/H6_RELEASE_EVIDENCE_CLOSEOUT.md` (measured before/after table, contract and fault suites, independent re-audit, full regression, fresh-install and 48→49 upgrade evidence, seeded two-engine release gate). Residual, explicitly NOT-YET-VERIFIED items are listed in §6 of that document — the largest being that the rewritten GitHub Actions workflow has not yet executed on GitHub-hosted runners.
| G10 | `lib/ops/log.ts` structured events + readiness-failure signalling; startup logs configuration presence (never values). |

Verification plan (established standard): adversarial route-level suite → independent re-audit →
root regression (`vitest` unit+integration, `tsc`, lint, build) → fresh-install verification
(`provision-db.sh` + migrate + seed on an empty cluster) → upgrade verification (48-state database
migrating to 49, including the **not-ready** gate on the intermediate 48-state) → E2E on
chromium **and** webkit → closeout → commit.
