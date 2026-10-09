# H-8 Implementation Checkpoint

**Branch:** `arena/h8-platform-support` (based on the H-6 **tested SHA**
`dca6a84dde48254b45f233fe09d4654098a5ab48`, so the verified H-6 branch state is untouched).
**Status:** checkpoint committed before implementation, per instruction.

Decisions in force: **D-1** token/link invitations, **no email provider, no H-9 scope**;
**D-2** frozen `app/(app)/members/page.tsx` and `app/api/members/route.ts` are **not touched**;
**D-3** the H-6 seed is **not touched** — separate fixtures instead.

---

## 1. Findings that shape the design (measured this pass)

1. **Platform authorization is already complete and HMAC-bound.** The *effective*
   `auth_is_platform_admin_authorized()` requires `app.is_platform_admin='1'` **and**
   `app.platform_token = auth_platform_token_for(app.platform_admin_id)`.
   Measured as the runtime role:
   - forged GUCs (`is_platform_admin=1`, real admin id, bogus token) → `authorized = f`, **0** orgs visible;
   - `enter_platform_context(<real admin>)` → `authorized = t`, **2** orgs and **2** memberships visible;
   - tenant context for one org → **1** org visible (isolation intact);
   - the runtime role **cannot mint** the token: `ERROR: permission denied for function auth_platform_token_for`.
   → H-8 builds **on** this. No policy, GUC or boundary is changed.
2. **Effective RLS gives platform context cross-tenant READ**: `organizations_tenant_isolation`
   USING = `auth_is_platform_admin_authorized() OR auth_bootstrap OR (tenant-authorised AND id = current_org)`;
   `audit_events_tenant_isolation` (ALL, incl. INSERT check) permits a platform-context insert for the
   **target** org. So the support directory and its audit trail need **no schema change**.
3. **RLS does not itself make support read-only.** Platform context is RLS-permissive for both reads
   *and* writes, so the read-only guarantee must come from (a) the app-layer allowlist
   (`PLATFORM_SUPPORT_ACTIONS`, `authorize()` returning *"platform support mode cannot perform mutations"*)
   and (b) H-8 exposing **no mutation path at all**. Both are required and both are tested.
4. **A membership-less platform admin cannot hold a session.** `getSession()` returns `null` when the
   user has no ACTIVE membership (`lib/auth/index.ts:249-251`). Changing that would be an **M4
   identity-boundary redesign — forbidden.** Consequence for D-3: the "membership-less platform
   identity" is used as a **fixture for DB-level tests** (context entry, audit, read-only, and to pin
   the measured fact that such an identity gets no session), while the **journey** runs as a platform
   admin who is a member of *one* org and enters support mode for *another* — the real support case.
5. **A foreign org can never be reached through the tenant path**, because `activeOrganizationId` is
   resolved from memberships only. Support reads therefore run inside `withPlatformContext`, and the
   support surface lives at `/platform/...` rather than borrowing the tenant routes.
6. `sessions.is_platform_session` exists and is **read but never written** anywhere — the
   "enter support mode" entry point the M4 schema comment describes is the missing piece H-8 adds.

## 2. Files

### Added
| Path | Purpose |
| --- | --- |
| `lib/db/migrations/0050_member_invitations.sql` | `member_invitations` table + RLS + grants + self-audit |
| `lib/members/invitations.ts` | mint / list / revoke / accept (hashed, expiring, single-use, org-scoped) |
| `app/api/members/invitations/route.ts` | `GET` list (`member.read`), `POST` create (`member.invite`) |
| `app/api/members/invitations/[id]/route.ts` | `DELETE` revoke (`member.invite`) |
| `app/(app)/members/invite/page.tsx` | **the route the frozen page already links to** (fixes the 404 without editing it) |
| `app/(app)/invitations/[token]/page.tsx` | accept screen (authenticated) |
| `app/api/invitations/[token]/accept/route.ts` | accept endpoint (email must match the invitation) |
| `lib/platform/support.ts` | `listSupportOrganizations`, `supportOrgSummary`, `enterSupportMode`, `exitSupportMode` (audited) |
| `lib/platform/route.ts` | `withPlatformRoute` — session + CSRF + `canPlatform` + `withPlatformContext` |
| `app/api/platform/orgs/route.ts`, `app/api/platform/orgs/[id]/route.ts` | read-only platform APIs |
| `app/api/platform/support-mode/route.ts` | `POST` enter / `DELETE` exit (+ audit) |
| `app/platform/layout.tsx`, `app/platform/page.tsx`, `app/platform/orgs/[id]/page.tsx` | support surface with an unmistakable banner |
| `tests/auth/h8-invitations.test.ts`, `tests/auth/h8-platform-boundary.test.ts`, `tests/db/h8-invitation-rls.test.ts` | the invariants below |
| `e2e/support-journey.spec.ts`, `e2e/mobile-shell.spec.ts` | pilot/ADQ journey evidence (both viewports; 390×844) |
| `docs/readiness/H8_CLOSEOUT.md` | evidence + residual list |

