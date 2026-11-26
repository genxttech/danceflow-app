# Integrated local run: S1/S2 + S3 + S4 + S5 correction migrations on the composed Competition chain

**Local only.** One disposable container from `cf1host:found` (PostgreSQL 17.6, image `sha256:a9ff85eb…`), no network, no published port. No DEV or PROD apply, no merge, no deploy.
Runner: `scripts/qa/comp-s5-integrated-run.sh` (composition follows the OD-31 `run-guarded-baseline.sh`). Run of record: **run4, 2026-11-26 10:57-11:02Z**; container and ticket removed.

## Composition

- Base chain: `release/website-embeds` @ `49dbaee1b` Competition migrations plus JC1/U18/U18-S from `release/competition-cf1-app-candidate` @ `92a8c17c6` (37 files, fingerprint `d87e42858e6ca50ffef5779fe6d203bfa62992616d5ed8c694a75b397c52ba5d`; 23 apply on top of the image foundation). PR 867's JC1/U18/U18-S SQL blobs were checked identical to those composed.
- Heads: 865 (S1/S2) `649af318`, 864 (S3) `9d3dad16`, 866 (S4) `6b9f252f`, 863 (S5) `40eb8304` (the SQL under test; later commits on this branch add only this record and runner changes).
- Release order = timestamp order: 090000, 100000, 101000, 102000, 110000, 120000, 130000, 131000.

## Executed results

| Step | Result |
|---|---|
| Base chain | 23 of 23 applied |
| S5 alone on the base chain, then its rollback | apply OK, rollback OK |
| Eight correction migrations in release order | 8 of 8 applied |
| Rollback chain in reverse release order | 8 of 8 OK; no S5 triggers or functions and no R15 functions left |
| Re-apply | 8 of 8 applied |

### SQL suites

`baseline` = base chain only, unmodified (candidate-branch) suites. `S5 only` = base + S5. `composed` = base + all eight. Fixture files named by a suite are prepended.

| Suite | baseline | S5 only | composed | re-apply | First cause when not PASS (owner) |
|---|---|---|---|---|---|
| s5_participant_age_guard | n/a | PASS | PASS | PASS | |
| r11_approval_override_scope | n/a | not run | PASS | PASS | |
| r10_s3_panel_readiness | n/a | not run | PASS | PASS | |
| r15_eligibility_clearance | n/a | not run | FAIL | FAIL | **product defect (S4)**: `_r15_required_criteria` does `v_req := v_req \|\| 'age_division'` on `text[]` ("malformed array literal") |
| cf1_a3_results | PASS | PASS | PASS | not run | |
| pv1_recompute | PASS | PASS | PASS | not run | |
| e1_officials | FAIL | FAIL | FAIL | not run | pre-existing on the base chain: `COMPO1_ROUND_EDGE` (suite predates O1) |
| ns1_no_show | PASS | FAIL | FAIL | not run | S5 only: fixtures without date of birth (S5). Composed: the same S4 `text[]` defect ("status") |
| phase10d1_heat_entry_eligibility | PASS | FAIL | PASS | not run | S5 only: no date of birth (S5); composed version of the suite (from PR 866) passes |
| od31_guarded_baseline_negative | PASS | PASS | FAIL | not run | S4 fixture `r15_clear_entries` inserts a competitor without `studio_id` while the suite is in replica mode (S4) |
| u18_heat_entry_status_guard | PASS | PASS | FAIL | not run | `COMP_R15_ENTRY_NOT_CLEARED`: suite seeds no clearance (S4 gate adaptation) |
| u18s_heat_entry_scratch_audit | PASS | PASS | FAIL | not run | same (S4) |
| jc1_inactive_judge_absent | PASS | PASS | FAIL | not run | same (S4) |
| cf1_f3_publication | PASS | FAIL | FAIL | not run | S5 only: no date of birth (S5). Composed: clearance (S4) |
| r2_entry_refunds | FAIL | FAIL | FAIL | not run | pre-existing `COMPO1_HEAT_STATUS_WRITER`; additionally no date of birth under S5 |
| o1_day_of | PASS | FAIL | FAIL | not run | no date of birth (S5) |
| phase10d_floor_schedule | PASS | FAIL | FAIL | not run | no date of birth (S5) |
| r2_refund_write_gate | PASS | FAIL | FAIL | not run | no date of birth (S5) |
| phase10c_competitor_registration | PASS | FAIL | FAIL | not run | drafts carry no date of birth (S5) |
| phase10c4_participant_roles | PASS | PASS | PASS | not run | |

A suite stops at its first error, so a later failure in the same suite can be hidden behind the first one. The first-cause column is what was observed, not a complete list.

## The two suites that fail on the base chain alone (not passed; pre-existing, not a runner artifact)

Both are run unmodified on the base chain, with no correction migration applied.

| Suite | Exact first error | Assessment |
|---|---|---|
| `test_T_competition_r2_entry_refunds` | `ERROR:  COMPO1_HEAT_STATUS_WRITER: scheduled -> active is written only by advance_competition_floor_heat.` (`_compo1_guard_heat_status()` line 34) | The suite (R2, `20270103090000`) sets `event_competition_heats.status` directly. The later O1 migration (`20270106090000`) forbids that writer, so the suite is stale on any chain that contains O1. Its QA matrix records a pass on 2026-10-23/24. Pre-existing repository defect. |
| `test_T_competition_e1_officials` | `ERROR:  COMPO1_ROUND_EDGE: draft -> active is not a round transition in the K0 state machine.` (`_compo1_guard_round_status()` line 40) | Same cause: the E1 suite (`20270101090000`) moves rounds directly, which O1 forbids. Pre-existing repository defect. PR 864 changes this suite; the composed version still fails with this error. |

## PENDING

- **S5 fixture change (2026-11-26), not yet executed:** adult dates of birth were added to `o1_day_of`, `phase10d_floor_schedule`, `r2_refund_write_gate`, `r2_entry_refunds` and `phase10c_competitor_registration`. The age guard is unchanged; its under-18 and unknown-age negative cases stay in the S5 suite. `ns1_no_show`, `phase10d1` and `cf1_f3_publication` are changed by PR 866 instead.
- **run5, not yet executed:** waits for the PR 866 fix of `_r15_required_criteria` (not in head `6b9f252f`). The runner now prepends PR 866's clearance fixture to every suite and fails a suite as `FAIL-PREDICATE` if the S5 age predicate's definition changes or anything tries to create, alter or drop it.
- Suites not in the list above, the concurrency scripts, app-level tests, and any hosted apply.

## Earlier runs (superseded)

Run1 (2026-11-24) executed with two overlapping runner processes sharing an output directory; do not use it as evidence. Run2 found the S5 owner-check cast defect on a chain without S4 (fixed in `40eb8304`). Run3 confirmed the fix on the 11-24 heads but did not prepend suite fixture files.
