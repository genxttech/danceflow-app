# S4 (R-15 eligibility enforcement): owner review package

Status: **DRAFT, migrations NOT applied anywhere, tests NOT executed.** Approval requested: **review and merge of the DRAFT PR into `release/website-embeds`** (code only). Hosted apply (DEV or PROD) is **not requested**. Policy: R-15 (2026-11-24), DanceFlow Studio/Custom policy, not a governing-body rule. OD-01, OD-02, OD-03, OD-18 preserved. POLICY RATIFIED; IMPLEMENTATION NOT VERIFIED.

Design and path investigation: PR 862 (`docs/competition/r15-eligibility-enforcement-design.md`). This PR implements it.

## What is in the PR

| File | Purpose |
|---|---|
| `20270301110000_..._r15_eligibility_clearance_core.sql` | Additive: append-only `event_competition_eligibility_determinations`; `_r15_entry_availability_reason` (old predicate P, byte-for-byte RB3); `_r15_age_state` (bridge to S5, fails closed); fingerprint, required criteria, `_r15_entry_clearance_reason`, `_r15_entry_executable_reason`, `competition_entry_clearance_state`; RPC `set_competition_entry_eligibility` (actor, role, time, reason, criteria, server fingerprint, request-id replay). No behavior change by itself |
| `20270301130000_..._r15_executable_gates.sql` | `_cf1_entry_unavailable_reason` becomes `coalesce(old P, clearance)`, which strictens every existing caller at once; OD-17 M2 placement patched to stay lenient; new unconditional triggers: round start, floor call, schedule-version publish/live (INSERT and UPDATE), heat-entry placement context and floor states |
| `20270301131000_..._r15_eligibility_write_guard.sql` | AFTER trigger refusing client writes of `eligibility_status` / `metadata.eligibility_determination` and client INSERT of anything but `unverified`; TRIGGER privilege revoked from clients on entries |
| `rollback/...` x3 | Reverse order 131000, 130000, 110000; the core rollback refuses while determinations exist or while the gates are installed |
| `sql-tests/test_T_competition_r15_eligibility_clearance.sql`, `fixtures/r15_clear_entries.sql` | New suite (about 85 checks) and a fixture helper that seeds clearance for suites that seed `eligible`/`waived` directly |
| `test_T_phase10d1_*`, `test_T_competition_ns1_*` | Adapted: trigger-name allowlists and clearance seeding |

## Behavior after apply (provisional vs executable)

- **Provisional planning allowed**: unverified / needs_review entries can be placed in draft or review schedule versions; they are shown as not cleared by `competition_entry_clearance_state`.
- **Not executable**: cannot be placed in running/published context, cannot be checked in or marked danced, cannot publish a running order, start a round, take a floor call, be locked into ballots, calculated, approved, published, advanced, or reinstated.
- `ineligible`, refunded, cancelled, not-confirmed stay blocked as before. Withdrawal, scratch, no-show, registration are not gated. A5 organizer exclusion now also accepts a not-cleared couple (reason kind `other`), which removes the lock/calculate freeze.
- `waived` clears only with an event-policy category (documents, fee, scheduling), only on a division with no age/status/level criterion, only when the event declares **no** sanctioning, and never when the age state is not `allowed`.
- Existing rows: **no DML anywhere**. Existing `eligible`/`waived` rows without a determination are provisional until re-determined through the RPC. Hosted DEV and PROD held **0** competition entries on 2026-11-24; the 130000 preflight prints counts of provisional placements by round status and in published/live versions and refuses only for OD-17-enforced events.

## Dependencies and ordering

1. **Timestamp order equals release order** (coordinator decision): 20270301090000 S1/S2, 20270301100000-102000 S3, **20270301110000 S4 core**, **20270301120000 S5 age predicate (PR 863)**, **20270301130000 S4 gates**, **20270301131000 S4 write guard**. The gates preflight requires S5 and refuses otherwise (without S5 no entry can be age-cleared and the strict gates would freeze Competition).
2. **Rollback order is the reverse of release order**: S4 guard 131000, S4 gates 130000, S5 120000, then S4 core 110000. Rolling back S5 while the gates are installed would freeze Competition (the gates reach S5 through `_r15_age_state`, which fails closed when S5 is absent); the core rollback refuses while the gates are installed, and a static test (`src/lib/competition/__tests__/r15MigrationOrder.test.ts`) pins the slot order and the refusals. S4 alone, without S5, gives age state 'unknown' (nothing cleared): fail closed. No migration ships an S5 stub; the stand-in lives only inside the SQL suite and fixture.
3. App dependencies NOT in this PR: `registrations/actions.ts` must call `set_competition_entry_eligibility` (the direct update is refused after 131000); readiness/check-in counts still read raw `eligible`/`waived` and should use `competition_entry_clearance_state`; PR 837/846 planner gates should become "plannable provisional, not publishable"; UI mapping of `COMP_R15_*` errors. e2e seeds that write `eligible` through the service role break after 131000 and must use the RPC.

