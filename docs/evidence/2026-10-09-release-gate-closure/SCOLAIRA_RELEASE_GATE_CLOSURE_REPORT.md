# SCOLAIRA — Release-Gate Closure Report

**Date:** 2026-10-09 · **Branch:** `arena/h8-platform-support` @ `d288c54` · **Tree:** 138 `git status --porcelain` entries (99 modified tracked files, 73 untracked)
**Purpose of this pass:** close the open gates. Not a new implementation phase: no Paystack, no redesign, no cleanup sweep, no new feature, no weakened control.
**Companion records:** §3.10 and the new §3.11 of `SCOLAIRA_10_10_TRANSFORMATION_REPORT.md`; the closing addendum of `SCOLAIRA_PHASE1_ONBOARDING_EVIDENCE.md`.

---

## 1. Verdicts

| Question | Answer |
| --- | --- |
| Is **Phase 1** (guided setup + CSV import) formally closed? | **Yes.** |
| Is **Phase 2** (opening balances / carry-in register) formally closed? | **Yes.** |
| Is SCOLAIRA ready for a **controlled school pilot**? | **Yes, with two named pre-conditions** (§7). No functional gate is red; what remains is operational, and one of the two items is an owner decision I am not permitted to make. |
| Is SCOLAIRA ready for a general launch / is full release readiness claimed? | **No, and no such claim is made here.** Payment intake (Paystack) is deliberately not built; the platform/hosting picture is unverified by me; the backup position below is not production-grade. |
| Readiness **score** | **Still not issued.** Not because anything is unverified or unsecured — both are now resolved, see §8 — but because Phases 3–11 of the transformation plan are not complete, and a score would be an unearned claim. |

---

## 2. What is complete

1. **Environment recovered and verified stage by stage** (apt/PostgreSQL 17, least-privilege roles re-printed and confirmed `super=false bypass=false inherit=false`, `npm ci` → 582 packages, chromium + webkit installed, seed `new=52 total=52 … READY`, production build). No source file was overwritten or reset to do it; no cleanup pass was run.
2. **The four gate failures resolved by re-contracting two stale tests** against the product's actual, documented behaviour — each change makes the assertion *stronger* (§3).
3. **The design-system / accessibility gate unblocked** by making the runner adequate, with the root cause isolated by measurement (§4).
4. **Everything re-run** on the current tree; exact numbers in §5.
5. **Opening-balance invariants reviewed property by property** — recording, approval, posting, duplicate-post protection, reversal, tenant isolation, audit history — with the carry-in-vs-money separation confirmed in code, in database constraints, in 23 named tests and against live catalog state (§6 of §3.11 in the transformation report; summary in §4 below).
6. **The final diff inspected** for weakening of the frozen reconciliation SQL, financial invariants, RLS, auth controls or payment logic (§5 of §3.11; summary in §5 here).
7. **A recoverable snapshot created and verified** — and the absence of any safe remote reported rather than worked around (§6).
8. **Both evidence reports updated** to the final results, with the earlier claims left in place and marked superseded so the sequence of assertions stays auditable.

## 3. What changed (the whole of it — 3 files, no protected path)

| File | Change |
| --- | --- |
| `e2e/health.spec.ts` | Replaced *"root page enforces authentication for the Command Center"* (waited for `/` → `/login?next=%2Fdashboard` for an anonymous visitor) with the real contract: anonymous `/` is 200, is not a login wall, offers sign-in, **leaks no tenant data** (no `₦`, no `INV-…`, no seeded org name or owner address), and 5 guarded routes each answer `307 → /login?next=<path>`. Added `import { loadSeed }`. |
| `e2e/mobile-shell.spec.ts` | Replaced *"every destination is reachable from the mobile navigation band"* (asserted the *desktop* `nav` is visible at 390 px and that a band scrolls sideways with ≥10 links) with the shipped contract: `nav[aria-label="Primary"]` visible, sidebar hidden, all band tabs labelled, band must **not** scroll sideways, `More` (`aria-controls`/`aria-expanded`) opens `#app-more` (`aria-hidden` flips), **sheet destination set == sidebar set**, band ∪ sheet covers every sidebar href, sheet is load-bearing, no document sideways scroll before/after, Members navigated through the sheet. Added minimum-length guards so the set comparison cannot pass vacuously (the sidebar is `display:none` at 390 px and is therefore absent from the accessibility tree — reading it with `getByRole` would have compared against an empty set). |
| `.github/prettier-debt.txt` | 182 → 181: removed `lib/db/schema/financials.ts` because `prettier --check` now reports it clean, which the repo's shrink-only rule requires in the same change. Both new spec files verified clean and neither is listed. |

