# SCOLAIRA — Phase 1 evidence: guided onboarding + CSV student import

Date: 2026-10-08. Branch `arena/h8-platform-support`, HEAD `d288c54` (`git diff --stat` vs HEAD: 93 files, +9,282 / −3,027). **Nothing is committed**: every
file below is in the working tree, uncommitted, as instructed by the change-control rule.

Scope of this document: Phase 1 only (guided setup + CSV import + guardian capture during import),
including the two rendered-product visual defects found during design QA and fixed in this pass.
Every number here is a measured output, not an estimate. Where something was **not** verified, it
says so.

---

## 1. IMPLEMENTED

| Area | File | What it does |
| --- | --- | --- |
| CSV parser (pure) | `lib/onboarding/csv.ts` | BOM, `;`/`,`/tab delimiters, CRLF, quoted fields with embedded commas (`"Eze, Snr"`), ragged rows, blank-row skipping, header normalisation. 24 unit tests. |
| Import planning | `lib/onboarding/student-import.ts` | Column → field mapping, per-row validation with line numbers, duplicate detection (by admission number and by name+DOB), class resolution **by name against the school's own classes**, Nigerian phone normalisation, warning vs error separation, `planHash`, error-report CSV. 67 unit tests. |
| Status derivation | `app/api/onboarding/status/route.ts` | Five steps derived from real row counts (`organization`, `counts`, `sessions[]`, `currentTerm`, `steps[]`, `nextStep`, `readyToBill`). A step is complete only when the database says so; soft-deleting the last class reopens it. |
| Dry-run validate | `app/api/onboarding/students/import/validate/route.ts` | Writes nothing. Returns the plan, `planHash`, row-level errors/warnings, unrecognised columns. Refuses files > 2 MB. |
| Commit | `app/api/onboarding/students/import/commit/route.ts` | One transaction: students + class enrollments + guardians + guardian links, `Idempotency-Key` required, `planHash` must still match, roll must not have changed since preview. Writes **no** invoice, payment, allocation or receipt. Audit event `student.import`. |
| Guide UI | `app/(app)/onboarding/page.tsx`, `onboarding-guide.tsx`, `step-rail.tsx`, `import-panel.tsx` | Guided five-step surface: rail of steps derived from records, a panel per step, per-step notices, a review-before-commit import. `step-rail.tsx` carries a `disabled` state (`cursor-progress`) so no step can act on stale data mid-write. |
| Nav entry | `app/(app)/layout.tsx` | `Set up` entry in `ALL_NAV` (SCHOOL DATA group). |

Race fix (from the previous session, re-verified this pass): created-record state is taken from the
`201` response bodies, all writes run inside `useTransition`, `termToActivate` / `sessionForTerm`
prefer the *current* record over the newly created one, and the class gate uses
`status.counts.classes + createdClassCount`.

### Visual defects fixed in this pass (found only by looking at the rendered product)

**Defect 1 — the import review was cut off at the right edge on a phone.**
At 390 px the review's five-column ruled table was wider than the column it sat in. Its container
carried `overflow-x-auto`, so the *page* never reported horizontal scroll — the excess width was
clipped inside the box, and the columns that matter most (class, guardian, the tail of the summary
line: `…2 rows blocke`, `GUARDIAI`, `0803555`) fell off the screen. The pre-existing phone-viewport
test could not see this: `document.documentElement.scrollWidth` was still 390. Evidence kept at
`qa/before-fixes/onboarding-390-review.png`.

Fix — `app/(app)/onboarding/import-panel.tsx`:

- the row preview now follows the pattern the student roll already uses: `<div className="mt-2 hidden overflow-x-auto md:block">` for the ruled table, and below `md` a stacked `<ul className="mt-2 divide-y md:hidden">` — name, `Line n · ADM-NO`, class, guardian name, phone, and the same `Check` badge for warned rows;
- the 12-row preview cap was hoisted into `previewRows` so the table and the list cannot disagree.

**Defect 2 — section hints were truncated mid-word.**
`CardHeader` (in `components/ui/nav-shell.tsx`) renders its `description` with `truncate`. In the
guide's 300 px rail column that produced `Progress is read from your records, n…` at 1440 px, and
the wide column clipped the import hint at smaller laptops — measured, not guessed:
`onboarding-1280-review` → `"Upload your roll as a CSV. Nothing is imported" (548>481)`;
`onboarding-1024-review` → `(548>273)`. Evidence kept at `qa/before-fixes/onboarding-1440-guide.png`.

Fix — `app/(app)/onboarding/onboarding-guide.tsx`:

- both hints were moved out of the truncating `description` slot onto their own wrapping line
  (`<p className="-mt-1 pb-2 text-xs text-ink-muted">`), so nothing is cut at any width;
- the two-column grid became `lg:grid-cols-[300px_minmax(0,1fr)]`, so no future wide child can push
  the page sideways.

**Deliberately NOT changed.** `CardHeader`'s `truncate` stays as it is: it is shared by every list
page in the product, and changing it globally is a redesign, not a fix. The students roll, the
reconciliation surface and all financial UI are untouched. No brand, token, radius or colour change
was made in this pass.

