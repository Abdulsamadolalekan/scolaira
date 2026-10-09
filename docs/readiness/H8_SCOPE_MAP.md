# H-8 Scope Map — authenticated shell identity, mobile behaviour, invitation, and the support journey

**Status: RECONNAISSANCE ONLY — no code written, no file modified, plan awaiting authorization.**
This document is deliberately **untracked**: the H-6 branch state verified at commit
`dca6a84dde48254b45f233fe09d4654098a5ab48` (hosted run 36211198924) must stay exactly as
verified until the founder authorizes a change.

Method: read-only inspection of the register entry, the cited files, the frozen tags, the
authorization matrix, the migration directory, the seed, and the test suite. Every claim
below carries a file:line or a measured command result.

Register entry: `docs/readiness/POST_M11_READINESS_AUDIT.md` §H-8 — *"Authenticated shell
identity, mobile behaviour, and the platform-support journey are incomplete."*
Pilot requirement: **Required.** ADQ requirement: **journey walkthrough evidence at both
viewports** (`ACQUISITION_DUE_DILIGENCE_CHECKLIST.md:61`, C6 = **Partial**).

---

## 1. Findings (measured)

### F1 — The invitation affordance is broken in two independent layers, and neither is tested

| Layer | State | Evidence |
| --- | --- | --- |
| UI link | Links to `/members/invite`, which **does not exist** → 404 | `app/(app)/members/page.tsx:54` renders `<Link href="/members/invite">Invite member</Link>`; `find 'app/(app)/members' -type f` returns **only `page.tsx`**; no `invite` directory anywhere under `app/` |
| API | `POST /api/members` returns **404** for an unknown email, **501 NOT_IMPLEMENTED** for a known one | `app/api/members/route.ts:92-107` |
| Tests | **Neither layer is covered.** No test references `members/invite` or `member.invite`; `m4-pentest` explicitly defers the route | `tests/auth/m4-pentest.test.ts:82-83` — *"POST /api/members (invite) ships with the members-write M5 slice;"*; `grep -rn "members/invite" tests/ e2e/` → **no matches**; `grep -rn "member.invite" tests/` → **no matches** |
| Schema | Partial support only: `organization_members.status` allows `INVITED` and there is an `invited_at` column, but there is **no invitation/token table** | `lib/db/schema/tenancy.ts:65-66`; `grep -rn "invite_token\|invitation" lib/db/schema/*.ts` → nothing |
| Authorization | The permission exists and is granted to OWNER/SCHOOL_ADMIN | `lib/authz/permissions.ts:47,178,198` (`member.invite`) |
| Delivery | **No email delivery exists anywhere in the codebase** | §2/D1 below |

### F2 — The shell has no concept of platform identity; a platform admin is presented as an ordinary Staff member

- `PLATFORM_ADMIN` is deliberately **not** a membership role (`lib/db/schema/enums.ts:21-24`, enforced by CHECK).
- The E2E seed nevertheless gives the platform identity a **`STAFF` membership** in Demo School
  (`scripts/seed-e2e.ts:199-201`), so the shell renders *"Demo School / Staff"* for an account that
  holds cross-tenant capability. The platform nature is invisible in the UI.
- The shell's `role`/`org` values are derived purely from membership:
  `role: activeOrg?.role ?? null`, `org.name = (activeOrg as any)?.name ?? 'Workspace'`
  (`app/(app)/layout.tsx:78-90`). For a platform admin **without** a membership, the shell shows
  *"Workspace"* with no role, and `buildNav(null)` reduces the nav to the single `roles: null` item
  (Command Center) — a second, distinct failure mode.
- `lib/auth/index.ts:255` resolves the active org from the signed `sc_org` cookie; the shell never
  surfaces which org is active beyond the name.

### F3 — The org switcher is a dead control, though the server side is already built and tested

- The shell renders a workspace block styled as a dropdown — rounded box, chevron — but it is a
  plain `<div>` with a decorative `<ChevronDown />` and no handler
  (`components/ui/app-shell.tsx:127-146`).
- `switcherHref` is a **dead prop**: declared in the interface (`app-shell.tsx:50`), set to `null`
  by the only caller (`app/(app)/layout.tsx:88`), and **never read** in the render.