**Nothing else moved.** No assertion was deleted, no expectation loosened, no `skip`/`fixme` added, no timeout or worker count changed, no production file edited, no migration touched, no rate limit altered. `git diff --name-only -- lib/db/migrations/` is empty; `lib/reconciliation`, `lib/auth`, `app/api/auth`, `app/middleware.ts` show **0** changed files.

Two facts I had to correct in the process, recorded because they were my own errors rather than the product's: a `grep -v "^\+\+\+"` under BRE made a payments-route diff look like "23 protections removed, 0 added" (re-run properly: 23 removed, 24 added, and the shipped file retains `beginIdempotency`/`completeIdempotency`, 9 `AuthzError` throws, the allocation-sum guard); and an initial `npx vitest run` reported `30 files failed / 432 of 435 passed` purely because my shell had not loaded `.env.test` (`SCOLAIRA_SESSION_SECRET`), giving `909 passed / 0 failed` once it was.

## 4. Design-system / accessibility gate — root cause, and what it was **not**

| Candidate cause | Verdict | Evidence |
| --- | --- | --- |
| Production preview-route policy | **Real, and correct as designed.** Against the built artifact, `/preview/*` → 404 because `app/preview/layout.tsx` calls `notFound()` when `NODE_ENV === 'production'` (M4 policy §7, dev-only previews). Not a defect; **no production exception was introduced.** |
| Runner resource limits | **This was the blocker.** In dev mode every route answered `502` in ~5 ms with the box at 1982 MB and no swap: the kernel OOM-killed `next-server`. Five earlier attempts had failed on exactly this (or on the 404 tally above). |
| Product defect | **None found.** No accessibility or rendering failure was observed once the app server stayed alive. |

Fix applied to the **runner** only: a 3 GB `/swapfile` and `vm.swappiness=100` in this sandbox. `playwright.config.ts`, the specs and the preview guard were not modified for it. Result: `CI=1 npm run e2e:design-system` → **32 passed** on chromium (1.4m) and **32 passed** on webkit (1.7m) — 18 `screenshots.spec.ts`, 7 `a11y.spec.ts` including `:95` (dialog closes on Escape) and `:107` (primary-CTA contrast), 5 `health.spec.ts` preview/security-header legs, plus the 2 auth-setup legs. **No test skipped, no assertion weakened, and the earlier "not completable on this runner" limitation is retired.**

## 5. Exact final test results (all re-run on the current tree in this pass)

