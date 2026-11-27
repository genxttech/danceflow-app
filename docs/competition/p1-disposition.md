# P1 composed run: disposition table

Generated from run p1run6 (2026-11-27). Local only.

## Disposition of every failed suite and race (p1run6)

(a) passes on B as the original; (b) passes on B only as a labelled copy (adapted copy, _with_s6 variant or AUTOSEED); (c) also fails on base; (d) on C the first refusal is a named pilot restriction: the guard is **untested** on C, not a pass, acceptable only when backed by (a) or (b); (e) unexplained or a defect. "not run" = a script that passed on C, so it was never run on B.

Counts: race B a = 2; race B b = 9; race B c = 4; race B e = 5; race C d UNBACKED = 5; race C d backed a = 1; race C d backed b = 8; race C e = 5; race C pass (copy) = 1; suite B - = 2; suite B a = 14; suite B b = 17; suite B c = 2; suite B e = 10; suite C d UNBACKED = 9; suite C d backed a = 13; suite C d backed b = 16; suite C e = 6; suite C pass = 1.

### SQL suites

| Name | A base | B corrections | C restriction | First refusal on B / C | Owner of (e) or unbacked |
|---|---|---|---|---|---|
| cf1_a0_tie_policy | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a1_helpers | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_FINAL_ONLY | R-15 (new fixture 5577708b, rerun) |
| cf1_a2_lock | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a3_results | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4_minimum_integration | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4a_target_guard | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| cf1_a5_exclusion | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_FINAL_ONLY | R-15 (labelled copy requested) |
| cf1_a5_u38_composed | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a6_withdrawal | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a7_od13 | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_callback_final_advancement | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_PROVISIONAL_ASSIGNMENT; C: COMP_P1_FINAL_ONLY | R-15 (labelled copy requested) |
| cf1_f3_publication | pass | a | d, backed a | C: compp1_one_round_per_division |  |
| cf1_od17_enforcement | pass | b | e | C: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_OD17_REFUND_GATE | OD-31 (restriction chain) and R-15 |
| cf1_rb3_refund_evidence | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_FINAL_ONLY | R-15 (new fixture 5577708b, rerun) |
| cf1_rb3r_reconciliation | pass | e | e | B: COMPETITION CF1 RB3R SQL SUITE FAIL: RB3R F15 failed / canceled refunds only (reversed) ->; C: COMPETITION CF1 RB3R SQL SUITE FAIL: RB3R F15 failed / canceled refunds only (reversed) -> | R-15 (labelled copy requested) |
| cf1_u66_recovery | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cx1_correction_readers | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| d_published_order_write_guard | - | e | e | B: COMPETITION D SQL SUITE FAIL: D: move a never-run published heat to another round [Heats m; C: COMPETITION D SQL SUITE FAIL: D: move a never-run published heat to another round [Heats m | R-11 / 899 (fix 2754a440 pushed, rerun) |
| e1_officials | fail | a | pass |  |  |
| e2_ballots | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| e2_p1fix | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| f2_results | pass | b | d, backed b | C: compp1_one_round_per_division |  |
| hl1_heat_guards | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| jc1_inactive_judge_absent | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| k1_setup_fixes | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| ns1_no_show | pass | e | d, UNBACKED | B: COMPETITION NS1 SQL SUITE FAIL: heat_entries triggers: the 4 pre-CF1 triggers exist and ar; C: COMP_P1_FINAL_ONLY | R-11 / 899 (fix 2754a440 pushed, rerun) |
| o1_day_of | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| p1_pilot_restrictions | - | - | e | C: COMP_RESULT_INVALID_TRANSITION | OD-31 / 919 (fix 58e27945 pushed, rerun) |
| r10_s3_panel_readiness | - | a | d, backed a | C: COMP_P1_CALLBACKS_OFF |  |
| r11_approval_override_scope | - | a | d, backed a | C: COMP_P1_HEAT_NOT_STARTED |  |
| r2_entry_refunds | fail | c | d, UNBACKED | B: COMPO1_HEAT_STATUS_WRITER; C: compp1_one_heat_per_round | R-10 (assigned earlier) |
| r2_refund_write_gate | pass | a | d, backed a | C: compp1_one_heat_per_round |  |
| s6_entry_status_guard | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| scoring_registry | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| ss1_round_lock | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| u18_heat_entry_status_guard | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit | pass | b | d, backed b | B: passes as _with_s6; C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit_with_s6 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| od31_guarded_baseline_negative | pass | e | d, UNBACKED | B: COMP_S6_ENTRY_STATUS_WRITER; C: COMP_P1_FINAL_ONLY | OD-31 / 877 (expected behaviour change) |
| phase10a_competition_foundation | fail | e | d, UNBACKED | B: COMP_R15_ELIGIBILITY_WRITE_REFUSED (base fails differently: PHASE 10A SQL SUITE FAIL: manager applies the ballroom starter template => P0001 Competiti); AUTOSEED: COMP_R15_ELIGIBILITY_WRITE_REFUSED; C: compp1_one_heat_per_round | R-15 (labelled copy requested) |
| phase10b_competition_profiles | fail | c | d, UNBACKED | B: PHASE 10B SQL SUITE FAIL: the ballroom starter template still applies => P0001 Competition; C: COMP_P1_FINAL_ONLY | UNASSIGNED |
| phase10c5_competition_draft | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| phase10d1_heat_entry_eligibility | pass | e | e | B: PHASE 10D.1 SQL SUITE FAIL: the rule lives in the existing 10D integrity function (no seco; C: PHASE 10D.1 SQL SUITE FAIL: the rule lives in the existing 10D integrity function (no seco | R-11 / 899 (fix 2754a440 pushed, rerun) |
| phase10d1_heat_entry_eligibility_with_p1 | - | - | e | C: PHASE 10D.1 SQL SUITE FAIL: the rule lives in the existing 10D integrity function (no seco | R-11 / 899 (fix 2754a440 pushed, rerun) |
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
| cf1_a5_concurrency | pass | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_STRUCTURE_FROZEN | R-15 (labelled copy requested) |
| cf1_a5_concurrency_with_s6 | - | e | d, UNBACKED | B: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_R15_ENTRY_NOT_CLEARED; C: COMP_P1_STRUCTURE_FROZEN | R-15 (labelled copy requested) |
| cf1_a6_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a7_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_f3_concurrency | pass | a | d, backed a | C: COMP_P1_MINIMUM_COUPLES |  |
| cf1_od17_concurrency | pass | b | pass (copy) | C: COMP_R15_ENTRY_NOT_CLEARED |  |
| cf1_rb3r_concurrency | pass | e | e | B: FAIL  C2b entry reason 'entry_determination_missing'; C: FAIL  C2b entry reason 'entry_determination_missing' | R-15 (labelled copy requested) |
| cf1_u66_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| o1_concurrency | pass | a | e | C: COMPO1_BAD_STATE | OD-31 (restriction chain only) |
| s6_entry_status_concurrency | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |

