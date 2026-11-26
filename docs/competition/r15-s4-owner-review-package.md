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
| `test_T_phase10d1_*`, `test_T_competition_ns1_*`, `test_T_competition_cf1_f3_*`, `fixtures/competition_round_ready.sql` | Adapted: clearance seeding through the RPC (inert on a database without R-15 or without the fixture), adult dates of birth for the S5 guard, trigger allowlists |

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
- M1 suites would not pass: **partly fixed** in this PR (see the run3 triage below) (stub only when S5 absent, published-placement expectation, trigger count, clearance seeding in 10D.1 and NS1). **Not fixed: the other suites that seed `eligible`/`waived` and then publish, start, check in, lock or calculate (cf1_*, e2, f2, f3, o1, hl1, pv1, ...) are not adapted yet**; they need `select pg_temp.r15_clear_entries();` after their fixtures. PENDING.
- M2 S5 function trusted by name: **fixed** (owner must equal the owner of `_r15_age_state`); fixture carries a test-only warning.
- M3 app still shows uncleared entries as ready: **open** (app work, see dependencies).
- M4 weak waiver basis: waivers now refused for any declared sanctioning (including `other`); who counts as "authorized" (role, verified email, co-sign) is **open decision D-R15-4**.
- L1-L10: fixed L1 (disqualified not gated), L2 (ENABLE ALWAYS), L3 (rollback refusals), L4 (fingerprint is a jsonb array, covers dance role and entry creation time), L5 (null reason), L6 (replay must match), L9, L10; L7 (detail kept), L8 (TRIGGER revoke only on entries; other tables rely on clients not having CREATE) noted.

## Verification status

| Item | Status |
|---|---|
| SQL syntax and PL/pgSQL bodies of all 3 migrations, 3 rollbacks, new suite, fixture, 2 adapted suites | **Parsed OK** with libpg-query (syntax only) |
| New SQL suite and the adapted suites | **PENDING after the fixes below**: the integrated run3 (S5 session, 2026-11-24, PR head `4fc61fb2`) applied, rolled back and re-applied all 8 migrations without error; its suite failures are triaged below. The fixed suites have not been re-executed |
| Stages needing panel/ballot fixtures (round start, floor call via `advance_competition_floor_heat`, lock, calculate, approve, F3 publish, advancement apply, A5, A6) | **PENDING** in the integrated chain suite (they all call the now-strict P, proven in the new suite) |
| Existing competition suites after the change | run3 executed them; failures triaged below. Suites that stopped at their first error may hide further failures: **PENDING** until the next integrated run |
| CI | see the PR checks (record in the PR once green); CI does not run the SQL suites |
| Hosted apply | **not requested**; nothing applied to DEV or PROD |

## Integrated run3 triage (2026-11-24, evidence: `C:/dfr/s5int-out/run3/suite-forward-*.log`; each failure shows the FIRST error only)

| Suite (forward run) | First error | Cause | Verdict and fix | Owner |
|---|---|---|---|---|
| r15 eligibility clearance | `COMP_S5_AGE_BLOCKED (blocked_under_18)` | my fixtures plant minor/unknown participants, which the real S5 guard refuses | suite defect. Fixed: those rows are planted as pre-guard (legacy) data with the S5 participant trigger disabled for the seeding statements only, its refusal is asserted, and the "predicate absent" section hides a real S5 by rename | S4 (this PR) |
| ns1 no-show | `COMP_R15_ENTRY_NOT_CLEARED` stage `place`, reason `entry_determination_missing` (baseline/s5only: helper function missing, my defect) | eligible entries seeded with no determination are placed into published/running heats | **gate correct** (publishing or running order needs clearance). Fixed: authorized seeding through `set_competition_entry_eligibility`; the call is inert on databases without R-15; adult DOBs | S4 |
| phase 10D.1 | S5 `unknown_age` (s5only); baseline: helper missing and trigger count 5 vs 4, my defects | competitors seeded without DOB; my edit broke the baseline | Fixed: DOBs, conditional call, count that follows the installed triggers | S4 |
| cf1 F3 publication | `COMP_R15_ENTRY_NOT_CLEARED` `place` (s5only: S5 `unknown_age`) | same as ns1 | **gate correct**. Fixed: entrant participants seeded before placement, clearance through the RPC after both entry blocks, DOBs | S4 |
| cf1 A3 results, R-11 approval override | `COMP_R15_ENTRY_NOT_CLEARED` `place` | same | **gate correct**. Patch proposed to the owner (files are modified by PR 865) | S1/S2 session |
| U18, U18-S, JC1 | `COMP_R15_ENTRY_NOT_CLEARED` `place` | same: the guard tests place real couples in an active round | **gate correct** (placing into a running round is participation). Patch proposed (files not on this base) | CF1 U18 / JC1 owners |
| OD-31 negative | `COMP_R15_ENTRY_NOT_CLEARED` `place` | same | **gate correct**. Patch proposed (PR 856) | OD-31 session |
| o1, r2 refunds, r2 write gate, 10D floor, 10C registration | S5 `unknown_age` (also fail with S5 alone) | competitors without DOB | S5 effect, not R-15; may reveal R-15 `place`/publish refusals once DOBs are added (same remedy) | S5 session |
| e1 officials | `COMPO1_ROUND_EDGE draft -> active` (also in baseline) | pre-existing fixture/runner issue | not R-15 | runner owner |
| R-10 S3 panel readiness | its own assertions | S3 | not R-15 | S3 session |

No gate was weakened for any suite. Provisional planning in draft schedule versions was not blocked by any failure.

**Patch recipe for the proposed suites** (add the block after the suite has seeded its entries and its own participants, before the first heat placement; run with `fixtures/r15_clear_entries.sql` prepended):

```sql
do $r15$
begin
  if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then
    perform pg_temp.r15_clear_entries();
  end if;
end $r15$;
```

Insert points: A3 and R-11 before the `set session_replication_role = replica` that precedes the schedule version/heats; U18 between the entry insert and the heat-entry insert; U18-S the same and again before the later `e6` placement; JC1 before the replica block that places heat entries; OD-31 before each heat-entry insert that follows an entry insert. Suites that publish through `compo1_fixture_publish_rounds` are covered by the shared fixture when the clearance fixture is loaded. Runner: prepend `fixtures/r15_clear_entries.sql` (before `competition_round_ready.sql` or after; both are pg_temp definitions) for every suite on the forward and re-apply phases; it is harmless on the baseline.

## Integrated run4 (2026-11-26, S4 head `6b9f252f`; record `docs/competition/od02-s5-integrated-run.md` on `od02-s5-db-guard`; logs `C:/dfr/s5int-out/run4/`)

Executed on the composed chain: 8 of 8 migrations applied, rolled back in reverse release order and re-applied; the S5, R-11, R-10 S3, A3, PV-1, 10D.1 and 10C.4 suites passed composed. This supersedes the "not executed" statements about those items above.

| Finding in run4 | Verdict | Status after this revision |
|---|---|---|
| `_r15_required_criteria` raised `malformed array literal` (`v_req || 'age_division'` on `text[]`) for any entry in a division with an age, level or status criterion | **product defect in `20270301110000`**, missed by syntax parsing and by both reviews | fixed with `array_append`. The old body reproduces the error in the execution harness below; the fixed one passes |
| `r15_clear_entries` inserted a competitor without `studio_id`; under replica mode the filling guard does not fire (OD-31 suite) | fixture defect | fixed: `studio_id` given explicitly |
| cf1 F3 `COMP_R15_ENTRY_NOT_CLEARED` | the runner composed the unadapted F3 suite: its pull rule for PR 866 does not include `test_T_competition_cf1_f3_publication.sql` (the candidate and `website-embeds` copies are identical) | runner change requested from the S5 session |
| U18, U18-S, JC1 `COMP_R15_ENTRY_NOT_CLEARED` | gate correct; the suites seed no clearance. Their copies are carried by PR 867 (OD-31 session) | adapted copies, see below; released suites unchanged |
| E1, R2 refunds | fail on the base chain too | not R-15 |
| O1, R2 write gate, 10D floor, 10C (and NS1/F3 under S5 only) | missing dates of birth (S5) | S5 session |

### Execution of this revision

In-process PostgreSQL (PGlite) with **minimal stand-in tables**, not the composed chain: the three S4 migrations, the real S5 age functions and the fixture helper executed; 73 of 73 checks passed (every required-criteria branch, clearance reasons, every RPC outcome and refusal, write guard, placement, floor-state, publish, floor-call and round-start gates, the helper under replica mode, rollbacks in reverse order and re-apply). It does not exercise RLS, the real E2/O1/CF1 functions, lock, calculate, approve or F3 publication: those remain **PENDING** for the composed re-run.

### Regression coverage, the stand-in guard and why the defect was missed

**Why earlier checks missed it.** `v_req || 'age_division'` on a `text[]` is valid syntax. The check used until then (libpg-query) parses SQL and PL/pgSQL but resolves no types: an untyped literal after `||` makes PostgreSQL choose array-to-array concatenation and fail only when the expression runs. `CREATE FUNCTION` does not evaluate PL/pgSQL expressions, so the migration applied cleanly. Both independent reviews were by reading, and the suite that exercises the path had never been executed. Lesson: a syntax parse is not execution evidence; function behavior stays PENDING until run.