| Check | Command | Result |
| --- | --- | --- |
| Unit + DB integration | `npx vitest run` (with `.env.test` loaded) | **909 passed / 0 failed** · 65 files · 88.6s · exit 0 |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | **0 errors** (empty output, exit 0) |
| Lint | `npm run lint` | **0 errors**, exit 0 · 2 pre-existing warnings in protected `lib/reconciliation/index.ts` (163:45, 383:19) |
| Formatting (repo's CI rule) | shrink-only prettier rule replayed over all 89 changed formattable files | **0 violations** · **0** debt-listed files left clean-but-unremoved |
| Production build | `npm run build` | ✓ · `.next/BUILD_ID = R29S_0kewz8ZFfeRSBVx3` · artifact 300 MB |
| Phase-1 E2E | `e2e/onboarding-import.spec.ts` ×2 engines | **6/6 legs PASS** (`:119`, `:276`, `:383`) |
| Opening-balances E2E | `e2e/opening-balances.spec.ts` ×2 engines | **6/6 legs PASS** (`:204` journey, `:444` no-session, `:454` 390×844) |
| **Complete release gate** | `CI=1 E2E_SERVER_COMMAND="bash e2e-server.sh" npm run e2e` | `Running 86 tests using 1 worker` → **86 passed (2.2m) · 0 failed · 0 skipped · 0 did-not-run** (`/home/user/GATE_E2E_CLOSURE.log`; 86 `✓` lines, 0 `✘` lines counted) |
| Design-system / a11y | `CI=1 npm run e2e:design-system` | **32 passed** chromium · **32 passed** webkit |
| Readiness contract | `e2e/readiness.spec.ts` in the gate | 4/4 PASS ×2 engines; artifact startup line `expectedMigrations=52`, `expectedMigrationTag=0052_opening_balances`, `databaseConfigured=true`, `authSecretConfigured=true` |

**Remaining failures: none in any gate above.** For completeness, the two things that are *not* green but are also not failures of this tree: the design-system tag cannot be run against the production artifact (by policy, §4 — that is a configuration fact, not a red test), and no `@design-system`-tagged test was removed from the release gate's `--grep-invert` contract: all six `e2e`/`test:e2e` scripts in `package.json` are byte-identical to `HEAD` (`package.json` itself is modified by earlier phases, but not in its e2e scripts), and `playwright.config.ts`'s only diff from `HEAD` is the additive `SCOLAIRA_INTERNAL_ORIGIN` line.

## 6. Backup status

Inspected without reading any secret value: `git remote -v` → **no remotes**; `git config --get credential.helper` → none; `~/.git-credentials`, `~/.netrc`, `~/.config/gh/hosts.yml`, `~/.ssh/id_rsa` → **absent**; `gh` → not installed; no token-like environment variables. An anonymous `ls-remote` probe reached for a username and was abandoned.

Therefore **nothing was pushed** (no verified destination) and **no history was rewritten** (`HEAD` is still `d288c54`, commit count unchanged, 138 working-tree entries preserved exactly). In place of a push:

> `/home/user/backups/scolaira-release-gate-closure-20261009/` — `repo-with-git.tar.gz` (full working tree incl. `.git`, 9.2 MB), `tracked-changes-vs-HEAD.patch` (99 files, 886,926 B), `untracked-files.txt` (73), `status-porcelain.txt` (138), `HEAD.txt`, `branch-arena-h8-platform-support.bundle` (`git bundle verify` → *"The bundle records a complete history"*), `evidence-reports-and-assets.tar.gz` (104 MB: all reports, gate logs, `brand/` with `v31`, `audit/`, QA and walkthrough evidence, both videos, the recovery scripts), `SHA256SUMS.txt`, `RESTORE.md`.

Extraction was verified, archives are mode 600 (they contain `.env.local`/`.env.test`), and the snapshot is **re-generated after this report is filed** so it contains the final documents.

**Update, later the same day — the limitation is closed.** The owner directed the work to be pushed to
their existing repository. Its exact URL was established from git's own records, not guessed:
`.git/FETCH_HEAD` names `github.com:Abdulsamadolalekan/scolaira` and
`.git/refs/remotes/origin/*` lists the same five branches; `git remote add` re-registered it and a
read-only `git ls-remote` confirmed it. The restore had also flattened `~/.ssh/id_ed25519` to mode
644, which is why ssh had refused it ("UNPROTECTED PRIVATE KEY FILE") — tightening it to 600 made the
owner's existing key work, and `ssh -T git@github.com` authenticated as `Abdulsamadolalekan`. No
secret was printed, copied, committed or requested in chat.

Then: `e1d8c69` (170 files, +27,088/−3,288 — the whole of Phases 0–2 plus this pass's two test
rewrites and the formatting fixes) and `b6b9751` (the shrink-only debt-list entry a mid-session
sandbox reset had restored), pushed **fast-forward** as `48d1044..b6b9751` with no force, no amend,
no rebase and no reset; the five local milestone tags were pushed additively (the remote had none).
Verification after the push, on that exact tree: `vitest` **909/909**, `tsc` **0**, `lint` **0**, the
CI format gate replayed over **133** files with **0** violations, the release gate **86 passed / 0
failed** on chromium **and** webkit, and the design-system gate **32/32** on each engine. A clean
`git clone` of the remote branch reproduces `HEAD^{tree}` =
`d21efa83c601a129010d57706ea1b62881da9674`, identical to the local tree — byte-for-byte equality of
all 585 tracked files and all 52 migrations — with no env file and no `e2e/.artifacts/` in it. Full
record: §3.12 of `SCOLAIRA_10_10_TRANSFORMATION_REPORT.md`.

Original finding, kept as written: **Limitation, stated plainly:** this is a snapshot, not a backup. It lives on the same machine as the work, so it does not survive the loss of that machine, and there is no off-box recovery point for a live school's data. Closing it needs an owner decision — a verified remote (and the authorization to push to it), or an approved hosting/backup path. I did not invent one.

## 7. Pilot readiness

**Phase 1 and Phase 2 are closed.** Their acceptance evidence is: the guided-setup and import journeys green on both engines inside a 86/86 gate; the carry-in register's journey green on both engines; 23 named database tests covering every invariant the register claims; 909/909 unit and integration tests; `tsc` and lint clean; the formatting rule satisfied; and the rendered product re-checked at 390×844, 430×932 and 1440×900 in the preceding pass (no horizontal page overflow, no clipped content, no colour-only state).

**Ready for a *controlled* school pilot — with these two pre-conditions, in order:**

1. ~~A real recovery point off this machine~~ **done** — the implementation is pushed and independently verified from the remote (§8). What that does *not* cover, and what a pilot still needs, is the same durability applied to the **database**: scheduled off-box dumps and a rehearsed restore (`docs/ops/RECOVERY_DRILL.md` and `scripts/rehearse-restore.sh` exist for exactly this), which cannot be arranged before the owner's hosting decision.
2. **Pilot money-in confined to what is proven**: cash and bank payments recorded by staff, with the reconciliation and collections control planes (M10/M11) and the public payment link's *record-only* path. **Online payment intake (Paystack) is not built** — by scope decision, not by omission — so no claim of end-to-end electronic settlement exists, and the pilot must not be sold one.

What is explicitly **not** covered by the green gates, so a pilot owner should know it rather than discover it: real-platform provisioning and operations (this environment is a sandbox; nothing here attests to Azure, DNS, TLS certificates, monitoring or an on-call story), backup/restore rehearsal against a deployed instance (H-9's decision remains open), and multi-school load behaviour. The 3 GB swap used to make the design-system gate runnable here is an *environment* accommodation of this runner, not a production sizing statement.

No readiness score is issued. The gates are green and the code is now secured off-box; what still
separates "ready for a controlled pilot" from "ready for anything wider" is operational — database
durability and restore rehearsal on real hosting, monitoring and on-call, and payment intake — which
belongs to the owner's platform decision rather than to this repository's state.

## 8. Recovery-point record

| Item | Value |
| --- | --- |
| Repository | `git@github.com:Abdulsamadolalekan/scolaira` (web: `github.com/Abdulsamadolalekan/scolaira`) |
| Branch | `arena/h8-platform-support`, now tracking `origin/arena/h8-platform-support` |
| Commits | `e1d8c699bb11ef8aaa5ef4b2e68323957770dc72` — "Phase 0–2 in full: guardian management, onboarding/CSV import, opening balances, and release-gate closure" (170 files, +27,088/−3,288)<br>`b6b9751c961bd71240cf0f90966ad5ca7d97adbe` — "Format gate: drop the shrink-only debt entry the wipe restored" |
| Push | `48d1044..b6b9751`, fast-forward, no force; history preserved (77 commits = the prior 75 + these 2, parent chain unbroken back through `d288c54`/`48d1044`) |
| Tags | 5 pushed additively (`M5-FROZEN`, `m8-controlled-term-billing`, `m9-academic-control-layer`, `m10-reconciliation-control-plane`, `m11-collections-control-plane`); each resolves remotely to the same commit as locally |
| Other branches | untouched: `main` `2c5a506`, `arena/h6-ci-verification` `dca6a84`, `arena/h6-hosted-diagnostic` `ae2c14e`, `arena/01a0ce9b-scolaira` `f7d7e83` — all unchanged from before this push |
| Remote verification | clean clone → identical `HEAD^{tree}` `d21efa83c601a129010d57706ea1b62881da9674`; 585 tracked files; 52 migrations; no `.env.local`/`.env.test`, no `e2e/.artifacts/` |
| Verification re-run on the pushed tree | vitest 909/909 · tsc 0 · lint 0 · format gate 133 files 0 violations · release gate 86/86 (chromium + webkit) · design-system 32/32 (chromium) and 32/32 (webkit) |
| Excluded, with reason | `.env.local`, `.env.test`, `.env.local.bak` (live secrets; newly gitignored via `.env*.bak`), `e2e/.artifacts/` (TLS key material, seed credentials, browser storage state), `node_modules/`, `.next/`, `test-results/`, `playwright-report/`, `e2e/screenshots/`, `tsconfig.tsbuildinfo`, and `/home/user/tools/closure-probe.mjs` (this pass's scratch measurement script, moved out of the repository rather than promoted into it) |
| Unresolved | nothing in the gates; the open items in §7 are operational, not code |
