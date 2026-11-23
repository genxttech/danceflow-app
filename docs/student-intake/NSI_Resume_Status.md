# NSI resume status (milestone N0), 2026-11-23

Base: `origin/main` ec0be82aa. Branch `nsi/n0-preserve`, draft PR 808. Dark, Git-only. Nothing here was applied to PROD; no flag, env, Gate A or intake email was touched.

## 1. What exists and how verified

| Area | State | Evidence |
|---|---|---|
| Migrations M1-M9 (`20261118090000`..`20261118098000`) + rollbacks | **Applied to shared DEV** (M1-M5 2026-10-14, M6-M9 later); in Git only as of PR 808 | Files byte-identical to DEV-applied SHA-256 prefixes: M1 2b1f924d, M2 3712c5ca, M3 43fcd0a7, M4 795e0fb3, M5 50bc7a4f, M6 62e2f4de, M7 41b3b5ef, M8 7d297f5a, M9 367be6bf (re-checked 2026-11-23 on the copy in this branch) |
| SQL suites + concurrency harnesses (`sql-tests/`) | Local-only validation (disposable Postgres 17 image); DEV-safe subset ran on DEV | Counts in `NSI_I2_M7_M9_Notes.md` (I1 foundation 97/303, I2 92, M7 34, M8 43, M9 17). **Not re-run on current main in N0.** |
| `src/lib/intake`, `settings/student-intake` UI, settings link | Code on branch; behind an explicit per-studio allowlist in `access.ts`; link hidden unless allowlisted | Unit tests exist; **typecheck/tests against current main not yet run in N0** (see section 6) |
| Rehearsal evidence (`rehearsal/`) | In Git, scanned for credentials (none: only env-variable names and local container defaults) | |

DEV drift check, read-only via `sb.sh dev-read`, 2026-11-23 11:37Z:
- NSI catalog fingerprint `534c5e93300ef25b5fa8496fb472d48f`, 670 parts: **matches**.
- `appointments` structural fingerprint `e0c4db1b4d1b027df0e6e1593d0f14ce`: **matches** (also identical on PROD).
- `intake_private.retention_gate_open()` = **false** (Gate A closed). Total rows across all `intake_*` tables = **0**. 19 intake tables (I1 18 + M7 grants).
- PROD (`prod-read`): 0 `intake_*` relations, no `intake_private` schema. Untouched, as expected.

## 2. Migration ordering finding (Task 2)

- **Neither hosted DB uses a migration registry for these files.** DEV's `supabase_migrations.schema_migrations` holds exactly one row (`20261014090519`) and no NSI rows; PROD has no `supabase_migrations` schema at all. Everything is applied by file through `sb.sh` with an explicit SHA-256. So there is no version-row mismatch to repair on either database, and nothing to "register".
- Main's migration folder has 477 SQL files; the latest is `20270222094000`. NSI files carry `20261118...` stamps, about 3 months behind the tip. They sort in the middle of the Nov-2026 files. A fresh replay in filename order therefore runs M1-M9 before the Dec 2026 to Feb 2027 files.
- That is only a problem if a later-stamped file alters an object NSI depends on. NSI touches `appointments` (read), clients, studios, studio roles and billing-free tables. Grep of post-2026-10-14 files shows only the GC-series group-class files (`20261016`..`20261026`) touch appointments, and they sort **before** NSI. The `appointments` structural fingerprint is the same on DEV and PROD (both include those), so NSI's assumptions hold.
- **Recommendation:** keep the `20261118...` names. Do not renumber (DEV-applied hashes and rollback exact-fingerprint checks are tied to these names and bytes). For PROD apply, use the same file-plus-SHA path, in order M1..M9 (and later NSI files above `20261118098000`), after a full-chain disposable replay of main's folder with NSI included, which has **not** been run yet. New NSI files continue the series (`20261118099000`+). Risk to log: if a future tool applies by version number (`supabase db push`), the sparse registry would try to apply everything below the max; that path is not used for these databases today.