- `switchOrganization()` exists but has **no callers** (`lib/auth/index.ts:832`; the H-4 F10 residual).
- **The API is already implemented and covered**: `POST /api/auth/select-organization`
  verifies ACTIVE membership, signs the active-org cookie, and is CSRF-protected
  (`app/api/auth/select-organization/route.ts`); tests prove own-org success and
  foreign-org rejection (`tests/auth/authz.test.ts:89,311-312`).
  → **H-8's switcher is UI wiring, not a backend build.**

### F4 — 390px has never been exercised against the authenticated shell

- `AppShell` is imported by exactly one file — `app/(app)/layout.tsx:18`. Preview pages use a
  **different** component, `NavShell` (`app/preview/layout.tsx:9,17`;
  `components/ui/nav-shell.tsx`, last touched by M1).
- 390×844 appears exactly once in the repo: `e2e/screenshots.spec.ts:22-24`, in the
  `@design-system` suite, whose page list is entirely `/preview/*` (`:25-31`).
- The journey suites run only at Desktop Chrome / Desktop Safari
  (`playwright.config.ts:10-21`). No mobile project, no authenticated mobile spec.
  → The 390px screenshots that exist depict a shell the product does not use.
- Composition defect (code-read; to be confirmed by measurement in the remediation):
  below `md` the responsive gates (`md:flex-row`, `md:w-64`, `md:sticky`) fall away, so the entire
  `<aside>` — brand, workspace block, every nav section, and the user card — stacks **above**
  `<main>` (`components/ui/app-shell.tsx:75-81,151-175,238-267`). Nav rows are `overflow-x-auto`
  (`:160`), so each section becomes a horizontally scrolling strip. At 390px the user must scroll
  past all of it before content appears.

### F5 — The support journey has no surface, but its authorization layer is already complete

**Absent:** there is no `/platform` (or support/admin) route of any kind —
`find app -type d | grep -iE "platform|support|admin"` returns nothing.

**Present and complete** (this is the important finding — the hard part is already built and frozen):

| Element | Evidence |
| --- | --- |
| Capability `platform.support.enter` | `lib/authz/permissions.ts:29-33` |
| Platform policy: only 4 capabilities, no `platform.bypass` / `platform.everything` | `permissions.ts:266-269` |
| **Read-only allowlist** in support mode, with an explicit *"NO mutations in support mode"* | `permissions.ts:271-288` |
| `canPlatform(userIsPlatformAdmin, cap)` | `permissions.ts:324-327` |
| `withPlatformContext(userId, fn)` — server-side entry | `lib/db/tenant.ts:112-119` |
| DB entry function `enter_platform_context(uuid)`, GRANTed to `scolaira_app` | migrations; `GRANT EXECUTE … TO scolaira_app` |
| Forged-GUC resistance: `auth_is_platform_admin_authorized()` requires `app.is_platform_admin='1'` **and** a valid `app.platform_admin_id` resolved against `users.is_platform_admin` | `lib/db/migrations/0010_lockdown_secdef.sql:70-91` |
| Platform token is minted by the DB and bound to the backend; `auth_platform_token_for` is REVOKEd from the app role | `lib/db/tenant.ts:107-110`; `REVOKE ALL ON FUNCTION auth_platform_token_for(uuid) FROM PUBLIC, scolaira_app` |
| Regular tenant routes can never hold platform powers (`setTenantFor()` resets `is_platform_admin='0'`) | `permissions.ts:25-27` |

**Test gap:** no test anywhere references `PLATFORM_POLICY`, `canPlatform`, or `withPlatformContext`
(`grep -rln` over `tests/` → no matches). The support path is designed and unrehearsed.

**Attribution is available without schema change:** `audit_events` carries `organizationId`
(nullable, `on delete set null`), `actorType` (`USER|SYSTEM|WEBHOOK`), `actorUserId`, `actorLabel`,
`action`, `metadata` (`lib/db/schema/platform.ts:95-122`). A first-class `PLATFORM` actor type
would be a new enum value → migration.

### F6 — Migration bookkeeping inconsistency (pre-existing; blocks a clean 0050)

- 49 `.sql` files exist; `lib/ops/migration-manifest.ts:17,20` pins count **49** / latest
  `0049_h6_release_evidence`; the drift test checks the **directory**.
