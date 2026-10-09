# H-8 — Platform Support Plane and Invitations: Closeout

**Branch:** `arena/h8-platform-support` (docs-only commits `7e92b0d` scope map, `4fba3d1` checkpoint,
base `dca6a84` = the H-6 verified commit).
**Status:** implementation complete and verified. Not merged; no push in this closeout.

This document records what H-8 built, the two defects the work itself uncovered, the
measured evidence for every acceptance invariant, and the items handed forward.

---

## 1. Decisions honoured

| Decision | What was built | Evidence |
| --- | --- | --- |
| **D-1** — link-only invitations, no email provider, no H-9 | Expiring, single-use, org-scoped invitation links. The caller receives a **URL**; delivery is manual (copy/paste). No mail transport is imported anywhere in `lib/members/`. | `lib/members/invitations.ts`; `grep -rn "nodemailer\|sendgrid\|resend\|smtp" lib/members` → empty |
| **D-2** — frozen history protected | The frozen M5 files are **byte-identical** to the base (`git diff dca6a84 -- app/(app)/members/page.tsx app/api/members/route.ts` → empty) and the frozen `501` still answers. The affordance is repaired by **adding** the route the frozen page already links to. No §14 exception was requested or used. | §5 below |
| **D-3** — H-6 seed untouched | The support journey runs against a **separate, membership-less platform identity** created by the new e2e fixture, never by the seed. `e2e/support/seed.ts` is unchanged. | `git diff dca6a84 -- e2e/` shows only new files |

---

## 2. What shipped

### Schema — migration `0050_member_invitations.sql`

* `invitation_status` enum (`PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`).
* `member_invitations`: sha256 `token_hash` **only** (the plaintext token is never stored),
  partial unique index on one `PENDING` invitation per `(organization_id, email)`,
  4 CHECK constraints, `FORCE ROW LEVEL SECURITY`.
* Policies: a tenant `FOR ALL` policy and an `INSERT` policy — both carrying the same
  `auth_bootstrap` branch that `organizations_tenant_isolation` carries, so seeding stays
  possible without widening anything — plus a **RESTRICTIVE `FOR DELETE USING (false)`**
  policy (see §3.1; the permissive version was a measured no-op).
* Privileges: `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN` revoked from the app role.
  `DELETE` deliberately survives — see §3.2.
* The migration **audits itself** and fails if the guarantees are missing: ≥1 policy
  expression containing `auth_bootstrap`, `DML ⊇ {INSERT, SELECT, UPDATE}`, none of the four
  leaked privileges, and the delete-denial policy present with `polpermissive = false` and
  expression `false`.

Notices emitted on both databases: `H-8 audit: member_invitations ok — 3 policies, FORCE RLS,
required DML grants present, no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, 4 CHECK constraints,
bootstrap branch present, deletes denied at row level.`

### Application

| Area | Path | Notes |
| --- | --- | --- |
| Invitation core | `lib/members/invitations.ts` | issue / revoke / preview / accept. Re-inviting revokes the prior PENDING row **inside the same transaction**; acceptance locks the row `FOR UPDATE` (single-use) and burns the token even when the invitee is already a member |
| Schema modules | `lib/db/schema/{invitations,enums,index}.ts` | manifest at 50 (`lib/ops/migration-manifest.ts`) |
| Member APIs | `app/api/members/invitations/route.ts`, `app/api/members/invitations/[id]/route.ts` | `member.invite` (OWNER / SCHOOL_ADMIN), CSRF via `withAuthorizedRoute` |
| Public acceptance | `app/api/invitations/[token]/accept/route.ts` | GET previews without consuming; POST accepts with CSRF |
| Pages | `app/(app)/members/invite/page.tsx`, `app/(app)/invitations/[token]/page.tsx` | the invite route the frozen members page already links to, so the affordance stops 404-ing |
| Platform plane | `lib/platform/support.ts`, `lib/platform/route.ts` | `withPlatformRoute`, read-only gate, HMAC-bound claim, required audit |
| Platform APIs | `app/api/platform/orgs/route.ts`, `app/api/platform/orgs/[id]/route.ts`, `app/api/platform/support-mode/route.ts` | list, detail, enter/exit |
| Platform console | `app/platform/{layout,page,support-controls}.tsx`, `app/platform/orgs/[id]/page.tsx` | outside `(app)`; the layout re-loads `isPlatformAdmin` from the database and `notFound()`s otherwise |
| Shell | `components/ui/app-shell.tsx`, `app/(app)/layout.tsx` | platform marker, working org switcher, support banner, and one phone-width composition |

Two pages (`app/platform/page.tsx`, `app/platform/orgs/[id]/page.tsx`) re-check
`session.user.isPlatformAdmin` before any platform read. Next may render a page while the
layout that guards it is resolving to `notFound()`; without the local check an ordinary user's
request attempted platform context and the **database** refused it — correct, but noisy
(`42501 … not authorized for platform context` in the server log). The local check turns a
correct refusal into silence. The database refusal is still the thing that enforces it.

---

## 3. Defects found by the work

### 3.1 A permissive `USING (false)` policy denies nothing — measured

`member_invitations_no_delete` was first written as an ordinary (`PERMISSIVE`) `FOR DELETE
USING (false)` policy. Postgres ORs same-command permissive policies together, so next to the
permissive `FOR ALL` tenant policy the denial evaluated `TRUE OR FALSE` — **a tenant member
deleted a row**, and the test caught it:

```
expected [ Array(1) ] to deeply equal []
```

Fix: `AS RESTRICTIVE FOR DELETE USING (false)` — restrictive policies are ANDed. The
migration now audits `polpermissive = false` so the permissive form cannot come back.

**Same latent bug, not fixed here:** `reminders_no_delete` and `reminders_no_update` (migration
`0019`) are permissive `USING (false)` policies sitting next to `reminders_tenant_isolation
FOR ALL`, so they deny nothing either. `reminders` is a frozen table and out of H-8 scope — it
is handed to A5 in §6.

### 3.2 `DELETE` cannot be revoked at the table level, so the denial must be row-level

`scripts/migrate.ts:51` ends **every** migration run with
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scolaira_app`, and
`scripts/provision-db.sh:53` grants `ALL`. A table-level `REVOKE DELETE` therefore never
survives a run. Measured after a full migration run: `delete = t`, `truncate = f`,
`references = f`. The consequence is by design rather than by oversight: the app role *may*
attempt a delete and the **RESTRICTIVE policy** is what refuses it. No test asserts that
`DELETE` is absent, because that assertion would be false.

### 3.3 The mobile shell: five pages widened the viewport

The first real phone-width run failed five of eight tests. Cause: each navigation section was
wrapped in its own scroll container (`min-w-0 … shrink-0`), which widened the **page** rather
than scrolling the strip. Fix: **one** scroll container, on `<nav>` itself
(`data-scroll-container="nav-strip"`, `overflow-x-auto md:overflow-x-visible`), sections
`shrink-0`, plain `<ul>`. The measurement helper ignores subtrees inside
`[data-scroll-container]` — a deliberate scroller is not the page's problem — so the assertion
still fails a page that genuinely overflows.

### 3.4 Chromium and WebKit disagree about `scrollWidth`, and the strict criterion was wrong

WebKit reports `documentElement.scrollWidth = 380` in a 390px viewport when nothing overflows;
Chromium reports `390`. The original assertion `widest === viewport` therefore passed Chromium
and failed WebKit on all five pages with `offenders: []` — i.e. it failed the *good* case. The
acceptance criterion is **containment**, so it is now asserted as
`widest <= viewport` with `offenders` still required to be empty and the viewport still pinned
to exactly 390. This is a correction of an over-specified assertion, not a relaxation: a page
that overflows above the viewport still fails, by name.

### 3.5 Two e2e self-inflicted failures worth recording

* **Fixture hitting the wrong database.** The e2e fixture fell back to `DATABASE_MIGRATION_URL`,
  which `.env.test` points at `scolaira_test`, producing a foreign-key violation when inserting
  a seeded user. The fixture now pins its own URL, prefers `E2E_DATABASE_MIGRATION_URL`, and
  **throws unless the URL matches `/scolaira_e2e`**. e2e fixtures must never read
  `DATABASE_URL` / `DATABASE_MIGRATION_URL`.
* **An assertion satisfied by the thing it was testing.** The org-switcher test polled for the
  target organization's *name* after clicking the menu item — but the menu item itself contains
  that name, so the poll passed before the POST had returned and the following reload raced the
  cookie write. It now awaits the `/api/auth/select-organization` response, asserts `200`, and
  then asserts the chip's own `aria-label` before and after a reload. The switcher is a real
  switch through the **existing** API — no second switch path was added.

---

## 4. Verification

All commands run from the repository root.

### 4.1 Unit + integration (Vitest)

| Suite | Result |
| --- | --- |
| `tests/auth/h8-invitations.test.ts` | **17/17** |
| `tests/auth/h8-platform-boundary.test.ts` | **29/29** |
| `tests/db/h8-invitation-rls.test.ts` | **14/14** |
| `npx vitest run` (full, after every edit) | **53 files / 642 tests passed** |
| `npx tsc --noEmit` | clean |

The read-only invariant is pinned eight ways in the boundary suite, including: a mutating
capability during an open support window is refused **and the handler never runs**; a POST is
refused even when the route declares `readOnly`; a GET is refused when the route does **not**
declare it; the vocabulary holds exactly one read capability and the gate does not depend on
it; and a tenant write attempted during support mode lands in the administrator's **own**
organization. The support claim itself is pinned for tampering, cross-user replay, expiry,
domain separation from the session/active-org cookies, and `HttpOnly` scoping.

**The read-only gate (final form):** a request runs in support mode only if
`readOnly === true` **and** the method is in `SAFE_METHODS = {GET, HEAD, OPTIONS}`. Both halves
were arrived at by measurement: keying the decision on capability *names* 403'd the support
plane's own read, and a capability allow-list branch let a POST route holding `platform.audit.read`
return `200`. Do not reintroduce a capability branch.

### 4.2 End-to-end (Playwright, real seeded database)

Both engines, H-8 specs: **Chromium 15/15, WebKit 15/15** (2 auth-setup + 5 support-journey +
8 mobile-shell). Full non-`@design-system` suite on Chromium: **35/35**, which includes the
H-6 sign-in journey, the H-6 readiness gate, and the H-4 sign-out contract.

The phone assertions are geometry, on a real session at 390×844: five pages measured for
containment, sign-out visible in the first screen without scrolling, every destination
reachable from the mobile band, and exactly one
`form[action="/api/auth/logout"]` **after** a real workspace switch — the frozen contract
re-asserted at the breakpoint, not a second sign-out.

### 4.3 Gates

| Gate | Result |
| --- | --- |
| Prettier policy (`.github/workflows/ci.yml` step, replayed against `origin/main`) | **OK: 303 touched file(s) checked, 189 grandfathered, 0 new or regressed** |
| Prettier policy, H-8 change set alone (against `dca6a84`) | **OK: 30 touched file(s) checked, 0 grandfathered, 0 new or regressed** |
| Per-file format on the H-8 change set | `prettier --list-different` → empty |
| Frozen-history diff gate | no file inside the frozen change sets changed; no migration `0000`–`0049` and no `meta/_journal.json` touched |
| Migration manifest vs databases | `scolaira_test` = 50, `scolaira_e2e` = 50, **`scolaira` = 50** |

The 303 figure is the **union** of the two change sets measured against `origin/main`: 278
formattable files touched by H-6 (against `dca6a84`) and 30 touched by H-8 (against its base),
with **5 files overlapping** — so the union is `278 + 30 − 5 = 303`. An earlier revision of this
document reported 278 here; that was the H-6 set alone, read from a partially staged index
during a working-tree measurement rather than the committed branch. The gate's verdict is the
same either way: 0 new or regressed.

**Debt baseline shrunk 192 → 189.** H-8 had to edit `app/(app)/layout.tsx`,
`components/ui/app-shell.tsx` and `lib/db/schema/enums.ts`, so the three were formatted and
removed from `.github/prettier-debt.txt` in the same change — which the shrink-only rule
written into that file requires. No entry was added; the header records the shrink's provenance.

### 4.4 Production database

`0050` applied to `scolaira` (49 → 50) with the owner role and no third role introduced:
`[db] migrations applied. new=1 total=50`, self-audit notice green. With the built app running
against `scolaira` exactly as `.env.local` configures it:

```json
{"name":"schema","status":"ok","detail":{"applied":50,"expected":50,"latest":"0050_member_invitations"}}
```

`GET /api/ready` → `{"status":"ready"}` (previously `503 schema_behind(49)`),
`GET /api/health` → `{"status":"ok"}`.

### 4.5 Frozen-history protection

`git diff --stat dca6a84 -- 'app/(app)/members/page.tsx' 'app/api/members/route.ts'
'lib/auth/index.ts' 'lib/authz/permissions.ts' 'lib/auth/cookies.ts' 'lib/db/tenant.ts'
'lib/db/scope.ts' 'lib/ops/readiness.ts' 'scripts/migrate.ts' 'scripts/provision-db.sh'` → empty.

Nothing was added to the identity boundary: support mode reuses the existing platform scope
(`auth_scope_platform_local`) and the existing org-switch API; the H-4 sign-out form and its
CSRF field are untouched and re-asserted at 390×844.

---

## 5. Acceptance invariants

| Invariant | How it is enforced | How it is proven |
| --- | --- | --- |
| Tokens hashed, expiring, single-use, org-scoped | sha256 at rest; expiry column; `FOR UPDATE` consume; every query carries `organization_id` | `h8-invitations` 17/17; `h8-invitation-rls` 14/14 |
| Invitation RLS enforced | own-org policies + **RESTRICTIVE** delete denial | `h8-invitation-rls` (a tenant delete removes nothing) |
| Support mode strictly read-only, every mutation fails | `readOnly ∧ SAFE_METHODS`, no mutation capability exists | boundary suite, §4.1 |
| Every support entry leaves required audit evidence | audit is written **before** the claim is issued; a failing audit writer aborts the entry | boundary suite: entry aborts on audit failure; exit failure propagates |
| Platform context HMAC-bound, un-self-forgeable | the database mints it (`withPlatformContext`); a forged `app.is_platform_admin='1'` authorizes nothing | boundary suite: forged GUCs → 0 orgs; real admin → 2 orgs |
| Shell works at 390×844 with no horizontal overflow | one scroll container on `<nav>` | both engines, 5 pages, containment asserted |
| Existing org-switch API reused | the chip posts to the existing `/api/auth/select-organization` | e2e switch asserts the response and the persisted cookie |
| H-4 sign-out / CSRF intact | untouched | exactly one logout form with `_csrf`, before and after a switch |
| No M4 identity redesign, no M5–M11 changes, no H-9/A5/M12 | see §4.5 | frozen-history diff gate |

---

## 6. Handed forward (out of H-8 scope, deliberately not fixed)

1. **`reminders_no_delete` / `reminders_no_update` (0019) deny nothing** — permissive
   `USING (false)` beside a permissive `FOR ALL` tenant policy. Frozen table; A5 must apply the
   same `AS RESTRICTIVE` fix that `0050` needed.
2. **Default privileges leak beyond the four revoked privileges** — post-0044 tables inherit
   `TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN` (measured on `financial_periods`,
   `surface_scope_settings`). New tenant tables must revoke explicitly **and** use a RESTRICTIVE
   policy for row-level denial.
3. **The runner re-grants `DELETE` on every table** on every migration run (§3.2).
4. **`meta/_journal.json`** is still written by nothing that reads it.
5. **WebKit is not in the local default `test:e2e` path** — it was installed and run for the
   H-8 specs; the mobile geometry check is the one that needs both engines, because that is
   where the two engines disagree (§3.4).
6. **The e2e database is reused between runs, not reset.** Audit assertions therefore assert
   **deltas**, never absolute counts. If H-8 e2e is ever put into CI, the database must be
   recreated or the trail opened per run.

---

## 7. What was not done

* Not merged. Not pushed. `main` is untouched, and both H-6 draft PRs are untouched.
* No email transport, no H-9 surface, no M12 work.
* No change to any frozen change set, and no request for a §14 exception.
