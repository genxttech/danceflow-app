# P1 composed local run: record

**Local only**, one disposable database (PostgreSQL 17.6, image `cf1host:found`, no network). No hosted apply, merge or deploy. Run of record: 2026-11-27 06:04-08:16Z, runner `scripts/qa/p1/comp-p1-integrated-run.sh`, out dir `p1run4`. **P1 is not shown to be release-ready by this run.**

Heads (base fingerprint `d87e4285`): live `57c331910`, candidate `92a8c17c6`, 844 `b56ea086f`, 865 `d5c3bed52`, 864 `4d6d692cb`, 863 `a3319a824`, 866 `3b65f63d1`, 877 `f82e3b86f`, 899 `db5c9b876`, P1 `aff35ffa3`. 877 and 899 moves since earlier compositions were documentation or test-only.

Phases: A base chain; B base + 12 corrections; C B + restriction (919); D rollback; E re-apply.

## Targeted rerun: p1run7 (2026-11-27 19:24-21:25Z)

Local only; no hosted apply, merge or deploy. **P1 is still not shown to be release-ready.**

Heads: base `57c33191`, 844 `ccc084057`, 865 `382a8850d`, 864 `23bd68d60`, 863 `f94bec831`, 866 `8f5d3d68a`, 877 `98ae57a29`, 899 `2754a4402`, 919 `6ef4e4e9f`, 926 `e851833d3` (test only), plus 20270223150000 from PR 888 `3d0e13cbd`. 899 `3dec13535` and 919 `f964facf1` change no SQL or test file. 0 composition warnings.

| Step | Result |
|---|---|
| Migrations | base 23/23, corrections 13/13 (incl. 20270223150000), restriction 1/1 |
| Rollback / re-apply | 14/14 and 14/14; catalog after rollback identical to base, after re-apply identical to C |
| Selected suites B (35) | 22 pass, 13 fail; AUTOSEED reruns 4 pass, 5 fail |
| Selected suites C (38) | 11 pass, 27 fail; AUTOSEED reruns 2 fail |
| Selected race scripts B (14) | 6 pass, 8 fail; AUTOSEED 4 pass, 2 fail |
| Selected race scripts C (14) | 3 pass, 11 fail; AUTOSEED 1 pass, 2 fail |
| Route replay | unchanged: A all four reached; B NC, CS, CA reached, R refused; C all closed at setup, later steps refused, second approval and publication accepted |

Not rerun (carried from p1run6): every suite and script outside the selection. 20270223150000's own suite was not run.

### Each correction's own suite on the restriction chain

| PR | Suite on C | Result |
|---|---|---|
| 844 | od04_event_delete_guard | pass |
| 865 | r11_approval_override_scope_p1_pilot (copy; 41 assertions dropped per its header) | pass; original stops at `COMP_P1_HEAT_NOT_STARTED` |
| 864 | r10_s3_panel_readiness_p1pilot (copy), e1_officials | pass; original stops at `COMP_P1_CALLBACKS_OFF` |
| 866 | r15_eligibility_clearance | pass |
| 863 | s5_participant_age_guard | pass |
| 877 | s6_entry_status_guard_with_p1 (copy) | pass (first execution); original stops at `COMP_P1_FINAL_ONLY` |
| 899 | d_published_order_write_guard, run_d_publish_race | pass |
| 919 | p1_pilot_restrictions | pass |

A copy's pass is not a pass of its original.

### R-15's seven copies against its stated expectations

All seven behaved as R-15 stated on B (a5_exclusion, with_s6 race, rb3r suite and race pass; callback passes only in the AUTOSEED rerun; the a5 race without S6 fails exactly P1 and P2; phase10a fails on the missing template) and on C (stops on restriction refusals); the two rb3r copies also pass on C.

### Still open

- `cf1_a1_helpers` (844's version, blob `5f5dd420`), `cf1_rb3_refund_evidence`: **still failing as the source suites, no adaptation**. `COMP_R15_ENTRY_NOT_CLEARED`, reason `entry_ineligible`, entry `…cf1a10008004` into heat `…cf1a1000d201`: the fixtures place an ineligible couple directly into a heat, which 866 refuses by design and its test fixture never clears (not a fixture defect, per R-15). Labelled copies await the coordinator's go-ahead (R-15).
- `cf1_od17_enforcement` on C: after AUTOSEED, checks S09 and M3d on the advancement-insert refund gate fail; no restriction code in the log (OD-31 reads it as the 866 clearance gate; not confirmed) (OD-31, R-15).
- `o1_concurrency` on C (OD-31 written reason, not verified) and `od31_guarded_baseline_negative` (OD-31 written reason; no copy).
- Unassigned: `cf1_a3_locks`, `e2_marks_txn`, `cf1_a4_concurrency`, `e2_submit_vs_lock`, `f2_races`, `ns1_races`, and the missing competition template behind `phase10a` / `phase10b`.
- Second-contest residual, application end-to-end workflow, production-build browser run and flag-off smoke.

## Run of record: p1run6 (2026-11-27 13:54-17:36Z)

Local only; no hosted apply, merge or deploy. Supersedes the two earlier runs below. **P1 is still not shown to be release-ready.**

Heads: base pinned at release line `57c33191` (the line moved to `42db332ae`, one CI workflow file), 844 `ccc084057`, 865 `d5c3bed52`, 864 `b94183a32`, 863 `59bcf8b00`, 866 `d40d1d2d9`, 877 `98ae57a29`, 899 `41cecd3e9` (standalone-unexecuted; superseded since), 919 `beecf8681`. Fingerprint `d87e4285`, 0 composition warnings.

| Step | Result |
|---|---|
| Migrations | base 23/23, corrections 12/12, restriction 1/1 |
| Rollback / re-apply | 13/13 and 13/13; **catalog after rollback identical to base** (the 3 earlier differences are gone); re-apply identical to C |
| Suites A (45) | 40 pass, 4 fail, 1 output only |
| Suites B (53) | 27 pass, 25 fail, 1 output only |
| B autoseed reruns (17) | 12 pass, 5 fail (AUTOSEED: cleared couples only, never a released pass) |
| Suites C (55) | 10 pass, 44 fail, 1 output only |
| Concurrency on C (24) | 4 pass, 20 fail; autoseed reruns on C 1 pass, 7 fail |
| Concurrency on B (re-runs of C failures) | 2 pass released, 9 pass AUTOSEED, 9 fail (4 of them fail on base too) |

C passes: checkin_balance, e1_officials, pv1_recompute, ss1_advancement_freeze, phase10c4, phase10c, phase10c_pricing_parity, od04_event_delete_guard, r15_eligibility_clearance, s5_participant_age_guard; races: od04, the two ss1 scripts and the 899 publish race.

### Route replay

| Route | A: base | B: corrections | C: + restriction |
|---|---|---|---|
| NC | **REACHED** | **REACHED** | closed at setup (`compp1_one_round_per_division`) |
| CS | **REACHED** | **REACHED** | closed at setup; cancel after start refused (`COMP_P1_STRUCTURE_FROZEN`) |
| CA | **REACHED** | **REACHED** | closed at setup; cancel refused (same) |
| R | **REACHED** | not reached: heat move refused (899) | closed at setup; cancel and new round refused (same) |

Later steps on a final no route touched:

| Step | A | B | C |
|---|---|---|---|
| Ballot before the heat starts | accepted | accepted | refused `COMP_P1_HEAT_NOT_STARTED` |
| Manager enters a paper ballot | accepted | accepted | refused `COMP_P1_PAPER_BALLOTS_OFF` |
| Calculator approves own first result | accepted | accepted | refused `COMP_P1_SECOND_APPROVER_REQUIRED` |
| Second manager approves, publish | not needed, published | not needed, published | both accepted |

The second-contest residual was not tested.

### Non-passing suites on B (25)

| Count | Suites | Cause and owner |
|---|---|---|
| 12 | cf1_a0, a2, a4_minimum, a5_u38, a6, a7, od17, u66, cx1, e2_p1fix, f2_results, hl1 | seed no clearance; **pass with AUTOSEED** |
| 3 | cf1_a1_helpers, cf1_a5_exclusion, cf1_rb3_refund_evidence | still `COMP_R15_ENTRY_NOT_CLEARED` with AUTOSEED (866: unplaced entries need `clear_all()`) |
| 1 | cf1_callback_final_advancement | AUTOSEED reaches `COMP_R15_PROVISIONAL_ASSIGNMENT` (866) |
| 1 | phase10a | writes eligibility directly (866 write guard; base also fails on a missing template) |
| 1 | cf1_rb3r_reconciliation | needs `clear_all()` per 866; not rerun |
| 3 | phase10d1, ns1_no_show, d_published_order_write_guard | 899 at `41cecd3e9`: its `aa_compd_lock_*` triggers fail the trigger-inventory checks, and its heat-move case meets another refusal; changed in `8e371bd56`, not run here |
| 2 | u18s original, od31 negative (adapted) | 877 changes the behaviour (expected; the `_with_s6` variant passes) |
| 2 | r2_entry_refunds, phase10b | fail on base |

### Non-passing on C (44)

38 stop on a restriction refusal in their fixtures, so those guards are **untested on C**. The other 6: `p1_pilot_restrictions` (919: its own rounds have no dance, calculation answers `multi_dance_unsupported`; later checks cascade and prove nothing); phase10d1 and its `_with_p1` copy and the 899 suite (899 triggers as above); od17 (`COMP_R15_ENTRY_NOT_CLEARED`; AUTOSEED then `COMP_OD17_REFUND_GATE`, not examined); rb3r.

### Concurrency not passing anywhere in B

cf1_a3_locks, e2_submit_vs_lock, f2_races, ns1_races (fail on base; with AUTOSEED the last three reach `COMP_HL1_HEAT_NOT_DANCED`, `COMP_RESULT_RECOMPUTE_UNSUPPORTED`, `COMP_BALLOT_UNKNOWN_ENTRY`); a5 and a5_with_s6 (still not cleared); rb3r (determination missing); e2_marks_txn and cf1_a4 (cause not confirmed). cf1_u66 failed on base in the previous run and passed this time: treat as unstable. o1 fails on C only (`COMPO1_BAD_STATE`, not examined).

## Targeted rerun plan (not queued)

Trigger: 899 reviewed head (`2754a4402` pushed; code `8e371bd56`; changes the 170000 migration, its rollback and its suite) plus migration 20270223150000 (PR 888 head `3d0e13cbd`, sorts after 844), and any 919 / 866 suite fixes pushed by then.

| Rerun on B and C | Why |
|---|---|
| apply, rollback, re-apply, catalog compare | both migrations |
| 899 suite, 899 publish race, Option D probe | changed guard |
| phase10d1 (+ _with_p1), ns1_no_show | trigger inventory |
| heat, heat-entry and running-order suites: 10d floor, o1 (+ race), hl1, jc1, u18, u18s_with_s6, s6 (+ race), r2 gate, cf1_a3, cf1_f3 (+ race) | lock triggers renamed, so firing order changes |
| route replay | route R and publication depend on 899 |
| p1_pilot_restrictions, listed 866 suites | only if their fixes are pushed |

Not affected by the 899 change (carried over from p1run6): suites that do not write heats, heat entries or running-order tables. Needs a suite/race filter in the runner (not yet built); expected 40-60 minutes on the lock (estimate).

## First composed run (p1run4, superseded)


| Step | Result |
|---|---|
| Migrations | base 23/23, corrections 12/12, restriction 1/1 applied |
| Suites A (45) | 40 pass, 4 fail, 1 output only |
| Suites B (53) | 26 pass (4 of them adapted copies), 26 fail, 1 output only |
| Suites C (54) | 8 pass, 45 fail (39 stop on a restriction refusal), 1 output only |
| Concurrency on C (24) | 3 pass, 21 fail |
| Rollback | 13/13 ran; **catalog differs from base in 3 objects** |
| Re-apply | 13/13; catalog identical to C |
| Route probe | A and B inconclusive; C closed at setup. **No control, so closure is not demonstrated** |

The runner did not add the `[ADAPTED COPY]` label in this run (fixed afterwards); the adapted cells below are marked from `adapted-copies.txt`. Phase E repeats the corrections' own suites on the C chain and shows no separate finding.

## Rollback differences (A vs D)

1. `change_competition_entry_lifecycle`: body differs (877, `20270301140000` rollback).
2. `record_competition_judge_attendance`: owner and grants differ (864, `20270301102000` rollback recreates it; the owner is the applying role, here `supabase_admin`).
3. `event_competition_entries`: `anon` and `authenticated` TRIGGER privilege not restored (866, `20270301131000` revokes it and no rollback in the chain grants it back to them).

## Route probe and Option D

- A, B: setup stops at calculation. The database engine answered `multi_dance_unsupported` because the probe built rounds without a dance (probe defect, changed afterwards to a one-dance couples category, **not yet executed**).
- C: all four routes stop when the spare round is added (`compp1_one_round_per_division`). Later route steps were not exercised.
- In A, B and C a direct move of a started published heat was refused (`COMPO1_HEAT_FROZEN`).
- Option D planted-heat probe: not reproduced on B (refused with `COMPD_PUBLISHED_ORDER_WRITE_REFUSED`); on C its fixture is refused by the restriction.
- OD-04 ordinary-event baseline output: identical A vs B and A vs C.

## Route replay rerun (2026-11-27, `scripts/qa/p1/comp-p1-replay-only.sh`: B and C 10:04-10:16Z, A 11:07-11:08Z, same probe)

Same composed migrations as the run above. Competition state built through application paths only (the superuser seeds identities and reads). 

| Route | A: base (control) | B: corrections | C: corrections + restriction |
|---|---|---|---|
| NC (spare round, no cancel) | **REACHED** | **REACHED** | closed at setup (`compp1_one_round_per_division`) |
| CS (cancel, then spare) | **REACHED** | **REACHED** | closed at setup (same) |
| CA (cancel approved, then spare) | **REACHED** | **REACHED** | closed at setup (same) |
| R (move the unrun published heat) | **REACHED** | not reached: the move is refused, `COMPD_PUBLISHED_ORDER_WRITE_REFUSED` (899) | closed at setup (same) |

- **A:** all four routes are reachable, and the manager could also approve their own corrected result directly. On B that direct approval is refused (`COMP_CORRECTION_APPROVER_REQUIRED`, 865) and so is the heat move (899), but NC, CS and CA remain.
- **B is a confirmed bypass with all corrections applied:** one manager entered the judges' paper ballots for the spare round, calculated, approved their own result with a reason and published it over the same couples, after (or without) a corrected round that a second manager had to approve. The spare rounds were added before judging.
- On C the routes stop when the spare round is added, so their later steps were not exercised there. Other ways round the restriction, including the second-contest residual, were not tested.
- On C the setup ran registration (12 adult couples), eligibility, panels, running-order publication, heats, judges' own ballots, calculation and second-manager approval; corrections were refused (`COMP_P1_CORRECTIONS_OFF`). Publication of those four results was not exercised.

## Suites

| Suite | A | B | C | First cause and owner |
|---|---|---|---|---|
| cf1_a0_tie_policy | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a1_helpers | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a2_lock | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a3_results | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a4_minimum_integration | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a4a_target_guard | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a5_exclusion | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a5_u38_composed | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a6_withdrawal | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_a7_od13 | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_callback_final_advancement | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_f3_publication | PASS | PASS | FAIL | C: restriction refuses the fixture `compp1_one_round_per_division` |
| cf1_od17_enforcement | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: also fails |
| cf1_rb3_refund_evidence | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| cf1_rb3r_reconciliation | PASS | FAIL | FAIL | B: COMPETITION CF1 RB3R SQL SUITE FAIL: RB3R F15 failed / canceled refunds only (reversed) -> available []; RB3R , not confirmed; race log points to a missing 866 determination. C: also fails |
| cf1_u66_recovery | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| checkin_balance | PASS | PASS | PASS |  |
| cx1_correction_readers | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| d_published_order_write_guard | - | FAIL | FAIL | B: `COMP_R15_PROVISIONAL_ASSIGNMENT`, 899 suite meets an 866 gate (no clearance seeded). C: restriction refuses the fixture `compp1_one_round_per_division` |
| e1_officials | FAIL | FAIL | FAIL | B: `COMP_S5_AGE_BLOCKED`, 864: its suite version has no adult date of birth under the S5 guard. C: also fails |
| e2_ballots | PASS | FAIL | FAIL | B: `COMP_EVENT_HAS_SCORING_EVIDENCE`, 844 guard refuses the suite's event-delete cascade (844 / 864 suite expectation). C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| e2_p1fix | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| f2_results | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `compp1_one_round_per_division` |
| hl1_heat_guards | PASS | FAIL | FAIL | B: `COMP_R15_ENTRY_NOT_CLEARED`, 866 gate: the suite seeds no clearance. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| jc1_inactive_judge_absent | PASS | PASS (adapted) | FAIL (adapted) | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| k1_setup_fixes | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| ns1_no_show | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| o1_day_of | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| od04_event_delete_guard | - | FAIL | FAIL | B: COMPETITION OD-04 SQL SUITE FAIL: 3 of 160 checks failed, 844: 3 of 160 checks, not examined. C: 10 of 150 checks fail, not examined |
| od04_ordinary_event_baseline | output | output | output |  |
| p1_pilot_restrictions | - | - | FAIL | C: suite defect, `role` text vs `app_role` (919); no check ran |
| pv1_recompute | PASS | PASS | PASS |  |
| r10_s3_panel_readiness | - | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_CALLBACKS_OFF` |
| r11_approval_override_scope | - | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_HEAT_NOT_STARTED` |
| r15_eligibility_clearance | - | PASS | PASS |  |
| r2_entry_refunds | FAIL | FAIL | FAIL | B: `COMPO1_HEAT_STATUS_WRITER`, fails on base too (assigned to the 864 session). C: restriction refuses the fixture `compp1_one_heat_per_round` |
| r2_refund_write_gate | PASS | PASS | FAIL | C: restriction refuses the fixture `compp1_one_heat_per_round` |
| s5_participant_age_guard | - | PASS | PASS |  |
| s6_entry_status_guard | - | PASS (adapted) | FAIL (adapted) | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| scoring_registry | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| ss1_advancement_freeze | PASS | PASS | PASS |  |
| ss1_round_lock | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| u18_heat_entry_status_guard | PASS | PASS (adapted) | FAIL (adapted) | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| u18s_heat_entry_scratch_audit | PASS | FAIL (adapted) | FAIL (adapted) | B: `COMP_S6_ENTRY_STATUS_WRITER`, 877 changes the behaviour; its `_with_s6` variant passes. C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| u18s_heat_entry_scratch_audit_with_s6 | - | PASS (adapted) | FAIL (adapted) | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| od31_guarded_baseline_negative | PASS | FAIL (adapted) | FAIL (adapted) | B: `COMP_S6_ENTRY_STATUS_WRITER`, 877 closes characterised finding C1 (OD-31 suite expectation). C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| phase10a_competition_foundation | FAIL | FAIL | FAIL | B: `COMP_R15_ELIGIBILITY_WRITE_REFUSED`, 866 write guard refuses its direct eligibility write (base also fails on a missing template). C: restriction refuses the fixture `compp1_one_heat_per_round` |
| phase10b_competition_profiles | FAIL | FAIL | FAIL | B: PHASE 10B SQL SUITE FAIL: the ballroom starter template still applies => P0001 Competition template not found., fails on base too (cause not examined). C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| phase10c4_participant_roles | PASS | PASS | PASS |  |
| phase10c5_competition_draft | PASS | PASS | FAIL | C: restriction refuses the fixture `COMP_P1_FINAL_ONLY` |
| phase10c_competitor_registration | PASS | PASS | PASS |  |
| phase10c_pricing_parity | PASS | PASS | PASS |  |
| phase10d1_heat_entry_eligibility | PASS | PASS | FAIL | C only: static check 'no second validator' fails (919) |
| phase10d_floor_schedule | PASS | PASS | FAIL | C: restriction refuses the fixture `compp1_one_heat_per_round` |

A failures: `e1_officials` (`COMPO1_ROUND_EDGE`), `r2_entry_refunds` (`COMPO1_HEAT_STATUS_WRITER`), `phase10a` and `phase10b` ("Competition template not found").

## Concurrency (C; failures re-run on B and A)

| Script | A | B | C | Note |
|---|---|---|---|---|
| run_cf1_a2_lock_vs_lifecycle | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| run_cf1_a3_locks | FAIL | FAIL | FAIL | fails on base too |
| run_d_publish_race | - | FAIL | FAIL | B: R2 refused without waiting for the publication (899 check); C: restriction index in fixture |
| run_e2_marks_txn | PASS | FAIL | FAIL | B: fixture step fails; cause not confirmed |
| run_e2_submit_vs_lock | FAIL | FAIL | FAIL | fails on base too |
| run_f2_races | FAIL | FAIL | FAIL | fails on base too |
| run_hl1_reopen_vs_lock_ballots | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| run_ns1_races | FAIL | FAIL | FAIL | fails on base too |
| run_od04_race | - | - | PASS |  |
| run_ss1_advancement_vs_publish | - | - | PASS |  |
| run_ss1_configure_vs_publish | - | - | PASS |  |
| cf1_a0_tie_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_a4_concurrency | PASS | FAIL | FAIL | B and C cause not examined |
| cf1_a5_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_a5_concurrency_with_s6 | - | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_a6_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_a7_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_f3_concurrency | PASS | PASS | FAIL | C only: `COMP_P1_MINIMUM_COUPLES` |
| cf1_od17_concurrency | PASS | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |
| cf1_rb3r_concurrency | PASS | FAIL | FAIL | entry reason `entry_determination_missing` (866) |
| cf1_u66_concurrency | FAIL | FAIL | FAIL | fails on base too |
| o1_concurrency | PASS | PASS | FAIL | C only; first cause not confirmed |
| s6_entry_status_concurrency | - | FAIL | FAIL | B: 866 gate, no clearance seeded; C fails too |

## Pending

- Every guard whose suite or race stops at a restriction refusal or an 866 gate is **untested** on this composition until fixtures are adapted.
- The 919 suite (it failed in its own setup).
- The second-contest residual; application end-to-end workflow, production-build browser run and flag-off smoke (`p1-integrated-test-plan.md`).
