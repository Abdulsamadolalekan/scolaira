# Evidence archive — release-gate closure, 2026-10-09

The working documents of the Phase 0–2 transformation and the verification logs behind every figure
they state. These are copies of files that lived in the workspace root (`/home/user/…`); they are
archived here so the evidence travels with the code it describes rather than existing only on one
machine.

| File | What it is |
| --- | --- |
| `SCOLAIRA_10_10_TRANSFORMATION_REPORT.md` | The whole transformation record. §3.10 is the recovery-and-verification pass, §3.11 the release-gate closure, §3.12 the push that made this archive possible. |
| `SCOLAIRA_PHASE1_ONBOARDING_EVIDENCE.md` | Phase 1 evidence, ending with the two closure addenda (re-verification, then the re-contracted E2E assertions). |
| `SCOLAIRA_RELEASE_GATE_CLOSURE_REPORT.md` | The closure report: verdicts, the exact final numbers, what changed, what was excluded, and the recovery-point record in §8. |
| `logs/GATE_E2E_CLOSURE.log`, `logs/GATE_E2E.log` | The Playwright release gate as it ran before the closure of the two stale specs (82 passed / 4 failed) and after it (86 passed / 0 failed). |
| `logs/GATE_E2E_PUSHED.log` | The release gate re-run on the committed tree: `86 passed (2.2m)`, chromium and webkit, built artifact over the suite TLS front end. |
| `logs/GATE_DESIGN*.log` | The design-system/accessibility gate, including the five failed attempts that established the root cause (production preview policy in one mode, an OOM-killed dev server in the other) and the two passing runs after the runner was made adequate. |
| `logs/PUSH_VERIFY_VITEST.log` | `npx vitest run` on the committed tree: 65 files, 909 passed / 0 failed. |
| `logs/recovery-20261009*.log` | The three environment-recovery attempts, stage by stage — the reason some mid-session measurements had to be repeated. |

No secret appears in any file here: the reports and logs were scanned for credential shapes
(`DATABASE_URL` with a password, session secrets, private-key blocks) before archiving, and the
scan returned nothing. The seeded E2E role passwords that the repository already documents in
`scripts/bootstrap-roles.sql` are the only local-credential strings anywhere in it.
