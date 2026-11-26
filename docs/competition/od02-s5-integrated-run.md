# Integrated local run: S1/S2 + S3 + S4 + S5 correction migrations on the composed Competition chain

**Local only.** One disposable container from `cf1host:found` (PostgreSQL 17.6, image `sha256:a9ff85eb…`), no network, no published port. No DEV or PROD apply, no merge, no deploy.
Runner: `scripts/qa/comp-s5-integrated-run.sh` (composition follows the OD-31 `run-guarded-baseline.sh`). Run of record: **run6, 2026-11-26 19:15-19:37Z**, runner at `fcedfcf33`.

## Composition

- Base chain: `release/website-embeds` @ `49dbaee1b` Competition migrations plus JC1/U18/U18-S from `release/competition-cf1-app-candidate` @ `92a8c17c6` (37 files, fingerprint `d87e42858e6ca50ffef5779fe6d203bfa62992616d5ed8c694a75b397c52ba5d`; 23 apply on top of the image foundation).
- Heads recorded at lock time: 865 (S1/S2) `d5c3bed523`, 864 (S3) `a1b0eb9d59`, 866 (S4) `3b65f63d1b`, 863 (S5) `fcedfcf339`, 877 (S6, separate phases only) `8c738c4d89`, 867 `6dc6b2d4e5`.
- PR 864 moved to `9d7477c098` after the lock; that commit changes one document only.
- Since run5 no S1-S5 migration or rollback file changed. Both S6 migrations and one S6 rollback did (877 `7341af1df` to `8c738c4d89`).
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
| S5 age predicate | definition hash `94ba8727…` as expected in the S5-only, composed, S6 composed and re-apply phases; no violation |

### SQL suites (four correction PRs)

`baseline` = base chain only, released (candidate-branch) suites. `S5 only` = base + S5, with S5's suite versions. `composed` = base + all eight, with the correction PRs' suite versions. `ADAPTED` = a temporary copy changed only for the composed chain; it is **not** a pass of the released suite (diffs are in the run output, blob ids in `adapted-copies.txt`).

| Suite | baseline | S5 only | composed | re-apply |
|---|---|---|---|---|
| s5_participant_age_guard (49 checks) | n/a | PASS | PASS | PASS |
| r11_approval_override_scope | n/a | not run | PASS | PASS |
| r10_s3_panel_readiness | n/a | not run | PASS | PASS |
| r15_eligibility_clearance (real S5 predicate) | n/a | not run | PASS | PASS |
| cf1_a3_results (5 checks report blocked, all phases) | PASS | PASS | PASS | not run |
| pv1_recompute | PASS | PASS | PASS | not run |
| e1_officials | FAIL (pre-existing) | FAIL (same) | FAIL (same) | not run |
| e2_ballots | PASS | PASS | PASS | not run |
| ns1_no_show | PASS | FAIL (expected) | PASS | not run |
| phase10d1_heat_entry_eligibility | PASS | FAIL (expected) | PASS | not run |
| od31_guarded_baseline_negative | PASS | PASS | PASS (ADAPTED) | not run |
| u18_heat_entry_status_guard | PASS | PASS | PASS (ADAPTED) | not run |
| u18s_heat_entry_scratch_audit | PASS | PASS | PASS (ADAPTED) | not run |
| jc1_inactive_judge_absent | PASS | PASS | PASS (ADAPTED) | not run |
| cf1_f3_publication | PASS | FAIL (expected) | PASS | not run |
| r2_entry_refunds | FAIL (pre-existing) | FAIL (same) | FAIL (same) | not run |
| o1_day_of | PASS | PASS | PASS | not run |
| phase10d_floor_schedule | PASS | PASS | PASS | not run |
| r2_refund_write_gate | PASS | PASS | PASS | not run |
| phase10c_competitor_registration | PASS | PASS | PASS | not run |
| phase10c4_participant_roles | PASS | PASS | PASS | not run |

### Every non-passing result, first observed cause and owner

A suite stops at its first error, so a later failure can be hidden behind it.

| Suite (phase) | First cause | Owner |
|---|---|---|
| e1_officials (all; composed uses PR 864's changed file) | `COMPO1_ROUND_EDGE: draft -> active …`; the released suite fails the same way on the base chain alone | pre-existing repository defect (suite predates O1) |
| r2_entry_refunds (all) | `COMPO1_HEAT_STATUS_WRITER: scheduled -> active …`; fails on the base chain alone | pre-existing repository defect (suite predates O1) |
| ns1_no_show, phase10d1, cf1_f3_publication (S5 only) | `COMP_S5_AGE_BLOCKED (unknown_age)`: the released fixtures have no date of birth. PR 866's versions carry them and pass composed. If S5 lands without PR 866, these three fail | fix lives in PR 866 (agreed split) |

### Where composed suites come from

- `o1_day_of`, `phase10d_floor_schedule`, `r2_refund_write_gate`, `r2_entry_refunds`: PR 866's versions on the composed chain. None of the lines in PR 863's versions (including the date-of-birth edits) is removed or changed.
- `od31_guarded_baseline_negative`: S4's `sql-tests/adapted/r15-od31-negative-c2.patch` applied to a temporary copy; released and adapted blob ids matched. Baseline and S5-only run the original.
- U18, U18-S, JC1: temporary copies with S4's clearance seeding (PR 867 carries no hook). The released suites pass on the base chain.

### S6 (PR 877), separate phases

| Suite | S6 on base chain | S6 on composed chain |
|---|---|---|
| s6_entry_status_guard (127 checks) | PASS | PASS (ADAPTED) |
| u18s_heat_entry_scratch_audit_with_s6 | PASS | PASS (ADAPTED) |
| u18_heat_entry_status_guard | PASS | PASS (ADAPTED) |
| jc1_inactive_judge_absent | PASS | PASS (ADAPTED) |

The composed S6 guard copy has S4's clearance step before every top-level heat-entry insert (original lines 49, 323, 369). That placement is S5's choice; the S6 owner has not confirmed it.

## S5's own fixture changes

The adult dates of birth added to `o1_day_of`, `phase10d_floor_schedule`, `r2_refund_write_gate`, `r2_entry_refunds` and `phase10c_competitor_registration` pass under S5 only and composed, except `r2_entry_refunds`, which reaches its pre-existing failure in both. The age guard is unchanged; its under-18 and unknown-age negative cases are in the S5 suite.

## PENDING

- All concurrency scripts, including S6's `cf1_a5_concurrency_with_s6.sh` and `s6_entry_status_concurrency.sh` and S1/S2's `run_f2_races.sh`.
- Suites not listed here, app-level tests, full tsc / vitest / next build, and any hosted apply.
- The two pre-existing failures stay open; whatever follows their first error is untested.

## Earlier runs (superseded)

Run1 had two overlapping runner processes; do not use it as evidence. Run2 found the S5 owner-check cast defect (fixed in `40eb8304`). Run3 did not prepend suite fixture files. Run4 found the S4 `text[]` defect in `_r15_required_criteria` and the missing fixture dates of birth. Run5 failed six composed suites on S4 clearance and publish gates or an expected S4 change, and its S6 composed guard result was invalid (runner defect); run6 resolves both.