**Regression.** Suite section J covers every required-criteria and array path: null, blank and synonym labels (empty result), each single criterion (including status from a student or a professional participant), each combination, all three, labels with braces, quotes, backslash, comma, pipe, newline and non-ASCII text, an unknown entry (all three), delimiter-like labels not sharing a fingerprint, RPC criteria as NULL, empty, duplicated, superset, NULL element, unknown value, subset (the missing list is built), and a determination listing too few criteria. A static test also refuses a bare literal appended to a `text[]`. Section J runs 26 checks, passes in the harness below, and **fails against the `6b9f252f` migration with the original error**.

**S5 stand-in guard.** The fixture and the suite require the real `_comp_participant_age_clearance`. A marked stand-in is created only with `r15.allow_s5_standin = on`, never over an existing function; without it a chain lacking S5, or holding a leftover stand-in, fails with `R15-NO-REAL-S5`. The suite no longer renames or replaces the real function (its two predicate-absent probes run only on a chain without S5) and reports `S5 predicate: real` or `STAND-IN, not age-gate evidence` in its verdict. It does disable the S5 *participant trigger* for the statements that plant legacy under-18 / unknown-age rows, re-enables it, and asserts it is enabled again.

**Executed for this revision** (in-process PostgreSQL, stand-in tables, no heavy lock): the migration/behavior harness (73 of 73) and section J with the suite guard block and the fixture guard (40 of 40, of which section J is 26). Vitest static tests for the slice. **PENDING:** the composed run of every suite at this head.

**U18, U18-S, JC1.** Gate correct (couples seeded eligible with no determination are placed into a published order of an active round). Coordinator decision 2026-11-26: the released suites stay byte-identical to their pins; they run on R-15 chains only as labelled temporary adapted copies, built from src/lib/supabase/migrations/sql-tests/adapted/ (patch, blob hashes and runner rules). Originals run unpatched on the baseline chain.

## Integrated run5 (2026-11-26; S4 `cabc41b7`, 865 `aa9ec144`, 864 `cdac85fb`, 863 `d6315d85`, 877 `7341af1d`, 867 `6dc6b2d4`; logs `C:/dfr/s5int-out/run5/`)

Executed: apply, rollback and re-apply 8 of 8; the S5, R-11, R-10 S3 and R-15 suites (R-15: 106 checks, real S5 predicate), A3, PV-1, NS1, 10D.1, F3, 10C, 10C.4 passed composed; U18, U18-S, JC1 passed as ADAPTED COPIES only.

| run5 failure | Verdict | Change after run5 (not executed) |
|---|---|---|
| R2 refund write gate, R2 entry refunds: check-in refused | gate correct: couples had no determination | clearance seeded through the helper after the participants, on top of the S5 date-of-birth lines |
| 10D floor schedule: publish refused | gate correct: one couple is seeded `unverified` | the suite keeps planning it provisionally, now asserts publication is refused, then records the organizer decision through the RPC and publishes |
| O1 day of: `COMPO1_NOT_PUBLISHED` | cause not confirmed by the log; the publish before it needs clearance | clearance seeded; the shared publish helper now seeds under `supabase_admin` too (it only did under `postgres`, so it never ran in the runner: **fixture defect**) |
| E2 ballots: placement refused | gate correct | S3 added the block in PR 864 (head `a1b0eb9d`) |
| OD-31 negative: C2 | expected change (TRIGGER revoked) | `sql-tests/adapted/r15-od31-negative-c2.patch`; OD-31 keeps the released suite unchanged |

**Left after these changes (static review, not executed):** `r2_entry_refunds` still cannot pass: it also fails on the base chain alone at its direct heat activation (`COMPO1_HEAT_STATUS_WRITER`, the suite predates O1), so nothing after that statement has run on this chain. `e1_officials` is pre-existing. No guard was found to be wrong.

**Runner dependency (S5 owner):** `comp-s5-integrated-run.sh` takes `o1_day_of`, both R2 suites and `phase10d_floor_schedule` from PR 863. The final versions (S5 lines plus clearance) are in PR 866, so the forward phase must take those four from PR 866, keeping the S5-only phase on PR 863. A three-way merge of the four files showed no conflicts.

**Review of this change:** independent static review of the seeding commit: two findings (the runner dependency and the pre-existing R2 refunds failure above); no other problem found.

## Known gaps

App changes above; suites not yet adapted; D-R15-4 (authorization semantics), D-R15-5 (waiver categories), whether early ballot-mark refusal is wanted (lock-time refusal is mandatory and present); division label / participant edits during a running round make a determination stale (recoverable by re-determination, not frozen). The blocker stays OPEN until the integrated release candidate passes end-to-end verification (register entry `DFPOL-R15-ELIGIBILITY-ENFORCEMENT`).