## 3. Blocker refresh against current main (Task 4)

| Item | Status on main today | Release blocker? |
|---|---|---|
| `intake_ensure_request` alignment (first-appointment rule, `enabled_at` watermark, 10-minute settle delay) | **Still open.** M8 body (`nsi-body:m8`) does not call `evaluate_appointment_eligibility`. Slice 6 below fixes it locally (migration M10, not applied) | **Yes, before Gate A** |
| P1-2 simulation/preview performance on large studios | Open (needs single-pass history scan) | Yes for pilot, not for DEV |
| P2-3 lapsed grant renewal back-fills bookings made during the lapse | Open, product decision | Decision needed before pilot |
| P2-4 `intake_designate_guardian` not entitlement-gated before Gate A | Open | Before Gate A |
| I2-A UI uses `intake_set_service_assignment` | **Still open**: `settings/student-intake/actions.ts:68` calls the old RPC; the M8 `intake_set_service_type` (enable flag + template) is unused by the UI | Yes for config UI correctness |
| Pricing / billing entitlement | **Not applicable (owner correction 2026-11-23)**: Student Intake is not separately priced. Audited: no `student_intake` BillingFeature, plan entry, billing key, `requiredStudioPlanForFeature` use or Stripe product exists in code or SQL; nothing can block authorized access on billing grounds. M7 pilot grants (DB) are a rollout control only; the UI uses an env allowlist until it reads the grants | No |
| T1 timezone consistency | No dedicated T1 work found on main (timezone fixes exist for other surfaces; staff API exposes `timeZone`). Treat as open | Blocks reminders/invites (I4), not config UI |
| T2 dispatcher reliability | **Merged** (#220): `dispatch.ts` skips every `intake_*` key until an intake renderer exists | Closed |
| T3 branded intake templates/renderers/previews | **Not started** (no intake renderer on main) | Blocks any intake email |
| T4 shared outbox SQL (claim-by-ID etc.) | **Not started; must wait** for M-0 close-out + rollback-window expiry | Blocks queued intake email |
| M-0 close-out | **Open**: PROD S3 and frozen; closeout runbook (#758/#763) prepared 2026-11-21; unfreeze gated on webhook decision, sender-domain check and owner go; #762 stage-2 precondition defect needs a live-line release | **Yes: no intake email anywhere until closed** |
| I3 Part A (A1-A11) | All open (invitations, sessions, guardian verification, minor service path, decline, version pinning, role auth, N1, shared outbox A10, dependencies A11) | Part A blocks I3 code/SQL authorization |
| I3 Part B (B1-B8) | All open (B1 platform retention policy approval; B2 minor-default removal; B3 N4 repeated erasure; B4 test tightening; B5 DB entitlement for Gate B; B6 A3/A5 live; B7 PROD prerequisites; B8 owner/legal retention decisions) | Block opening Gate A |

## 4. Remaining work by capability

| Capability | Done | Remaining |
|---|---|---|
| Studio config UI | Template builder, service assignment, preview (I2) | Switch UI to `intake_set_service_type`; entitlement decision; typecheck/test on main; staff-visible readiness |
| First-appointment eligibility | Evaluator + preview + simulation (M6/M8) | `ensure_request` through evaluator (M10, in progress); perf P1-2; reconciler job (I4) |
| Student/guardian completion | Write RPCs for drafts/submit/answers (I1) | Account-free sessions, guardian verification, minor path, decline (I3 Part A) |
| Automated invitations | Nothing | Invitation tables, tokens, outbox integration (A1, A10); T3, T4; M-0 close-out |
| Reminders | Nothing | T1; SMS waits for TW-4; I4 |
| Staff review | Status/answers read RPCs | Review UI, delivery visibility, role rules (A8) |

## 5. Dependency table: genuine release blockers vs not

| Dependency | Blocks | Genuine blocker? |
|---|---|---|
| M-0 close-out + rollback-window expiry | Any queued/sent intake email, T4 | **Yes** (spec 22.6) |
| ensure_request alignment | Gate A | **Yes** |
| I3 Part B (B1-B8) | Gate A / collection | **Yes** |
| Owner/legal retention and minors decisions (B8, B1) | Gate A | **Yes** (owner) |
| T3 renderers, T4 SQL, `INTAKE_ROOT_SECRET` | Invitations (I4) | Yes for email, no for I3 DB work |
| T1 timezone | Reminders | Yes for reminders only |
| TW-4 | SMS reminders | Yes for SMS only |
| Pricing / BillingFeature | Nothing (no separate pricing exists) | **No** |
| P2-3 product decision | Pilot grant renewals | Decision, not code |
| UI switch to `intake_set_service_type` | Config UI correctness | Not for DB gates |
| Migration ordering/renumbering | Nothing | **No** (see section 2) |
| Typecheck/tests on main | PR merge | Required by CI, not a design blocker |

## 6. Not yet done in N0 (stated plainly)

- `src/lib/intake` and the settings UI have not been typechecked or unit-tested against current main (no `node_modules` in this worktree; CI on PR 808 will report).
- Full-chain disposable replay of main's migration folder including NSI not run.
- Slice 6 (M10): see `NSI_I2_M10_Notes.md` once written; **not applied to DEV**; independent review required first.

## 7. Update 2026-11-23 (later): M10 on DEV, M11 in progress, owner decision for Gate A

- **M10 applied to shared DEV** (file sha256 `9fdd4a63b629…`, fingerprint `c6b3d46b…|670`, DEV-safe suite 97/97, Gate A closed, 0 rows): `rehearsal/d6_dev_m10/D6_report_2026-11-23.md`. The P1 blocker "ensure_request does not call the evaluator" is **closed on DEV**; it remains a PROD item only because PROD has no NSI objects yet.
- **M11:** P2-2 detached link reported as `detached_from_request` (write attempt gone; preview omits linked appointments), P2-3 anchor recomputed to the earliest live attached appointment, P2-5 corrected READ COMMITTED comment, explicit M10/M9 precondition. Validation evidence is added under `rehearsal/` once the lifecycle run is recorded; it needs a review pass before any DEV apply.
- **No separate pricing** (owner correction): nothing in this document treats pricing or a billing entitlement as a blocker.

### Owner decision needed before Gate A (P2-1): who counts as an "existing student"?

Today the evaluator treats a client as an existing student, and so never asks for intake automatically, when they have **any earlier appointment** in the studio (as client or as partner) of type private, intro or coaching with status scheduled, rescheduled, confirmed, attended or no_show, **regardless** of: (a) whether that appointment was imported from another system, (b) whether its lesson type is ticked for intake, (c) whether the earlier appointments used a different intake form (template). The effect: a person who is genuinely new to this studio's intake can be silently skipped, for example someone whose only earlier lesson was an imported record, a lesson type the studio does not use for intake, or a lesson where they were only the partner. Staff can still request intake manually, but nobody is told the student was skipped.

| Option | Behaviour | Cost |
|---|---|---|
| A (recommended for V1) | Keep the conservative rule (any prior qualifying lesson means existing student). Add a staff-visible "existing student, not asked" list with a one-click manual request, so nobody is silently stranded. | Small: a read RPC and UI. No rule change, no migration to the evaluator. |
| B | Count only history that would itself have asked for intake (selected types and the same form); treat imported history as not counting. | Larger: evaluator change, simulation and preview change, more edge cases (a lesson type deselected later changes who counts). Risk of asking real existing students for forms. |
| C | Count only appointments created on or after the studio's `enabled_at`. | Simple, but then every studio's whole existing roster is treated as new the first time they book after enablement. Unacceptable. |

Recommendation: A for V1, revisit B after the pilot data (the simulation RPC already shows who would be skipped). This does not block Gate A work, but the decision (and the staff list if A) must exist before collection opens.
