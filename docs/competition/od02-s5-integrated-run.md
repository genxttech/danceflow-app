# Integrated local run: S1/S2 + S3 + S4 + S5 correction migrations on the composed Competition chain

**Local only.** One disposable container from `cf1host:found` (PostgreSQL 17.6, image `sha256:a9ff85eb…`), no network, no published port. No DEV or PROD apply, no merge, no deploy.
Runner: `scripts/qa/comp-s5-integrated-run.sh` (composition follows the OD-31 `run-guarded-baseline.sh`). Run of record: **run5, 2026-11-26 13:26-13:33Z**.

## Composition

- Base chain: `release/website-embeds` @ `49dbaee1b` Competition migrations plus JC1/U18/U18-S from `release/competition-cf1-app-candidate` @ `92a8c17c6` (37 files, fingerprint `d87e42858e6ca50ffef5779fe6d203bfa62992616d5ed8c694a75b397c52ba5d`; 23 apply on top of the image foundation).
- Heads used: 865 (S1/S2) `aa9ec1445`, 864 (S3) `cdac85fb0`, 866 (S4) `cabc41b7f`, 863 (S5) `d6315d85c`, 877 (S6, separate phases only) `7341af1df`, 867 `6dc6b2d4e`.
- The 865 migration changed after earlier runs. **The four-PR result below applies to 865 at `aa9ec1445`.**
- Release order = timestamp order: 090000, 100000, 101000, 102000, 110000, 120000, 130000, 131000.

## Executed results

| Step | Result |
|---|---|
| Base chain | 23 of 23 applied |
| S5 alone on the base chain, then its rollback | apply OK, rollback OK |
| Eight correction migrations in release order | 8 of 8 applied |
| S6 (140000, 141000) on the base chain and on the composed chain, each rolled back | applied; rollbacks OK |
| Rollback chain in reverse release order | 8 of 8 OK; no S5 triggers or functions and no R15 functions left |
| Re-apply | 8 of 8 applied |
| S5 age predicate | same definition hash `94ba8727…` before and after every suite in the S5-only, composed, S6 composed and re-apply phases; no violation |

### SQL suites (four correction PRs)

`baseline` = base chain only, released (candidate-branch) suites. `S5 only` = base + S5, with S5's suite versions. `composed` = base + all eight, with each PR's suite versions. `ADAPTED` = a temporary copy with only S4's clearance seeding added; it is **not** a pass of the released suite (diffs are in the run output, blob ids in `adapted-copies.txt`).

| Suite | baseline | S5 only | composed | re-apply |
|---|---|---|---|---|
| s5_participant_age_guard | n/a | PASS | PASS | PASS |
| r11_approval_override_scope | n/a | not run | PASS | PASS |
| r10_s3_panel_readiness | n/a | not run | PASS | PASS |
| r15_eligibility_clearance | n/a | not run | PASS | PASS |
| cf1_a3_results | PASS | PASS | PASS | not run |
| pv1_recompute | PASS | PASS | PASS | not run |
| e1_officials | FAIL (pre-existing) | FAIL (same) | FAIL (same) | not run |
| e2_ballots | not run | not run | FAIL | not run |
| ns1_no_show | PASS | FAIL | PASS | not run |
| phase10d1_heat_entry_eligibility | PASS | FAIL | PASS | not run |
| od31_guarded_baseline_negative | PASS | PASS | FAIL | not run |
| u18_heat_entry_status_guard | PASS | PASS | PASS (ADAPTED) | not run |
| u18s_heat_entry_scratch_audit | PASS | PASS | PASS (ADAPTED) | not run |
| jc1_inactive_judge_absent | PASS | PASS | PASS (ADAPTED) | not run |
| cf1_f3_publication | PASS | FAIL | PASS | not run |
| r2_entry_refunds | FAIL (pre-existing) | FAIL (same) | FAIL | not run |
| o1_day_of | PASS | PASS | FAIL | not run |
| phase10d_floor_schedule | PASS | PASS | FAIL | not run |
| r2_refund_write_gate | PASS | PASS | FAIL | not run |
| phase10c_competitor_registration | PASS | PASS | PASS | not run |
| phase10c4_participant_roles | PASS | PASS | PASS | not run |

### Every non-passing result, first observed cause and owner

A suite stops at its first error, so a later failure can be hidden behind it.

| Suite (phase) | First cause | Owner |
|---|---|---|
| e1_officials (all) | `COMPO1_ROUND_EDGE: draft -> active …`; fails on the base chain alone | pre-existing repository defect (suite predates O1) |
| r2_entry_refunds (baseline, S5 only) | `COMPO1_HEAT_STATUS_WRITER: scheduled -> active …`; fails on the base chain alone | pre-existing repository defect (suite predates O1) |
| r2_entry_refunds (composed) | `COMP_R15_ENTRY_NOT_CLEARED` (stage `floor_state`); the suite seeds no clearance. The pre-existing failure above would still follow | S4 (PR 866) clearance seeding; then pre-existing |
| r2_refund_write_gate (composed) | `COMP_R15_ENTRY_NOT_CLEARED` (stage `floor_state`) | S4 (PR 866) |
| e2_ballots (composed) | `COMP_R15_ENTRY_NOT_CLEARED` (stage `place`) | S4 (PR 866); suite file is changed by PR 864 |
| phase10d_floor_schedule (composed) | `COMP_R15_PROVISIONAL_ASSIGNMENT` on publish | S4 (PR 866) |
| o1_day_of (composed) | first printed error `COMPO1_NOT_PUBLISHED`; the preceding publish step fails but its message is not printed. R-15 publish refusal is the likely cause, **not confirmed** | S4 (PR 866) |
| od31_guarded_baseline_negative (composed) | C2 characterization expects `authenticated` to still hold TRIGGER on `event_competition_entries`; PR 866 migration 131000 revokes it, so the recorded finding no longer holds | expected change from S4; suite update with S4 / OD-31 |
| ns1_no_show, phase10d1, cf1_f3_publication (S5 only) | `COMP_S5_AGE_BLOCKED (unknown_age)`: these released fixtures have no date of birth. PR 866's versions carry them and pass composed. If S5 lands without PR 866, these three fail | fix lives in PR 866 (agreed split) |

### S6 (PR 877), separate phases

| Suite | S6 on base chain | S6 on composed chain |
|---|---|---|
| s6_entry_status_guard | PASS | **no valid result** (ADAPTED): runner defect, see below |
| u18s_heat_entry_scratch_audit_with_s6 | PASS | PASS (ADAPTED) |
| u18_heat_entry_status_guard | PASS | PASS (ADAPTED) |
| jc1_inactive_judge_absent | PASS | PASS (ADAPTED) |

Runner defect (S5): the temporary copy of the S6 guard suite received only the comment line of S4's hook, not the call, so it failed with `COMP_R15_ENTRY_NOT_CLEARED`. Fixed in the runner after run5; the fix is checked only by building the copy, not by running it.

## S5's own fixture changes

The adult dates of birth added to `o1_day_of`, `phase10d_floor_schedule`, `r2_refund_write_gate`, `r2_entry_refunds` and `phase10c_competitor_registration` are now executed: all pass or reach their pre-existing failure under S5 only. The age guard is unchanged; its under-18 and unknown-age negative cases are in the S5 suite.

## PENDING

- Rerun: S6 guard suite on the composed chain (fixed runner), `e2_ballots` on the base and S5-only chains, and the S4 items above after PR 866 changes.
- The S6 concurrency script and the other concurrency scripts.
- Suites not listed here, app-level tests, and any hosted apply.

## Earlier runs (superseded)

Run1 had two overlapping runner processes; do not use it as evidence. Run2 found the S5 owner-check cast defect (fixed in `40eb8304`). Run3 did not prepend suite fixture files. Run4 found the S4 `text[]` defect in `_r15_required_criteria` and the missing fixture dates of birth; both are resolved in run5.
