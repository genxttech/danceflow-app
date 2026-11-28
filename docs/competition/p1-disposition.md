# P1 composed run: disposition table

Runs p1run6, p1run7 and p1run8 laid over each other, newest result per name (2026-11-27). Local only. A copy's pass is never a pass of its original.

## Disposition of every failed suite and race (p1run6, then p1run7, then the consolidated rerun p1run8 laid over it)

(a) passes on B as the original; (b) passes on B only as a labelled copy (adapted copy, _with_s6 variant or AUTOSEED); (c) also fails on base; (d) on C the first refusal is a named pilot restriction: the guard is **untested** on C, not a pass, acceptable only when backed by (a) or (b); (e) unexplained or a defect. "not run" = a script that passed on C, so it was never run on B.

Counts: race B a = 2; race B b = 23; race B expected = 1; race C d (written reason) backed a = 1; race C d (written reason) backed b = 1; race C d backed a = 1; race C d backed b = 16; race C d backed b (the with_s6 copy is the one for this chain) = 1; race C e = 1; race C pass (copy) = 5; suite B a = 17; suite B b = 30; suite B e = 1; suite C d (written reason) backed b = 1; suite C d backed a = 14; suite C d backed b = 27; suite C pass (copy) = 6. Counts are as generated, before two hand adjustments (the R-11 copy on B, and cf1_a3_locks on C).

### SQL suites

| Name | A base | B corrections | C restriction | First refusal on B / C | Owner of (e) or unbacked |
|---|---|---|---|---|---|
| cf1_a0_tie_policy | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a1_helpers | pass | b | d, backed b | B: passes as cf1_a1_helpers_with_r15; C: COMP_P1_FINAL_ONLY |  |
| cf1_a1_helpers_with_r15 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
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
| cf1_od17_enforcement | pass | b | d (written reason), backed b | C: COMP_R15_ENTRY_NOT_CLEARED; AUTOSEED: COMP_OD17_REFUND_GATE; S09/M3d replica-mode advancement insert refused by always-enabled zz_compp1_advancement (read, not in the log; OD-31) |  |
| cf1_rb3_refund_evidence | pass | b | d, backed b | B: passes as cf1_rb3_refund_evidence_with_r15; C: COMP_P1_FINAL_ONLY |  |
| cf1_rb3_refund_evidence_with_r15 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
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
| r11_approval_override_scope_p1_pilot | - | n/a (refuses without the restrictions) | pass (copy) | B: R11 P1 pilot copy refused: the pilot restrictions are not installed; run the original suit; C: B not applicable: refuses without the restrictions | |
| r2_entry_refunds | fail | a | d, backed a | C: compp1_one_heat_per_round |  |
| r2_refund_write_gate | pass | a | d, backed a | C: compp1_one_heat_per_round |  |
| s6_entry_status_guard | - | b | pass (copy) | C: COMP_P1_FINAL_ONLY; passes as s6_entry_status_guard_with_p1 |  |
| scoring_registry | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| ss1_round_lock | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| u18_heat_entry_status_guard | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit | pass | b | d, backed b | B: passes as _with_s6; C: COMP_P1_FINAL_ONLY |  |
| u18s_heat_entry_scratch_audit_with_s6 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| od31_guarded_baseline_negative | pass | b | d, backed b | B: passes as od31_guarded_baseline_negative_with_s6; C: COMP_P1_FINAL_ONLY |  |
| od31_guarded_baseline_negative_with_s6 | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| phase10a_competition_foundation | pass | b | d, backed b | B: passes as phase10a_competition_foundation_with_r15; C: compp1_one_heat_per_round |  |
| phase10a_competition_foundation_with_r15 | - | b | d, backed b | C: compp1_one_heat_per_round |  |
| phase10b_competition_profiles | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| phase10c5_competition_draft | pass | a | d, backed a | C: COMP_P1_FINAL_ONLY |  |
| phase10d1_heat_entry_eligibility | pass | a | pass (copy) | C: PHASE 10D.1 SQL SUITE FAIL: the rule lives in the existing 10D integrity function (no seco; passes as phase10d1_heat_entry_eligibility_with_p1 |  |
| phase10d_floor_schedule | pass | a | d, backed a | C: compp1_one_heat_per_round |  |

### Concurrency scripts

| Name | A base | B corrections | C restriction | First refusal on B / C | Owner of (e) or unbacked |
|---|---|---|---|---|---|
| cf1_a2_lock_vs_lifecycle | pass | b | d, backed b | C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| cf1_a3_locks | fail | b | d (read through its copy), backed b | B: passes as cf1_a3_locks_verdict C: the original prints no code; its copy cf1_a3_locks_verdict stops at COMP_P1_FINAL_ONLY | |
| cf1_a3_locks_verdict | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| e2_marks_txn | pass | b | pass (copy) | B: passes as e2_marks_txn_chain_copy; C: E2 MARKS-TXN FAIL:; fixture: chain v1 and v3 exist; later transaction cannot add a mark to; passes as e2_marks_txn_chain_copy |  |
| e2_submit_vs_lock | fail | b | pass (copy) | B: passes as e2_submit_vs_lock_danced; C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED); passes as e2_submit_vs_lock_danced |  |
| e2_submit_vs_lock_danced | pass | b | pass (copy) | C: COMP_R15_ENTRY_NOT_CLEARED |  |
| f2_races | fail | b | d, backed b | B: passes as f2_races_pv1; C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| f2_races_pv1 | pass | b | d, backed b | C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| hl1_reopen_vs_lock_ballots | pass | b | d, backed b | C: COMP_P1_HEAT_NOT_STARTED (after AUTOSEED) |  |
| ns1_races | fail | b | d, backed b | B: passes as ns1_races_danced; C: COMP_P1_STARTED_HEAT (after AUTOSEED) |  |
| ns1_races_danced | pass | b | d, backed b | C: COMP_P1_STARTED_HEAT (after AUTOSEED) |  |
| cf1_a0_tie_concurrency | pass | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |
| cf1_a4_concurrency | pass | b | d (written reason), backed b | C: R-10: unreachable in the pilot (C log says only: fixture failed) |  |
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
| o1_concurrency | pass | a | d (written reason), backed a | C: COMPO1_BAD_STATE; OD-31: last race unreachable in the pilot; 919 suite check H-D3c passes (160 checks) |  |
| s6_entry_status_concurrency | - | b | d, backed b | C: COMP_P1_FINAL_ONLY |  |