- `lib/db/migrations/meta/_journal.json` has **48 entries and does not contain 0049**.
- Neither the runner (`scripts/apply-migrations.ts` scans `.sql` files, sorted) nor the drift test
  reads the journal, so nothing is broken today — but `lib/db/migrate.ts:24` instructs contributors
  to *"Add the entry to `lib/db/migrations/meta/_journal.json`"*. The next migration (**0050**) must
  not be added on top of an ambiguous artefact without settling this.

---

## 2. Dependencies

- **D1 — No transactional email exists.** `RESEND_API_KEY` / `FROM_EMAIL_ADDRESS` are declared
  (`lib/security/env.ts:49-52`, both `optional`; `.env.example:52-53`; `docs/DEPLOYMENT.md:67-68`)
  and are **referenced by no code** (`grep` over `lib/`, `app/`, `scripts/` → only the env
  declaration). Precedent for a no-provider v1 exists: reminders state *"PRINT is synchronously
  delivered in this milestone. Unsupported external channels are queued as PENDING until a provider
  actually delivers them"* (`lib/db/repo/reminders.ts:66-67`). **Invitation email is therefore not
  available in H-8 without new provider work — and provider work belongs to H-9.** This is the main
  scoping decision to make (§5/D-1).
- **D2 — Readiness must stay green.** `/api/ready` requires database + schema + auth only
  (`lib/ops/readiness.ts`); adding a surface must not add a new required dependency.
- **D3 — Migration ordering.** H-8's first migration is **0050**; it must not renumber or edit
  `0000`–`0049`.
- **D4 — Platform identity in the seed.** The E2E seed already provisions a platform admin
  (`scripts/seed-e2e.ts:108,191-201`) and the H-6 suite proves it authenticates
  (`e2e/school-journey.spec.ts:122-134`). An H-8 support journey can be rehearsed on today's seed
  — but that seed currently also gives it a STAFF membership, which may want changing **for the
  journey to be honest** (see D-3).

## 3. Pilot-gate requirements

1. **Required** (register §H-8) — the four sub-findings must be resolved or explicitly documented.
2. **ADQ C6** (*"Is actor attribution complete for privileged access?"* — currently **Partial**):
   needs a **sanctioned, attributable** support path, i.e. entry into support mode must be an
   audited event naming the actor and the target organization.
3. **ADQ D-requirement:** journey walkthrough evidence **at both viewports** — which today cannot
   be produced for the authenticated shell at all (F4).

## 4. Proposed remediation

Design principle: **use the frozen authorization model, never rework it.** Every element reads the
existing capability, enters via the existing `withPlatformContext`, and mutates nothing.

### 4a. Invitation (F1)

- **New (no frozen file touched):** `app/(app)/members/invite/page.tsx` — the missing route that the
  existing link already points at, so the broken affordance is repaired **without editing the
  M5-FROZEN members page**.
- **New:** `app/api/members/invitations/route.ts` — create/list invitations, guarded by the existing
  `member.invite` action through the standard `withAuthorizedRoute` wrapper.
- **New:** `lib/members/invitations.ts` — token minting (hash-at-rest, single-use, expiring),
  acceptance, and revocation. Mirrors the existing password-reset token design rather than
  inventing a new one.
- **Migration 0050 (new, additive):** `member_invitations` (id, organization_id, email, role,
  token_hash, expires_at, invited_by, status, accepted_at, created_at) + indexes + RLS policy in the
  same shape as other tenant tables. **No edit to any applied migration.**
- **Delivery (pending D-1):** v1 exposes the invite link to the inviter exactly as the dev reset
  echo works (`SCOLAIRA_DEV_ECHO_RESET_TOKEN`) with no provider; email delivery, if wanted, is a
  separate authorized item.
- **Deprecation path for the frozen 501:** leave `POST /api/members` untouched and documented as
  superseded (it can be removed only with explicit authorization — see §5/D-2).

### 4b. Shell identity (F2, F3)

