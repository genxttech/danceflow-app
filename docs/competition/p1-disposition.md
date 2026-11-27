# P1 composed run: disposition table

Generated from p1run6 with the results of the targeted rerun p1run7 laid over it (2026-11-27). Local only.

## Disposition of every failed suite and race (p1run6 overlaid with the targeted rerun p1run7)

(a) passes on B as the original; (b) passes on B only as a labelled copy (adapted copy, _with_s6 variant or AUTOSEED); (c) also fails on base; (d) on C the first refusal is a named pilot restriction: the guard is **untested** on C, not a pass, acceptable only when backed by (a) or (b); (e) unexplained or a defect. "not run" = a script that passed on C, so it was never run on B.

Counts: race B a = 2; race B b = 13; race B c = 4; race B e = 2; race B expected = 1; race C d UNBACKED = 3; race C d backed a = 1; race C d backed b = 11; race C d backed b (the with_s6 copy is the one for this chain) = 1; race C e = 4; race C pass (copy) = 2; suite B a = 16; suite B b = 22; suite B c = 3; suite B e = 3; suite B expected = 1; suite C d UNBACKED = 6; suite C d backed a = 13; suite C d backed b = 19; suite C e = 1; suite C pass (copy) = 6.

### SQL suites

| Name | A base | B corrections | C restriction | First refusal on B / C | Owner of (e) or unbacked |
|---|---|---|---|---|---|
| cf1_a0_tie_policy | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a1_helpers | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_FINAL_ONLY | R-15: source places an ineligible couple (refused by design); failing, unadapted; copy awaits go-ahead |
| cf1_a2_lock | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a3_results | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4_minimum_integration | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4a_target_guard | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| cf1_a5_exclusion | pass | b | d, backed b | B: passes as cf1_a5_exclusion_with_r15; C: COMP_P1_FINAL_ONLY |  |
| cf1_a5_exclusion_with_r15 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a5_u38_composed | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a6_withdrawal | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a7_od13 | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_callback_final_advancement | pass | b | d, backed b | B: passes as cf1_callback_final_advancement_with_r15; C: COMP_P1_FINAL_ONLY |  |
| cf1_callback_final_advancement_with_r15 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_f3_publication | pass | a | d, backed a | C: compp1_one_round_per_division |  |
| cf1_od17_enforcement | pass | b | e | C: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_OD17_REFUND_GATE | OD-31 (restriction chain) and R-15 |
| cf1_rb3_refund_evidence | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_FINAL_ONLY | R-15: source places an ineligible couple (refused by design); failing, unadapted; copy awaits go-ahead |
| cf1_rb3r_reconciliation | pass | b | pass (copy) | B: passes as cf1_rb3r_reconciliation_with_r15; C: COMPETITION CF1 RB3R SQL SUITE FAIL: RB3R F15 failed / canceled refunds only (reversed) ->; passes as cf1_rb3r_reconciliation_with_r15 |  |
| cf1_u66_recovery | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cx1_correction_readers | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| e2_ballots | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| e2_p1fix | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| f2_results | pass | b | d, backed b | C: compp1_one_round_per_division |  |
| hl1_heat_guards | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| jc1_inactive_judge_absent | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| k1_setup_fixes | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| ns1_no_show | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| o1_day_of | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| r10_s3_panel_readiness | - | a | pass (copy) | C: COMP_P1_CALLBACKS_OFF; passes as r10_s3_panel_readiness_p1pilot |  |
| r11_approval_override_scope | - | a | pass (copy) | C: COMP_P1_HEAT_NOT_STARTED; passes as r11_approval_override_scope_p1_pilot |  |
| r11_approval_override_scope_p1_pilot | - | expected | pass (copy) | B: R11 P1 pilot copy refused: the pilot restrictions are not installed; run the original suit; C: B not applicable: refuses without the restrictions |  |
| r2_entry_refunds | fail | a | d, backed a | C: compp1_one_heat_per_round |  |
| r2_refund_write_gate | pass | a | d, backed a | C: compp1_one_heat_per_round |  |
| s6_entry_status_guard | - | b | pass (copy) | C: COMP_P1_FINAL_ONLY; passes as s6_entry_status_guard_with_p1 |  |
| scoring_registry | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| ss1_round_lock | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| u18_heat_entry_status_guard | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit | pass | b | d, backed b | B: passes as _with_s6; C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit_with_s6 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| od31_guarded_baseline_negative | pass | e | d, UNBACKED | B: COMP_S6_ENTRY_STATUS_WRITER; C: COMP_P1_FINAL_ONLY; OD-31 written reason: only the C1/C3 characterization fails, on 877's change | OD-31 / 877 (expected behaviour change) |
| phase10a_competition_foundation | fail | c | d, UNBACKED | B: COMP_R15_ELIGIBILITY_WRITE_REFUSED (base fails differently: PHASE 10A SQL SUITE FAIL: manager applies the ballroom starter template => P0001 Competiti); AUTOSEED: COMP_R15_ELIGIBILITY_WRITE_REFUSED; C: compp1_one_heat_per_round; with R-15's copy only the two template checks fail, as on base | UNASSIGNED (base template defect) |
| phase10a_competition_foundation_with_r15 | - | c | d, UNBACKED | B: ADAPTED COPY R-15: PHASE 10A SQL SUITE FAIL: manager applies the ballroom starter template; C: compp1_one_heat_per_round; with R-15's copy only the two template checks fail, as on base; on B fails only the two template checks that fail on base (R-15) | UNASSIGNED (base template defect) |
| phase10b_competition_profiles | fail | c | d, UNBACKED | B: PHASE 10B SQL SUITE FAIL: the ballroom starter template still applies => P0001 Competition; C: COMP_P1_FINAL_ONLY | UNASSIGNED |
| phase10c5_competition_draft | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| phase10d1_heat_entry_eligibility | pass | a | pass (copy) | C: PHASE 10D.1 SQL SUITE FAIL: the rule lives in the existing 10D integrity function (no seco; passes as phase10d1_heat_entry_eligibility_with_p1 |  |
| phase10d_floor_schedule | pass | a | d, backed a | C: compp1_one_heat_per_round |  |

### Concurrency scripts

| Name | A base | B corrections | C restriction | First refusal on B / C | Owner of (e) or unbacked |
|---|---|---|---|---|---|
| cf1_a2_lock_vs_lifecycle | pass | b | d, backed b | C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| cf1_a3_locks | fail | c | e |  | UNASSIGNED |
| e2_marks_txn | pass | e | e | B: E2 MARKS-TXN FAIL:; fixture: chain v1 and v3 exist; later transaction cannot add a mark to; C: E2 MARKS-TXN FAIL:; fixture: chain v1 and v3 exist; later transaction cannot add a mark to | UNASSIGNED |
| e2_submit_vs_lock | fail | c | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_HL1_HEAT_NOT_DANCED; C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) | UNASSIGNED |
| f2_races | fail | c | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_RESULT_RECOMPUTE_UNSUPPORTED; C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) | UNASSIGNED |
| hl1_reopen_vs_lock_ballots | pass | b | d, backed b | C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| ns1_races | fail | c | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_BALLOT_UNKNOWN_ENTRY; C: COMP_P1_STARTED_HEAT (after AUTOSEED) | UNASSIGNED |
| cf1_a0_tie_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4_concurrency | pass | e | e |  | UNASSIGNED |
| cf1_a5_concurrency | pass | b | d, backed b | B: passes as cf1_a5_concurrency_with_s6_with_r15; C: COMP_P1_STRUCTURE_FROZEN |  |
| cf1_a5_concurrency_with_r15 | - | expected | d, backed b (the with_s6 copy is the one for this chain) | B: COMP_ENTRY_LIFECYCLE_PLACED; C: COMP_P1_STRUCTURE_FROZEN; expected on B: 877 changes P1/P2 (R-15) |  |
| cf1_a5_concurrency_with_s6 | - | b | d, backed b | B: passes as cf1_a5_concurrency_with_s6_with_r15; C: COMP_P1_STRUCTURE_FROZEN |  |
| cf1_a5_concurrency_with_s6_with_r15 | - | b | d, backed b | C: COMP_P1_STRUCTURE_FROZEN |  |
| cf1_a6_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a7_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_f3_concurrency | pass | a | d, backed a | C: COMP_P1_MINIMUM_COUPLES |  |
| cf1_od17_concurrency | pass | b | pass (copy) | C: COMP_R15_ENTRY_NOT_CLEARED |  |
| cf1_rb3r_concurrency | pass | b | pass (copy) | B: passes as cf1_rb3r_concurrency_with_r15; C: FAIL  C2b entry reason 'entry_determination_missing'; passes as cf1_rb3r_concurrency_with_r15 |  |
| cf1_u66_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| o1_concurrency | pass | a | e | C: COMPO1_BAD_STATE; OD-31 written reason: last race unreachable in the pilot (not verified here) | OD-31 (restriction chain only) |
| s6_entry_status_concurrency | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |

