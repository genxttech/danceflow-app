# P1 composed local run: record

**Local only**, one disposable database (PostgreSQL 17.6, image `cf1host:found`, no network). No hosted apply, merge or deploy. Run of record: 2026-11-27 06:04-08:16Z, runner `scripts/qa/p1/comp-p1-integrated-run.sh`, out dir `p1run4`. **P1 is not shown to be release-ready by this run.**

Heads (base fingerprint `d87e4285`): live `57c331910`, candidate `92a8c17c6`, 844 `b56ea086f`, 865 `d5c3bed52`, 864 `4d6d692cb`, 863 `a3319a824`, 866 `3b65f63d1`, 877 `f82e3b86f`, 899 `db5c9b876`, P1 `aff35ffa3`. 877 and 899 moves since earlier compositions were documentation or test-only.

Phases: A base chain; B base + 12 corrections; C B + restriction (919); D rollback; E re-apply.

## Summary

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

## Route replay rerun (2026-11-27 10:04-10:16Z, `scripts/qa/p1/comp-p1-replay-only.sh`)

Same composed migrations as the run above. Competition state built through application paths only (the superuser seeds identities and reads). Base chain A: **not yet obtained** (its replay in this job used a faulty registration step; a base-only job is queued).

| Route | B: corrections | C: corrections + restriction |
|---|---|---|
| NC (spare round, no cancel) | **REACHED** | closed at setup (`compp1_one_round_per_division`) |
| CS (cancel, then spare) | **REACHED** | closed at setup (same) |
| CA (cancel approved, then spare) | **REACHED** | closed at setup (same) |
| R (move the unrun published heat) | not reached: the move is refused, `COMPD_PUBLISHED_ORDER_WRITE_REFUSED` (899) | closed at setup (same) |

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

- Route replay on the base chain (A).
- Every guard whose suite or race stops at a restriction refusal or an 866 gate is **untested** on this composition until fixtures are adapted.
- The 919 suite (it failed in its own setup).
- The second-contest residual; application end-to-end workflow, production-build browser run and flag-off smoke (`p1-integrated-test-plan.md`).