- **New:** `lib/platform/identity.ts` — resolves `{ isPlatformAdmin, supportMode }` for the shell.
- **Modified (non-frozen, H-4-bearing — H-4 behaviour preserved and re-verified):**
  `components/ui/app-shell.tsx` and `app/(app)/layout.tsx`:
  - wire the workspace block to `POST /api/auth/select-organization` (remove the dead
    `switcherHref` prop or give it real meaning) — no new endpoint needed;
  - render platform identity distinctly (e.g. a *Platform* marker) instead of impersonating a
    membership role;
  - surface a **"Enter support mode"** affordance for platform admins, gated on
    `canPlatform(user.isPlatformAdmin, 'platform.support.enter')`.
- **Explicitly not changed:** the M4 GUC/authz boundary, `PLATFORM_POLICY`, `PLATFORM_SUPPORT_ACTIONS`,
  any RLS policy, and the identity-visibility door (F11) — see §5/D-4.

### 4c. 390px behaviour (F4)

- **Modified:** `components/ui/app-shell.tsx` — collapse the aside below `md` into a compact header
  (or a disclosure/drawer) so content is reachable without scrolling past the whole navigation;
  keep desktop composition as-is.
- **New:** `e2e/mobile-shell.spec.ts` — authenticated, `test.use({ viewport: { width: 390, height: 844 } })`,
  asserting: content visible without scrolling past chrome; nav reachable; **no horizontal overflow**
  (`document.scrollingElement.scrollWidth <= 390`); primary action reachable. Runs on chromium and
  webkit in the release gate.

### 4d. Support journey (F5)

- **New:** `app/platform/page.tsx` (organization directory) and
  `app/platform/orgs/[id]/page.tsx` (read-only tenant view: dashboard/financials/audit), plus
  `app/api/platform/orgs/route.ts` and `app/api/platform/orgs/[id]/route.ts`.
- **New:** `lib/platform/support.ts` — entry helper: verify `canPlatform(...)`, call
  `withPlatformContext`, write one `audit_events` row on entry (`action: 'platform.support.entered'`,
  `actorUserId`, target `organizationId`, `metadata` with reason/requestId).
- **New:** `app/platform/layout.tsx` — persistent support-mode banner naming the target org, so an
  operator can never mistake it for their own tenant.
- **Dependencies:** none new; readiness unaffected (D2).
- **Optional migration 0051:** add `PLATFORM` to `audit_actor_type` — only if the audit row should
  be first-class rather than `actorType='USER'` + metadata.

### 4e. Tests (all new unless noted)

| Test | Proves |
| --- | --- |
| `tests/auth/h8-invitations.test.ts` | token mint/accept/expire/single-use; cross-org token rejected; `member.invite` boundary (role matrix, foreign org) |
| `tests/auth/h8-platform-boundary.test.ts` | `canPlatform` matrix; support mode **cannot mutate** (a write must fail); forged `is_platform_admin` GUC alone authorizes nothing; entry writes exactly one audit row |
| `tests/db/h8-invitation-rls.test.ts` | RLS: invitations invisible cross-tenant; tenant context required |
| `e2e/mobile-shell.spec.ts` | §4c acceptance |
| `e2e/support-journey.spec.ts` | platform admin enters support mode for Demo School, sees data read-only, mutation affordances absent |
| `e2e/invitation-journey.spec.ts` | invite (owner) → link → accept → membership ACTIVE; replayed token rejected |
| *(existing, must stay green)* | `582` tests, H-6 release gate, readiness 503→200 |

### 4f. Suggested sequencing

1. Migration bookkeeping (F6) — resolve the journal question, then 0050.
2. Invitation (4a) — smallest independent slice, unblocks the broken link.
3. Mobile shell (4c) — buys the ADQ "both viewports" evidence.
4. Shell identity + platform marker (4b).
5. Support journey (4d) last — it depends on 4b's affordance and the audit helper.

## 5. Conflicts with frozen history (must be resolved before implementation)

**D-1 — Email delivery is H-9 territory.** Invitations imply outbound email, but no provider exists
(D1) and the register assigns provider work to H-9. *Proposal:* v1 ships token + link with no
provider (reminder-PRINT precedent); email is a follow-on. **Requires a founder decision.**

**D-2 — Two invitation files sit inside the `M5-FROZEN` tag.** Measured:
`app/(app)/members/page.tsx` and `app/api/members/route.ts` were last modified by `66f4a0c`
("M5 gate…"), which is contained in `M5-FROZEN`, `m8-…`, `m9-…`, `m10-…`, `m11-…`.
Section 14 of the register lists **"M5–M11 implementation code"** under **DO NOT TOUCH**.
*Proposal:* the design above (§4a) repairs the affordance **without touching either file** —
the missing route is created fresh, and the 501 handler is left in place as documented-superseded.
*If the founder prefers the correct location* (implementing inside `POST /api/members`), that is an
explicit exception to §14 and must be authorized as such. **Requires a founder decision.**

**D-3 — The seed's platform identity is given a `STAFF` membership.** Honest H-8 evidence needs the
platform identity presented as platform, not as staff. Changing the seed touches
`scripts/seed-e2e.ts`, an **H-6 file** (accepted change set). *Proposal:* add a second, membership-less
platform identity for the support journey rather than editing the H-6 seed's existing one; or edit
the H-6 seed with explicit authorization. **Requires a founder decision.**

**D-4 — The identity-visibility door (F11) is *not* in H-8.** The H-6 spec comment says visibility
*"belongs to H-8"* (`e2e/school-journey.spec.ts:125-126`), but the standing instruction is that the
**M4 authentication boundary is not to be redesigned** — it is measured and documented only
(`H4_SCOPE_MAP.md:37,42`; `H4_AUTH_LIFECYCLE_CLOSEOUT.md:34`; `H6_SCOPE_MAP.md:70`). Closing F11
means narrowing the `app.auth_bootstrap` / `app.user_id` GUC branch and is **dominated** by an
app-EXECUTE-able SECURITY DEFINER, i.e. it is a migration-level change to a frozen R1/R3/H-5 model.
*Proposal:* H-8 builds on the `platform.support.enter` capability and does **not** touch F11;
the misleading comment in the H-6 spec should be corrected only with authorization to edit an H-6 file.

**D-5 — Shell files carry H-4 content.** `components/ui/app-shell.tsx` and `app/(app)/layout.tsx`
were last modified by H-4 (`ba45185`): the shell's sign-out form and CSRF handling are H-4 work.
*Proposal:* H-8 edits them in **new commits**, preserving the sign-out/CSRF behaviour and the H-4
tests; no H-4 commit is amended, retagged or reformatted (the precedent applied to the frozen
H-4 test file during H-6).

**D-6 — Nothing frozen may be reformatted.** The 192-path prettier debt baseline includes every file
above. H-8 must keep the shrink-only discipline: files it touches must be clean, listed debt must be
retired path-by-path, and no frozen file may be swept.

## 6. Acceptance gates

1. Invitation: link resolves (no 404); API no longer answers 501 on the new path; token
   single-use, expiring, org-scoped; unauthorized roles blocked; **replayed token rejected**.
2. Support journey: entry requires the capability; **every mutation attempt fails**; one audit row
   per entry naming actor + target org; support mode visually unmistakable.
3. Mobile: authenticated journey passes at **390×844** on chromium **and** webkit with no horizontal
   overflow.
4. Shell identity: org switcher works against the existing endpoint (own org only; foreign org
   rejected — reusing the existing tests' guarantees); platform identity distinguishable from a
   membership role.
5. No regression: `582` tests green; H-6 release gate green; `/api/ready` still fails closed
   (503 → 200 after migrate) and leaks nothing; readiness gains no new required dependency.
6. Frozen-history check: `git diff --name-only` over the H-8 change set contains **no** file inside
   `M5-FROZEN` / `m8-…` / `m9-…` / `m10-…` / `m11-…` tags and **no** amendment to R1/R2/R3/H-2/H-4/H-5/H-6
   commits; re-run the drift test (`migration-manifest` = 49 → 50) and the journal decision from F6.
7. Hosted CI: the committed workflow's `quality`, `readiness`, `e2e` jobs green on a GitHub-hosted
   runner for the H-8 commit.

## 7. Explicitly out of scope

H-9 (provider/claims, backup–restore drill) · A5 (FORCE-RLS coverage audit) · M12 · the
identity-visibility door F11 · the frozen identity/tenure of every M1–M11 artefact · any RLS,
authz, CSRF, idempotency or audit **design** change · the 192-path prettier debt beyond the files
H-8 itself touches.

---

*Prepared read-only. Awaiting authorization: (a) the plan itself, (b) decisions D-1 … D-3, and
(c) whether this document should be committed.*