## Cross-PR agreement (names, owners, objects redefined)

| PR | Slot | Defines / redefines | Overlap with S4 |
|---|---|---|---|
| S4 (this) | 20270301110000-131000 | defines `_r15_*`, `competition_entry_clearance_state`, `set_competition_entry_eligibility`, determinations table, 5 triggers; REDEFINES `_cf1_entry_unavailable_reason` (CREATE OR REPLACE) and patches `cf1_od17_guard_heat_entry` (one fragment) | none below |
| S5, PR 863 | 20270301120000 (runs between S4 core and S4 gates) | defines `_comp_age_clearance_from_dob`, `_comp_participant_age_clearance(uuid)` (`allowed`/`blocked_under_18`/`unknown_age`), triggers on entry participants and competitors; REDEFINES `_comp10c_resolve_competitor` | S4 only CALLS `_comp_participant_age_clearance`, through a guarded owner-checked wrapper (agreed by message) |
| S3, PR 864 | 20270301100000-102000 | REDEFINES `competition_round_panel_status`, `record_competition_judge_attendance`; trigger on rounds `UPDATE OF configuration, scoring_method, minimum_panel_size`; new panel recovery table | none: different trigger columns, does not call `_r15_*`, does not touch `_cf1_round_roster_problems` / `_cf1_require_roster_eligible` (S3 confirmed) |
| S1/S2, PR 865 | 20270301090000 | pin-replaces `approve_competition_round_result` | none (A3 approve still calls `_cf1_require_roster_eligible`, which now sees strict P) |

## Independent security review (fresh agent, adversarial, did not see the design conclusions)

Reported 2 high, 4 medium, 10 low. Dispositions:

- H1 freeze if gates apply before S5: **fixed** by a hard preflight and by renumbering the gates/guard after S5 (D-R15-1 resolved by the coordinator).
- H2 callback correction / A6 withdrawal / reinstatement now refuse provisional couples and can dead-end: **documented, accepted behavior with the recovery route** (re-determine through the RPC; A5 exclusion for danced couples; S5 required first). The correction guard and A6 minimum count are intentionally strict.
- M1 suites would not pass: **fixed** the ones in this PR (stub only when S5 absent, published-placement expectation, trigger count, clearance seeding in 10D.1 and NS1). **Not fixed: the other suites that seed `eligible`/`waived` and then publish, start, check in, lock or calculate (cf1_*, e2, f2, f3, o1, hl1, pv1, ...) are not adapted yet**; they need `select pg_temp.r15_clear_entries();` after their fixtures. PENDING.
- M2 S5 function trusted by name: **fixed** (owner must equal the owner of `_r15_age_state`); fixture carries a test-only warning.
- M3 app still shows uncleared entries as ready: **open** (app work, see dependencies).
- M4 weak waiver basis: waivers now refused for any declared sanctioning (including `other`); who counts as "authorized" (role, verified email, co-sign) is **open decision D-R15-4**.
- L1-L10: fixed L1 (disqualified not gated), L2 (ENABLE ALWAYS), L3 (rollback refusals), L4 (fingerprint is a jsonb array, covers dance role and entry creation time), L5 (null reason), L6 (replay must match), L9, L10; L7 (detail kept), L8 (TRIGGER revoke only on entries; other tables rely on clients not having CREATE) noted.

## Verification status

| Item | Status |
|---|---|
| SQL syntax and PL/pgSQL bodies of all 3 migrations, 3 rollbacks, new suite, fixture, 2 adapted suites | **Parsed OK** with libpg-query (syntax only) |
| New SQL suite and the adapted 10D.1/NS1 suites | **PENDING**: not executed (no local Postgres run; heavy-lock queue not entered; share the OD-31 / R-12 slot when run) |
| Stages needing panel/ballot fixtures (round start, floor call via `advance_competition_floor_heat`, lock, calculate, approve, F3 publish, advancement apply, A5, A6) | **PENDING** in the integrated chain suite (they all call the now-strict P, proven in the new suite) |
| Existing competition suites after the change | **NOT run**; many need the clearance fixture (see M1) |
| CI | see the PR checks (record in the PR once green); CI does not run the SQL suites |
| Hosted apply | **not requested**; nothing applied to DEV or PROD |

## Known gaps

App changes above; suites not yet adapted; D-R15-4 (authorization semantics), D-R15-5 (waiver categories), whether early ballot-mark refusal is wanted (lock-time refusal is mandatory and present); division label / participant edits during a running round make a determination stale (recoverable by re-determination, not frozen). The blocker stays OPEN until the integrated release candidate passes end-to-end verification (register entry `DFPOL-R15-ELIGIBILITY-ENFORCEMENT`).