**One thing the screenshots initially looked like, but is not.** In `fullPage` captures at 390/430
the mobile tab bar appears to sit on top of mid-page content. That is an artefact of screenshotting a
`position: fixed` bar while the page is stitched. Verified properly with a viewport-sized capture
scrolled to the end of the page (`qa/onboarding-390-review-bottom.png`): the last row clears the bar
by a comfortable margin and nothing is hidden. No product change was made for it.

---

## 2. TESTED (unit + integration + E2E + build + lint)

| Command | Result |
| --- | --- |
| `npm test` (vitest, unit + integration) | **852 passed / 852, 62 files**, 89.8 s — run *after* the visual fixes. Re-run after §10's follow-up change: **854 / 854** |
| `npx vitest run --project integration tests/db/student-import.test.ts tests/auth/onboarding-routes.test.ts` | **47 passed / 47** (20 + 27), 5.3 s |
| `lib/onboarding/*.test.ts` | 91 passed (24 parser + 67 planner) |
| `npx tsc --noEmit` (`./node_modules/.bin/tsc`) | 0 errors |
| `npm run lint` | 0 errors (the repo's own run reports warnings only, incl. two pre-existing `no-explicit-any` warnings in the onboarding spec) |
| `npx prettier --check` on every file touched | clean; `.github/prettier-debt.txt` untouched at **182** entries (no listed file was cleaned, so no shrink was owed) |
| `npm run build` | green. Final run after every change in this pass: `✓ Compiled successfully in 9.1s`, shipping `/onboarding` (9.98 kB), `/api/onboarding/status`, `/api/onboarding/students/import/validate`, `/api/onboarding/students/import/commit` |

What the tests actually assert (not "the page renders"):

- **dry-run writes nothing** — after previewing, the test navigates to `/students` and asserts the
  admission number count is `0`;
- **row-level errors with line numbers** — `Line 3 · class  No class called "SS4 North" exists. Your
  classes are: …`, `Line 4 · admission number  Admission number is required.`;
- **warnings do not block** — an unreadable phone is reported as `"call mama" was not recognised …
  and was NOT imported. Correct it and re-upload to keep this number.` and the row still imports;
- **duplicate prevention** — a re-uploaded admission number names the existing child
  (`already belongs to Ada Eze (active)`) and the commit is refused;
- **corrected re-upload** — after fixing the file the same import succeeds;
- **idempotency** — `Idempotency-Key` required (400), wrong key replayed → 409, and a replayed key
  imports **once**;
- **plan integrity** — `planHash` mismatch → 409; roll changed after preview → 409;
- **no financial side effects** — commit returns 201 `{students, guardians, enrollments}` and the DB
  proves zero invoices / payments / allocations / receipts were created;
- **auth + CSRF + role boundaries** — 401 unauthenticated, 403/400 without a CSRF token, 403 for a
  STAFF role, 404 for a term belonging to another school, 400 for an extra body field, 2 MB limit;
- **Nigerian-reality file** — BOM, `;` delimiter, CRLF, quoted `"Eze, Snr"`, an unused `House` column
  reported as `unrecognisedColumns`.

### E2E — the actual journey, both engines

`e2e/onboarding-import.spec.ts` (3 serial tests + 2 auth-setup), `workers: 1`, against the built
product over the E2E TLS proxy (`https://localhost:3443`, real HTTPS, verification left ON):

| Engine | Result | Duration |
| --- | --- | --- |
| Chromium | **5 passed / 5** | 18.5 s |
| WebKit 26.6 (`webkit-2359`) | **5 passed / 5** | 23.9 s |

Both runs are *after* the visual fixes, and the spec was strengthened in the same pass so the fixed
geometry is actually guarded. After the cleanup and the final build the same file was run once more,
both engines in one invocation: **8 passed / 8 (37.2 s)** — 2 auth-setup + 6 journey runs.

The strengthening:

- at 1440 px: every `p`, `td` and `li` in `main` must satisfy `scrollWidth <= clientWidth + 1`
  (`expect(clipped).toEqual([])`) — an element with an ellipsis is still "visible" to Playwright, so
  visibility alone could never have caught Defect 2;
- at 390 px: the stacked preview row must be visible **and** its bounding box must fit inside
  `clientWidth`, and `page.getByRole('table').first()` must be **hidden** — this is the regression
  guard for Defect 1, which the old page-level `scrollWidth` check passed straight through.

Known harness behaviour, recorded so it is not mistaken for a product bug: a `router.refresh()` still
in flight can interrupt a following `page.goto` on WebKit
(`Navigation … interrupted by another navigation to /onboarding`). The spec therefore uses
`gotoSettled()` (`waitForLoadState('networkidle')` then `goto`) after every mutating action. This is
Playwright-vs-Next behaviour, not a defect in the product.

---

## 3. VISUALLY VERIFIED (rendered product, not code)

`node qa-shots.mjs` drives the built app, signs in once, validates a 3-row CSV (one unknown class,
one unreadable phone, one missing admission number) and writes PNGs plus a measured overflow report.
It only ever *validates*: nothing is committed, so the fixture school's financial records are
untouched.

```
PASS onboarding-1440-guide        vw=1440 pageScrollWidth=1430 clipped=0
PASS onboarding-1440-review       vw=1440 pageScrollWidth=1430 clipped=0
PASS onboarding-1280-review       vw=1280 pageScrollWidth=1270 clipped=0
PASS onboarding-1024-review       vw=1024 pageScrollWidth=1014 clipped=0
PASS onboarding-390-review        vw=390  pageScrollWidth=390  clipped=0
PASS onboarding-390-review-bottom vw=390  pageScrollWidth=390  clipped=0
PASS onboarding-430-review        vw=430  pageScrollWidth=430  clipped=0
PASS onboarding-390-guide         vw=390  pageScrollWidth=390  clipped=0
PASS onboarding-390-session       vw=390  pageScrollWidth=390  clipped=0
```

Re-run against the final build (after the last `npm run build`): the same 9/9 `PASS`, byte-for-byte the
same layout judgement.

`pageScrollWidth` 10 px below `vw` on the desktop shots is the forced vertical scrollbar
(`html { overflow-y: scroll }`, `app/globals.css:48`), not overflow.

Judgement applied to each PNG, at each size:

- **1440 review** — rail reads `SETUP / Progress is read from your records, not ticked off.` with no
  ellipsis; `IMPORT STUDENTS` hint reads in full; summary card, error rows, warning rows, the ruled
  preview table, the disabled `Import 1 student` + `Cancel` + "Fix the problems above…" line and the
  `READY` block all fit the two-column grid with a consistent gutter.
- **1280 / 1024 review** — the two widths that used to clip now report `clipped=0`; the hint wraps
  onto its own line instead of losing a third of its width.
- **390 review** — `1 student ready to import · 2 rows blocked` reads in full; the stacked row
  `Ada Eze / Line 2 · QA-001` with `SS3 East / Chidi Eze / 08035550142` on the right is legible
  without any sideways drag; the `Check` badge is preserved (state never depends on colour alone).
- **390 guide / 390 session step** — the rail is fully on screen with a tick, a number and a word per
  step; the session panel's `Starts` / `Ends` date fields and `Create session` button sit inside the
  viewport; the fixed tab bar does not cover content at the true bottom of the page.
- Typography, deep green/cream palette, ruled blocks and hairlines are the existing system; no new
  radius, gradient, pill or card-in-card pattern was introduced.

Files: `qa/onboarding-*.png` (9 post-fix captures) and `qa/before-fixes/` (the 2 captures that
evidence the two defects). Reproduce with `bash /home/user/serve-e2e.sh` +
`node scripts/e2e-https-proxy.mjs`, then `node qa-shots.mjs`.

---

## 4. DATABASE VERIFIED

`sudo -u postgres psql -X -d scolaira_e2e` — the superuser socket path is the only way to read tenant
tables here, because `scolaira_owner` is `NOBYPASSRLS` and correctly sees 0 rows.

Newest E2E school (`Guide Test muzgwucn`, created by the post-fix WebKit run):

| students | guardians | links | enrollments | classes | terms | sessions | **invoices** | **payments** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 6 | 6 | 6 | 2 | 1 | 1 | **0** | **0** |

Roll as stored (every child linked to exactly one primary guardian):

```
GT-MUZGWUCN-001  Ada Eze       | Primary 4 | Chidi Eze     | 08035550142
GT-MUZGWUCN-002  Musa Danjuma  | Primary 5 | Aisha Danjuma | +2348035550200
GT-MUZGWUCN-003  Ngozi Okonkwo | Primary 4 | Emeka Okonkwo | 08035550301
GT-MUZGWUCN-FIX1 Ada Eze       | Primary 4 | Chidi Eze     | 08035550142
GT-MUZGWUCN-FIX2 Musa Danjuma  | Primary 4 | Aisha Danjuma | 08035550200
GT-MUZGWUCN-PH1  Ada Eze       | Primary 4 | Chidi Eze     | 08035550142
```

- `0803 555 0142` → `08035550142`: phones are normalised on write, and the review showed the same
  normalised string the database holds.
- **Audit trail** for that school: `student.import ×3`, `student.create ×6`, `class.create ×2`,
  `academic_session.create ×1`, `term.create ×1`, `term.activate ×1`. Three imports, six students —
  the refused file created nothing, and the replayed idempotency key created nothing twice.
- **Guardian primary uniqueness (Phase 3 invariant, re-checked after these changes):**
  `exactly_one = 6`, `none = 0`, `more_than_one = 0`.
- **Tenant isolation:** cross-tenant guardian links `= 0` across the whole database
  (`students.organization_id <> guardians.organization_id`).
- **No unintended financial records:** all three E2E guide schools show `0` invoices and `0` payments.
  The seeded `Demo School`, whose QA run only *validated* a file, still has exactly `3` students and
  its `5` invoices / `4` payments — the seed's financial fixtures are unchanged, which is the
  positive proof that validate-does-not-write and that QA did not touch money.
- **Re-run against the final build** (after the workspace cleanup), newest two schools
  `Guide Test muzi2505` and `Guide Test muzi1tja`: `6 / 6 / 6 / 6 / 2 / 1 active term / 1 session`,
  **0 invoices, 0 payments**, **14 audit events** each. Database-wide, measured in the same session:
  students whose primary-guardian count is not exactly one → **0**; guardian links crossing
  organisations → **0**.
- **Roll-up of every school in the fixture DB:** `Guide Test muzgwucn 6/6/6/6/2/1/1/0/0`,
  `Guide Test muzgw9m0` and `Guide Test muzgsryh` identical (chromium runs), `Demo School 3/0/0/0/2/1/1/5/4`,
  `Rival School 1/0/0/0/1/1/1/0/0`.

---

## 5. CLEANED UP

The whole workspace was inspected: `/home/user` (54 files + 24 directories) and `/home/user/scolaira`.
Nothing was deleted without first checking whether a report, script, config, test or doc referenced it.

**Deleted — 14 files, 354,275 B (346 KB) inside the repo plus this session's own run logs**, each
verified unreferenced and disposable:**

| Path | Why safe |
| --- | --- |
| `scolaira/v3.mjs` | 953 B, one-off DB-verification probe from the previous session's RLS dead end. `grep` for `v3.mjs` across all `.md/.json/.sh/.ts/.tsx/.yml` → **0 references**. |
| `scolaira/qa-measure.mjs` | 3.2 KB overflow probe written earlier in this pass; its measurement is now built into `qa-shots.mjs`, which is what the evidence quotes. **0 references.** |
| `scolaira/qa/onboarding-1440-session.png` | 46 KB capture of the **sign-in page**, produced by the first QA attempt when the stored session had been signed with the gate's secret. It is not a capture of the guide and is superseded by `onboarding-1440-guide.png`. |
| `scolaira/qa/before-fixes/onboarding-1440-session.png` | byte-identical duplicate — `md5sum` of both files is `4f9c0875d97d997a3f114fcd68ad21e9` (measured with `uniq -c` → `2`). |
| `scolaira/qa/before-fixes/onboarding-1440-review.png` | pre-fix desktop review; the desktop review was never defective (both defects are the phone table and the truncated hints), so it adds nothing to the before/after pair that survives. |
| `scolaira/qa/before-fixes/onboarding-430-review.png` | pre-fix 430 px capture showing no defect — the 430 px layout was already correct. |
| `scolaira/qa/.state.json` | 649 B — a Playwright storage state containing a **live session cookie** for the fixture owner, written by `qa-shots.mjs`. Deleted so no credential-bearing artefact is left behind (and `qa/` is not tracked, so it could not be committed). The harness regenerates it on the next run. |
| `/home/user/{npm-ci,pwkit,serve-e2e,e2e-proxy,setup-env-run,build2,npmtest-final}.log` | this session's own transient run logs (one 55 KB Playwright browser-install log among them). Their content is transcribed into this document, so they are not the record. |

**Deliberately preserved (and why):**

- `qa/before-fixes/onboarding-1440-guide.png` and `qa/before-fixes/onboarding-390-review.png` — the
  only two captures that actually evidence the two defects; without them the fix has no "before".
- `qa-shots.mjs` — kept and now referenced: it is the reproducible rendered-QA harness for this phase.
- `.env.local.bak` — on the do-not-delete list.
- `scolaira/test-results/` (3.8 MB) — retained this pass rather than removed: the release-gate report
  quotes the four baseline failures' `error-context.md` files, and three earlier cleanup records show
  this directory being deleted and then re-created by the next run. Deleting cited raw evidence is the
  specific mistake I was told not to repeat, so the artefacts stay and the *quoted* text also lives in
  the report.
- `scolaira/M5…M10_*.md` (11 closeout/reconnaissance reports, ~300 KB) at the repo root — historical
  phase documentation; `M9_RECONNAISSANCE_REPORT.md` and friends are cited by the protected-area list.
- `scolaira/h9-evidence/`, `scripts/bootstrap-roles.sql`, `scripts/rehearse-restore.sh`,
  `docs/ops/RECOVERY_DRILL.md`, `e2e/.artifacts/tls/*` (the throwaway cert the proxy and `serve-e2e.sh`
  both need), `e2e/.artifacts/state-*.json` (Playwright storage states the config regenerates),
  `public/product/` (marketing assets).
- `/home/user/brand`, `redesign`, `qa-final`, `qa-final-pass2`, `qa-typo`, `part3-shots`, `uploads`,
  `backups`, `restore-request`, `walkthrough` (incl. both MP4s), `h9_probe_raw`, `h9_probe_packs.md`,
  `h9_t2_owner_run`, `h9_t2_unblock` and all 40-odd `SCOLAIRA_*.md` reports — **every one** of these is
  cited by at least one markdown record (measured reference counts: `redesign` 38, `backups` 23,
  `uploads` 10, `qa-final` 6, `part3-shots` 4, `walkthrough-full` 4, `h9_t2_owner_run` 4,
  `qa-final-pass2` 3, `qa-typo` 2, `restore-request` 2, …). They are evidence, not clutter, and the
  rule "do not delete something merely because it is not imported by the application" applies to them.
- `scolaira/node_modules` (746 MB) and `scolaira/.next` (270 MB) — regenerable in principle, but they
  are the live toolchain and the build the E2E gate serves (`npm start`). `~/.cache/ms-playwright`
  (979 MB) holds the Chromium + WebKit binaries the tests launch. Nothing was deleted to hit a size
  figure.
- `app/preview/*` and `components/template/*` — still open "retire or keep" decisions; left untouched.
- Empty directories: `find … -type d -empty` → **none**. Editor/OS junk: `*.tmp`, `*.swp`, `*.orig`,
  `*.rej`, `.DS_Store`, `*~` → **none** (one `.log` exists, `h9-evidence/restore-rehearsal-…/transcript.log`,
  and it is part of a recorded restore rehearsal → kept).

**Reference check after deletion.** Every deleted filename was grepped across `app/ lib/ components/
e2e/ scripts/ tests/ docs/ .github/ package.json` and all `/home/user/*.md`: **0 source, test, config,
CI or package-script references**. The only hits are inside this document, where they are the deletion
record itself (one of them, `onboarding-430-review`, matches the file that was *kept* in `qa/` — only
its `before-fixes/` copy was redundant).

**Worktree state after cleanup:** `git status --porcelain` **120** entries (was 122 — the two removed
untracked root scripts), `git stash list` 0, HEAD still `d288c54`, no commit/push/merge/PR performed,
`node_modules` and `.next` intact.

**Measured change:** files under `/home/user` excluding `.cache`, `.npm`, `node_modules` and `.next` went
**3,841 → 3,828** and `du -sx` of that tree **145,190 KB → 144,618 KB (−572 KB)**. The count fell by 13
rather than 14 because the same window also *created* files — the E2E run wrote
`e2e/.artifacts/state-onboarding-owner.json` and the gate regenerated `test-results/`. Nothing was
deleted to reach a size figure.

---

## 6. PARTIAL

- **Guardian capture during import is limited to what a CSV can carry** — name, phone, relationship,
  primary flag, one guardian per row. There is **no de-duplication**: measured in `scolaira_e2e`, the
  newest guide school holds three separate `guardians` rows for `Chidi Eze · 08035550142`, one per
  imported child. That is deliberate for an import (two siblings' rows are two parents as often as one
  parent twice, and silently merging them would be the worse error), but it means a guardian directory
  with a merge prompt is a real follow-up, not a finished feature. Guardian *editing*, multiple
  guardians per student and the relationship picker are on the student page (Phase 3).
- **Phone normalisation is per-format, not canonical.** `+234 803 555 0200` stores as `+2348035550200`
  and `0803 555 0200` stores as `08035550200`; both are dialable and both are what the review promised,
  but they are not recognised as the same subscriber number. Recorded as a risk rather than quietly
  widened in this pass, because canonicalising to E.164 changes stored guardian data, the Phase 3
  contact resolution and the reminder surfaces — financial/contact semantics, not a UI fix.
- **Import creates no invoices by design.** The guide stops at "your school is ready to be billed" and
  hands off to `Set up fees`. Auto-charging a freshly imported roll would be the wrong default.
- **The guide's five steps cover school/session/term/classes/students.** Fee structure and invoice
  generation remain separate surfaces (they already existed and are linked from `READY`), rather than
  being duplicated inside the wizard.

## 7. DEFERRED (by decision, not by accident)

- **Phase 2 opening balances** — not started, as instructed. It is the next real pilot blocker and the
  only remaining item from the audit's three.
- **Real Paystack (Phase 4)**, statement ingestion (Phase 5), provider transport (Phase 6), report
  suite (Phase 7), 2FA/privileged-session hardening (Phase 8), low-end-device resilience pass (Phase 9),
  subscription minimum (Phase 10), and the final restrained polish (Phase 11).
- **`CardHeader`'s global `truncate` behaviour.** The guide no longer depends on it; whether any other
  surface clips a hint at some width is a question for Phase 11, measured the same way, not now.
- **A WebKit-only hydration race** remains handled in the test layer (`fillStable`, `gotoSettled`)
  rather than in the app. It does not occur for a human tap-then-read flow; "fixing" it in the product
  would mean touching hydration for a tooling artefact.

## 8. NOT STARTED

Nothing that Phase 1 claimed is unimplemented. No Phase 2–11 work has begun. Specifically **not**
written: opening-balance tables, a ledger mutation path, a payment provider call, an SMS/WhatsApp
transport, a billing/plan engine.

---

## 9. Verdict

**Phase 1 is genuinely complete** for its stated scope — with the honest caveats below.

- Guided onboarding works end to end on Chromium **and** WebKit; CSV import validates, refuses bad
  files row-by-row, prevents duplicates, re-imports a corrected file, links guardians with exactly one
  primary each, and writes no financial records — verified in Postgres, not in a log.
- Both rendered-product defects found this pass are fixed and now guarded by assertions that would have
  failed before the fix; and the fixes, the build and the E2E were all re-verified *after* the workspace
  cleanup, not only before it.
- Rate limits were **not** weakened, and the login limiter was left to do its job: my own QA harness
  exhausted `login:ip:127.0.0.1` (counter 12 > 10 per 15 min) and I waited out the window rather than
  clearing the table or bypassing the check.
- The four release-gate failures are pre-existing Category C (`health.spec.ts:30` and
  `mobile-shell.spec.ts:118` on both engines — stale assertions about `/api/health` wording, which
  R4's owner decision governs). They are reported, never "fixed" by editing the assertion or the
  health endpoint.
- **Not** claimed: that the suite has never been flaky. In an earlier session one `npm test` run
  reported 1 failed / 851 passed and was never reproduced across four subsequent runs and the run in
  this pass; the failing test's identity was not captured. That is an open, unexplained observation.

Remaining pilot blockers after this phase: **opening balances (Phase 2)** and **a real payment
provider + reconciliation loop (Phases 4–5)**, plus the audit's operational items that no code can
close (a real tenant, real credentials, a restore rehearsal against production data).

**What Phase 2 would implement:** a permissioned opening-balance flow that records, per student,
(a) current-term invoice balances, (b) historical balances carried in, (c) amount owed,
(d) credits/overpayments, and (e) unverified balances flagged as such — each as an auditable,
reversible ledger entry with its own approval trail, reusing the existing invoice/allocation schema and
reconciliation state machine rather than a parallel "balance" table, so the ledger stays the single
source of truth.

---

## 10. Follow-ups after the phase was declared complete (2026-10-08, second pass)

Three follow-ups were requested. All three were investigated against the rendered product, and one of
them corrected something I had said out loud the turn before.

### 10.1 Multiple guardians for one student during CSV import — the behaviour was already right, the wording was not

Measured by uploading a file with **two rows for the same child, naming a different guardian** to the
built app. What the review says now:

```
Line 3 · admission number
Admission number OB-001 also appears on line 2 — the same child, with a different guardian.
The import records one guardian per student. Keep the first row, then add this guardian
on the student's page after importing.
1 student ready to import · 2 rows blocked
3 class enrollments · 3 guardians · no invoices or charges will be created
```

The importer records **one guardian per student row**; multiple guardians per student are owned by the
student page (Phase 3), and nothing is merged or dropped quietly — the second row is refused and named,
and the other students still import. That is the design, and it is what the audit asked for.

What was not acceptable was the message that used to print there:
`Admission number OB-001 also appears on line 2. Remove one of the two rows.` For a school whose
export is one row per guardian, "remove one of the two rows" tells a person to **delete a guardian
record** to make the file pass.

Change (`lib/onboarding/student-import.ts`, DECISION-9): when the repeated admission number carries the
same name **and** the same date of birth, the row is reported as a second guardian and pointed at the
student page; when two *different* children collide on one number, the blunt "Remove one of the two
rows." still prints. `seenStudentIds` now remembers `{ line, name, dob }` for that comparison. The
duplicate check itself is untouched — both cases still block, one row still means one guardian. DOB is
compared as written in the file, so `2013-09-02` vs `02/09/2013` falls back to the conservative message.

Tests: 2 added in `lib/onboarding/student-import.test.ts`; `npx vitest run lib/onboarding/` → **93 / 93**.
Rendered and measured with a deliberately pathological file (`von Habsburg-Lothringen`,
`Christopher-Emmanuel`, `Marie-Thérèse`) at 1440 px and 390 px: the long message wraps inside its row
card, `clipped=0`, `pageScrollWidth == viewport`, and the button still reads `Import 3 students` for the
three importable children. Screenshots: `qa/followup-1440-two-guardians.png`,
`qa/followup-390-two-guardians.png`.

### 10.2 Long text and truncation anywhere on the surface — none remains

Re-measured rather than inferred: every `p`, `td`, `li` and leaf `div` in `main` was checked for
`scrollWidth > clientWidth + 1` across the guide, the import review and the student page at 1440, 1280,
1024, 430 and 390. **Zero clipped elements** at every size.

### 10.3 No-overflow at 390 / 430 — verified, and a claim of mine was falsified

I had reported the student detail page as overflowing horizontally (`502 > 390` at 390 px,
`470 > 430` at 430 px), measured from a capture script. **That was wrong.** The number came from a
*scrollable child* — the invoice table inside the page — not from the page. Re-measured against
`scrollingElement`: `vw=390 pageScrollWidth=390 overflow=false`, and the widest offender is
`span.inline-flex.items-center.gap-1.5 < td.px-3.py-3 < tr < tbody [412→450]`, a status pill inside a
table the user can scroll. The H-8 mobile contract ("a strip may be wider than the viewport; the page
must not") is met, so no change was made to that page for it. What *is* genuinely open, and belongs to
Phase 11 rather than Phase 1: `/students/[id]`'s invoice table is sideways-scroll-only on a phone — the
same readability problem I fixed in the import review, on a financial surface this phase must not
redesign.

### 10.4 This pass, verified

| Check | Result |
| --- | --- |
| `npm test` | **854 passed / 854**, 62 files |
| `npx vitest run lib/onboarding/` | **93 / 93** |
| Phase-1 integration suites | **47 / 47** (20 + 27) |
| E2E Chromium | **5 / 5** (17.4 s) |
| E2E WebKit 26.6 | **5 / 5** (24.1 s) |
| `tsc --noEmit` / `npm run lint` / `prettier --check` | 0 / 0 errors / clean |
| `npm run build` | `✓ Compiled successfully in 9.8s` |
| Database, newest three `Guide Test *` schools | 6 students · 6 guardians · **0 invoices · 0 payments** · 14 audit events each; `not_exactly_one_primary = 0` DB-wide |
| Rendered QA at 5 widths | 0 clipped elements, 0 page overflows |

Reproducibility notes, because two of them cost me a false reading:

1. The sandbox restored again between turns — apt packages, the Postgres cluster, `node_modules`,
   `.next` and the Playwright browsers were all gone; rebuilt with `bash /home/user/setup-env.sh`, then
   `npx playwright install webkit` and `sudo npx playwright install-deps webkit` (WebKit launches fail
   with `libgstreamer-1.0.so.0 / libgtk-4.so.1` missing otherwise).
2. My first restart of the app server this pass reported `ready=200` while a **stale** process still
   held port 3000 (the new one died on `EADDRINUSE`), so the first probe measured the pre-fix build and
   appeared to show the new message not working. Verified properly only after killing the old PIDs and
   confirming `curl` got `000` on 3000 before restarting. A `200` from `/api/ready` is not proof that
   the build you just compiled is the one being served.
3. `qa-shots.mjs` gained `QA_STATE=<path>`: a capture run can reuse the storage state the E2E run
   already produced instead of spending logins. This pass cost **zero** additional logins after that
   change, and no rate limit was cleared, widened or bypassed.
4. Disposable output from this pass (`qa-diagnose.mjs`, the `/home/user/audit/scratch/` debug captures
   that produced the false claim, `qa/followup-390-student.png`, and the regenerated `test-results/` +
   `playwright-report/`) was deleted at the end; the two `followup-*-two-guardians.png` captures stay
   because §10.1 cites them.

### 10.5 Follow-up, Phase 2 (2026-10-09): the guide grew a sixth step

`SCOLAIRA_10_10_TRANSFORMATION_REPORT.md` §3 is the evidence for this; the note lives here
because it changes a count this file states.

- `GET /api/onboarding/status` now emits a sixth derived step, `balances` ("Carry in what is
  owed"), after `students`, so the step list is `school · session · term · classes · students ·
  balances`. Every sentence in §Status derivation above still holds: the new step is derived from
  row counts in `opening_balances`, not stored, and it is emitted **only** when the caller holds
  `invoice.read` — a role that cannot read invoices gets no step and no `openingBalances` field,
  rather than a zeroed-out fiction.
- The guide copy that said "five steps" was corrected on the page lede; nothing else about the
  five Phase-1 steps changed, and no Phase-1 assertion was weakened.
- `tests/auth/onboarding-routes.test.ts` was written to locate steps **by key**, which is why
  adding a step did not disturb it: 28/28 pass, including one new test that pins the sixth step's
  derivation (empty register is not done; a draft row reports `waiting to be approved`).
- The full-suite count this file quotes (852/852) was the state of the repository at Phase 1's
  close. After Phase 2 the same command reports 907 tests with 906 passing and one pre-existing
  flaky assertion (`tests/auth/auth.test.ts:127`, mechanism explained in report §3.8).

---

## Addendum — re-verification on the recovered environment (2026-10-09)

The sandbox restored this workspace mid-programme (dependencies, `.next`, PostgreSQL and
the Playwright browsers were gone), so the environment was rebuilt from
`/home/user/setup-env.sh` — stage by stage, each confirmed from its own output — and
Phase 1 was re-run rather than re-asserted from the numbers above.

| Re-run | Result |
| --- | --- |
| `npx vitest run` (whole repo, includes the Phase-1 onboarding/import suites) | **909 passed / 0 failed**, 65 files |
| `tsc --noEmit` · `npm run lint` | **0 errors** · 0 errors (2 pre-existing warnings in `lib/reconciliation/index.ts`) |
| `npm run build` | succeeds; `.next/BUILD_ID = W7DjZ9FPyMgZFW7J5Phyc` at the end of the pass |
| `e2e/onboarding-import.spec.ts`, chromium + webkit, production artifact over `https://localhost:3443` | **6 of 6 legs PASS** (guided setup for a new school, refusal of a bad file + corrected import + duplicate refused, phone viewport) — and the same 6 inside the full `npm run e2e` gate (`Running 86 tests`, 82 passed) |
| `qa-shots.mjs` | **9 / 9 PASS** at 1440 / 1280 / 1024 / 390 / 430, `clipped=0`, no horizontal page overflow |

Two expectations in `e2e/onboarding-import.spec.ts` had gone stale when Phase 2 added the
carry-in step to the rail, and both were rewritten to **measured** values rather than
loosened: the empty-workspace heading no longer states a step count, so the lede is
asserted in its current words, and the rail for a school with nothing recorded is six
steps (`Not yet completed` exact **4**, `^Not yet completed` **5**, `^Completed` **1**),
so 3/4/1 became 4/5/1 with the new step named in the assertion. The end-of-setup leg now
asserts the honest mixed state Phase 2 intends — five steps complete, the carry-in step
open with `Nothing carried in yet` — plus the non-regression that matters: a school with
no prior debt is still told it is ready to be billed and still sees `Set up fees`.

No financial behaviour, security control or protected file was touched to obtain these
results. The environment incidents found on the way (an interrupted `e2e:seed` leaving
`scolaira_e2e` empty, and a `NODE_EXTRA_CA_CERTS` gap in a hand-started server that made
the guide look broken) are recorded in §3.10 of
`SCOLAIRA_10_10_TRANSFORMATION_REPORT.md` with the measurements that identified them.

---

## Addendum — release-gate closure (2026-10-09, later in the same day)

The two Playwright assertions that were still failing the release gate at the end of the
previous addendum were reviewed against the contracts they are supposed to protect, and both
belonged to Phase-1-adjacent surface. They are resolved here rather than deferred, because a
gate with a known-red test is not evidence for a pilot.

**`e2e/health.spec.ts` — the root route's authentication contract.** The test waited for
`page.goto('/')`, signed out, to become `/login?next=%2Fdashboard`. That has not been the
product's intent since the public landing page was introduced: `app/page.tsx:12` says so in
its own comment and `app/page.tsx:190` implements it (`if (session) redirect('/dashboard')`),
and `app/middleware.ts` is the guard for everything data-bearing. The rewritten test asserts
that contract and more: `/` answers 200 to an anonymous visitor, is not a login page, offers
a way in, and **shows nothing of any real school** — no `₦` amount, no `INV-YYYY-NNNNNN`
number, not the seeded organization's name, not the seeded owner's address. It then walks five
guarded routes (`/dashboard`, `/invoices`, `/students`, `/finance/opening-balances`,
`/reconcile`) and requires `307 → /login?next=<that path>` from each. Measured through the
suite's own TLS front end before the edit: `rootStatus=200`, `nairaCount=0`,
`invoiceNumbers=0`, `mentionsOrgName=false`, and `status=307` with the correct `next` on all
five paths — so the assertions describe the product, not a wish.

**`e2e/mobile-shell.spec.ts` — the phone navigation contract.** The old test took
`page.locator('nav').first()` (which is the desktop sidebar, `hidden … md:flex`, correctly
invisible at 390 px), demanded it be visible, demanded it hold ≥10 links, demanded it scroll
sideways, and then reached for a Members link inside it. `components/ui/app-shell.tsx`
implements a different, deliberate design — a fixed bottom band of labelled primary tabs plus a
`More` button opening the `#app-more` "All destinations" sheet — with the reasoning in the
source: *"Fixed, thumb-reachable, and labelled (an icon alone is a guess)."* The rewritten test
protects the reachability promise the old one was reaching for, and holds the shell to more:
the band is visible and the sidebar is not; every band tab has a text label; the band must
**not** scroll sideways, so the decision is pinned against a revert; the `More` trigger carries
`aria-controls="app-more"` and flips `aria-expanded` and the sheet's `aria-hidden`; the sheet
must contain exactly the desktop sidebar's destination set; band ∪ sheet must cover every
sidebar href; the sheet must contain at least one destination the band does not (otherwise the
test could pass without the sheet ever being exercised); the document must not gain a sideways
scroll from opening it; and Members — the destination the old test wanted — is navigated to
through the sheet.

One trap is worth recording, because it is the reason this rewrite is trustworthy: the sidebar
is `display:none` at 390 px, so `getByRole('navigation', { name: 'Workspace' })` matches
nothing, and a set comparison against it would have "passed" against an empty expectation. The
test reads the sidebar from the DOM instead and asserts minimum lengths on all three sides
before comparing. Measured shape of the shell at 390×844: band = 5 destinations
(Dashboard, Invoices, Payments, Students, Debtors), sheet = all 12, sidebar = the same 12,
band `scrollWidth == clientWidth == 390`, `document.scrollWidth == 390`.

**Re-verification after both rewrites**, on the recovered environment, production artifact,
both engines:

| Check | Result |
| --- | --- |
| `CI=1 E2E_SERVER_COMMAND="bash e2e-server.sh" npm run e2e` | `Running 86 tests using 1 worker` → **86 passed (2.2m)**, 0 failed, 0 skipped, 0 did-not-run (`/home/user/GATE_E2E_CLOSURE.log`) |
| Phase-1 spec legs, chromium | `:119` setup+import ✓ · `:276` refuse then re-import ✓ · `:383` phone viewport ✓ |
| Phase-1 spec legs, webkit | same three legs ✓ |
| Opening-balance legs (Phase 2, adjacent) | `:204`, `:444`, `:454` ✓ ×2 engines |
| `npx vitest run` / `tsc --noEmit` / `npm run lint` | **909 passed** / **0 errors** / **0 errors**, 2 pre-existing warnings |
| Design-system + a11y (`@design-system`) | **32 passed** chromium · **32 passed** webkit |

No assertion was weakened to reach those numbers, and no protected file was involved: this
addendum's changes are two `e2e/` spec files and one line removed from
`.github/prettier-debt.txt` (a file that is now prettier-clean). The full closure record —
including the design-system gate's root cause, the opening-balance invariant review, the diff
review and the backup position — is §3.11 of `SCOLAIRA_10_10_TRANSFORMATION_REPORT.md`.
