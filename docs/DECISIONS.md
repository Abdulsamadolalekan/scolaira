# SCOLAIRA — Decision Log

> Every significant decision is classified: MUST / SHOULD / MAY / DEFER and tagged with domains.

Format: `D-<id> | <date> | <classification> | <tags> — <summary>`

---

## Pending (Awaiting Approval)

See `/docs/ARCHITECTURE.md` §T — D1 through D15. These decisions gate Phase 0 exit.

## Log

### D-001 | 2026-09-15 | MUST | ARCHITECTURE
**Decision:** Do not code on day 1; produce documentation and architecture review first.
**Why:** Per company-build directive §67/§68. Coding before architecture, security, and invariants are defined is how the previous project lost coherence and safety.
**Benefit:** Single source of truth, explicit approvals, known risks.
**Risk:** Slower nominal start; pays for itself in avoiding rework.
**Status:** Adopted this session.

### D-002 | 2026-09-15 | SHOULD | ARCHITECTURE, OPERATIONS
**Decision:** Adopt a monolithic Next.js application for pilot (Next.js + Drizzle + Postgres/Supabase + Tailwind).
**Why:** Lean stack, single language, fast iteration, low ops overhead. Avoids premature microservices and enables fast correctness work.
**Benefit:** Speed, simplicity, easier correctness reasoning.
**Risk:** Vercel/Supabase lock-in (mitigated by standard frameworks, documented migration path).
**Migration cost off platform:** Acceptable — standard Next.js/Postgres migrate easily.
**Status:** RECOMMENDED; pending D1 approval.

### D-003 | 2026-09-15 | MUST | FINANCIAL, DATA
**Decision:** Internal money representation is INTEGER KOBO (BIGINT); external API is NAIRA STRING.
**Why:** Per directives §6.
**Benefit:** Eliminates floating-point errors; exact arithmetic; clear contract boundary.
**Risk:** Serialization mistakes at the boundary; mitigated by single conversion module and tests.
**Status:** Adopted as canonical invariant in /docs/FINANCIAL_INVARIANTS.md.

### D-004 | 2026-09-15 | MUST | FINANCIAL
**Decision:** Allocation is deterministic (overdue-first, then current, then prior-term; remainder stays unallocated for review). Finance officer can reallocate within audited controls.
**Why:** No silent magic; explainable; works for auto-recorded transfers; gives finance officer control.
**Benefit:** Predictability, auditability, testability.
**Risk:** May not match every school's idiosyncratic allocation preference — address by allowing manual reallocation; revisit if pilot schools reveal strong pattern.
**Status:** Proposed as default; pending validation with pilot school finance officer.

### D-005 | 2026-09-15 | MUST | SECURITY
**Decision:** Tenant isolation uses defense-in-depth: application-level org scoping + Postgres Row Level Security.
**Why:** Relying on a single layer has historically produced breaches in SaaS.
**Benefit:** Resilience to application bugs; reduces blast radius.
**Risk:** Slightly more schema/test overhead; acceptable.
**Status:** Proposed; pending D1 approval.

### D-006 | 2026-09-15 | MUST | UX
**Decision:** Parents do NOT create conventional SCOLAIRA accounts. Parent experience is transactional (message → view → pay → receipt), mobile-first, via signed expiring links.
**Why:** Per directives §3/§61/§62; parents are not the customer; forcing accounts kills conversion and trust.
**Benefit:** Lower friction, higher payment rates, no password-management burden on parents.
**Risk:** Harder to show multi-year history to parents without login — address with long-lived signed "statement" links if needed post-pilot.
**Status:** Adopted as product principle.

### D-007 | 2026-09-15 | MUST | DATA
**Decision:** No SQLite for dev; use local Postgres from day one.
**Why:** Avoid SQLite→Postgres migration pain per §25; Drizzle supports Postgres natively; local Postgres via Docker is easy.
**Benefit:** No dialect drift; same SQL semantics in dev, test, prod.
**Risk:** Slightly heavier dev setup — mitigated by docker-compose one-liner.
**Status:** Proposed as dev standard.

### D-008 | 2026-09-15 | SHOULD | UX, VISUAL
**Decision:** Adopt interim palette: deep emerald `#046A38`, rich gold `#C9A961` (accent only), near-black `#0B1F16`, white `#FFFFFF`, warm paper `#F7F3EC` for backgrounds. Pending brand system (D8).
**Why:** Matches "private bank × distinguished school" directive with emerald as Nigerian green resonance; gold as premium accent without overuse.
**Benefit:** Enables UI work during scaffolding without waiting for final brand assets.
**Risk:** Refactor when final brand arrives; acceptable if tokens are centralized.
**Status:** Interim recommendation; see /docs/UX_PRINCIPLES.md.

### D-009 | 2026-09-15 | MUST | FINANCIAL, UX
**Decision:** Confirmed payments cannot be deleted. Reversal and correction are the only correction paths, with required reason and audit entry.
**Why:** Per §6/§8; preserves financial truth; protects proprietor trust.
**Benefit:** Non-destructive history; enables dispute resolution.
**Risk:** Finance officers new to software may expect a "delete" button; address with clear UI for reversal and training.
**Status:** Adopted as invariant F5/F6.

### D-010 | 2026-09-15 | DEFER | BUSINESS, OPERATIONS
**Decision:** Full subscription/billing automation is deferred; pilot schools handled manually via out-of-system arrangements.
**Why:** Phase 1–2 focus is financial truth; pricing integration is Phase 9.
**Benefit:** Keeps focus on correctness and pilot value.
**Risk:** Manual renewal tracking — acceptable for 1–10 schools; revisit before 20+ schools.
**Status:** Deferred; Organization.plan field included in schema for future use.

---

## ADR-style records will be added here for all consequential architectural choices as they are made.