### Modified
| Path | Change |
| --- | --- |
| `components/ui/app-shell.tsx` | platform marker; **working** org switcher; support banner/affordance; mobile composition below `md` |
| `app/(app)/layout.tsx` | pass `isPlatformAdmin`, memberships, support-mode flag into the shell |
| `lib/ops/migration-manifest.ts` | **the only H-6 file touched**: `EXPECTED_MIGRATION_COUNT` 49→50, `LATEST_MIGRATION_TAG` →`0050_member_invitations`. **Declared exception** — see §3 |
| `docs/readiness/POST_M11_READINESS_AUDIT.md` | H-8 status |

### Deliberately NOT touched
`app/(app)/members/page.tsx` · `app/api/members/route.ts` (frozen M5; the 501 stays and is documented as superseded) ·
`scripts/seed-e2e.ts` and everything else in the H-6 change set · all RLS policies · `PLATFORM_POLICY` /
`PLATFORM_SUPPORT_ACTIONS` · `getSession`/login/`set_tenant_context` · the M4 identity-visibility door (F11) ·
every migration `0000`–`0049` · `lib/db/migrations/meta/_journal.json` (stale by design, unread by the runner).

## 3. Migration and the one declared exception

**0050_member_invitations** is additive: new table, new enum, new indexes, new policies, grants,
self-audit `DO` block. No applied migration is edited; the journal is left alone (nothing reads it).

**Declared exception — `lib/ops/migration-manifest.ts`:** adding a migration *requires* it. That file
pins the expected count/tag and `lib/ops/migration-manifest.test.ts` asserts the directory matches;
leaving it at 49 would make the drift test fail **and** make `/api/ready` report `schema_ahead` (503)
on every correctly-migrated deployment — a false red that would break the H-6 invariant of truthful
readiness. The change is two constants, moves the pin in lockstep with the migration set exactly as
the file's own docblock requires, and **alters no H-6 behaviour**. Flagged for the founder; nothing
else in H-6 is touched.

## 4. Tests → invariants

| Test | Invariant |
| --- | --- |
| `h8-invitations` | token is **hashed at rest** (plaintext never stored/returned on list), **expiring** (expired rejected), **single-use** (replay rejected, consumption is race-safe via `FOR UPDATE`), **org-scoped** (org A's token cannot grant membership in org B), accepting email must match, role matrix (`member.invite`/`member.read`), audit rows written |
| `h8-platform-boundary` | capability matrix; **forged GUCs authorize nothing**; DB-minted context reads cross-tenant; **every mutation attempt in support mode fails** (app layer) and no mutation endpoint is reachable; **each entry writes exactly one audit row** naming actor + target org |
| `h8-invitation-rls` | RLS: cross-tenant invitation invisibility; tenant context required; app cannot `DELETE`; no public policy |
| `e2e/support-journey` | platform admin enters support mode for Demo School, sees its data, mutation affordances absent, banner present |
| `e2e/mobile-shell` | authenticated shell at **390×844** on chromium **and** webkit: `scrollWidth <= 390`, content reachable, primary action reachable |

## 5. Frozen-history implications

- Base is the tested H-6 SHA; the H-6 branch (`arena/h6-ci-verification`, pushed head `dca6a84`) is
  **not modified** — verified by `git ls-remote` after the docs commit.
- The frozen-invariant diff gate is preserved and will be re-run: no file inside `M5-FROZEN`,
  `m8-…`, `m9-…`, `m10-…`, `m11-…` tags; no amendment to R1/R2/R3/H-2/H-4/H-5/H-6 commits; H-4
  sign-out/CSRF behaviour in the shell preserved (re-verified by the existing tests).
- Prettier: files H-8 touches must be clean; the 192-path shrink-only baseline is not expanded.

## 6. Acceptance gates

1. Invitation link resolves (no 404) and the new API path does not answer 501.
2. Token: hashed, expiring, single-use, org-scoped; replayed and foreign tokens rejected.
3. Support mode: entry requires the capability; **every mutation fails**; exactly one audit row per
   entry naming actor and target org; forged platform context authorizes nothing.
4. Shell at 390×844: no horizontal overflow, authenticated, both engines.
5. Org switcher reuses `POST /api/auth/select-organization` (no duplicate endpoint).
6. H-4 sign-out/CSRF intact; no M4 boundary change; no M5–M11 change; no H-9/A5/M12 work.
7. Full regression green (582 existing + new), and `/api/ready` still fails closed (503 before
   migrate → 200 after) with the manifest at 50.
