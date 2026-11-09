# CF1 RB4: applied-chain integrity evidence (2026-11-05)

> **Historical (added 2026-11-07).** This evidence was taken on integration-3 (`24babc19`), where the A7 migration carried the slot `20270120096000`. On integration-5 A7 is `20270120095500` (between A6 `095000` and the A0 review fixes `101000`), and the A7 audit-cause trigger was corrected in place (never applied to hosted DEV/PROD: read-only catalog check 2026-11-07). The pins and file hashes below therefore do NOT describe the final chain; RB4 pins must be regenerated from the final applied chain. See `docs/qa/cf1-int5-closeout-2026-11-07.md`.


Scope: release blocker **RB4** of the CF1 design (callback-to-final advancement design, release blockers and A.9.1/A.9.4): "md5 pins from an applied chain (never DEV or PROD), with the existing HL1 md5 test and the rollback chain order updated (U68)". Local disposable Postgres only. No PR merged, no hosted SQL, no Vercel, no Stripe, OD-17 untouched (still disabled).

This document covers only the RB4 evidence. It authorizes no release. RB1(a), RB2 and RB3 are untouched.

## 1. What was tested

| Item | Value |
|---|---|
| Tree | `origin/cf1/integration-3` = `24babc197ab8f2289e5470674bcfc3996badb1cf` (worktree `<worktrees>/studioapp-cf1-int3`) |
| Main compared against | `origin/main` = `c06222b783c84035a85c55db5502fa8fd1f1c446` |
| Database | own disposable container `cf1rb4-pg` (image `public.ecr.aws/supabase/postgres:17.6.1.106`, no published ports, removed afterwards). Not the runner's `cf1c-pg`; the `supabase_*_cf1c-qa` and `df-d24-qa-*` containers were not touched; no REVOKE was run. The shared slot lock `<dev-root>/.cf1-db-slot.lock` did not exist and no shared port or resource was used, so it was not taken. |
| Chain recipe | copied from the runner's full-chain recipe (`fullchain/build.mjs`, `bootstrap.sql`, `ord_a.txt`, `ord_b.txt`): July prod dump + bootstrap + GoTrue columns, 4 explicit skips, 3 CRLF-converted files, appointments trigger enabled mid-way. 260 pre-2027 files applied (0 failed, 4 skipped), then the 19 `2027` competition files (E1..HL1 = 11, CF1 = 8) applied **one file at a time** from the committed git blobs (as committed, no CR conversion), as `postgres`, one transaction per file. 260 + 11 = 271 = the runner's applied count. |
| Fingerprint | the runner's `fp.sql` (public functions: normalised md5 + owner + ACL; triggers; relation columns; constraints; policies; indexes) plus `fp_ext.sql` (table/sequence ACLs, enum labels, column defaults, SECURITY DEFINER/config/volatility per function). Public schema catalog only; data and other schemas are not in it. |
| Scripts / raw output | `<qa-run>/evidence/rb4/` (`rb4.sh` .. `rb4e.sh`, `pins.mjs`, `steps.mjs`, `run*.log`, `fp_*.txt`, `snaps\*.tsv`, `hl1_*.out`, `pin_coverage.tsv`, `step_pins.md`, `migration_files.tsv`). |

## 2. Result matrix

| # | Task | Status | Evidence |
|---|---|---|---|
| 1a | Apply every CF1 migration in order on an applied chain | **PASS** | 8 CF1 files (`20270120085000`..`096000`) plus HL1..E1 apply cleanly in numeric order (`run2.log`). |
| 1b | Committed file bytes vs applied definitions (CRLF drift) | **PASS** (no drift in the CF1 chain) | All 38 files (19 migrations + 19 rollbacks) contain 0 CR bytes (`migration_files.tsv`). Every function created or redefined by E1..CF1 has no CR in its applied `pg_get_functiondef`. 85 other public functions carry CRs, identically before E1, after HL1 and after CF1 (pre-existing, from the July dump and the 3 CRLF-converted files; none touched by CF1). |
| 1c | md5 pins in repo = md5 of the object on an applied chain | **PASS with 5 expected non-matches** | 115 md5 literals in the E1..CF1 migrations, rollbacks and the HL1/CF1/K1/NS1/CX1/SS1/F2/E2 SQL suites; 110 found as an applied object md5 (`pin_coverage.tsv`). The 5 not found are the K1 CRLF-checkout variants of the `prosrc` md5 (`ba42ef12...`, `b29d4ddc...`); K1 accepts LF or CRLF and only the LF value exists on an LF checkout. |
| 2a | Migration order and declared dependencies | **PASS** | Section 4. |
| 2b | Slot/timestamp collisions across `cf1/*`, other branches, main | **PASS for CF1; 1 unrelated collision reported** | No CF1 slot is used by a different file on any of 64 scanned `origin/{cf1,competition,claude}/*` branches or `origin/main`. Only collision seen: `20270208090000` is used by both `d24_m3a_intent_ledger` and `twilio_price_dual_control` (non-CF1). |
| 2c | int3 composed with main's newer migrations | **PASS (local order replay)** | Section 5. |
| 3 | HL1 heat-lock regression | **PASS 42/42** on the post-CF1 chain and on the composed main chain; **FAIL (the single pin check) by design** on an HL1-only chain with CF1 rolled back | Section 6. |
| 4a | CF1 reverse rollback vs pre-CF1 baseline | **PASS, 0 diff lines** | `fp_10` (10,082 lines) vs `fp_40`. |
| 4b | Reapply vs original post-CF1 | **PASS, 0 diff lines** | `fp_30` (10,432 lines) vs `fp_50` and `fp_70`. |
| 4c | Whole competition chain (CF1, then HL1..E1) rollback vs pre-competition | **PASS, 0 diff lines** | `fp_00` (9,618 lines) vs `fp_60`; reapply vs `fp_30`: 0 (`fp_70`). |
| 4d | Rollback scripts exist for every migration | **PASS** | 19 of 19 (`migrations/rollback/*_rollback.sql`). No gap to draft. |
| 4e | Rollback with CF1 data present (exclusions, withdrawals, advancements) | **NOT VERIFIED** | Fresh schema, no data. The A3/A5/A6 rollbacks refuse while rows exist by design. |
| 4f | "App first" half of the rollback order | **NOT VERIFIED** | SQL only; no app deployment exercised. |
| 5 | Pins against PROD/DEV catalogs | **NOT VERIFIED (out of scope)** | RB4 requires applied-chain pins, never DEV/PROD; no hosted database was read. The migrations' own preflights refuse on mismatch at apply time, so a PROD pre-pin mismatch fails safe. |

## 3. Pins: committed value vs applied value

Pre = the md5 pinned by the migration preflight and the rollback restore check; post = the value on the applied chain after the step (md5 of `pg_get_functiondef` with CRs removed). "match" = the literal in the repo equals the applied value. Full list, including E2..SS1 steps: Appendix B and `step_pins.md`.

### HL1 (20270119090000)
`lock_competition_round_ballots(uuid,uuid)`: pre `a10fc61528af902c0d7fd0e00caaa155` (in HL1 migration and rollback: match); post `6e4175342d51ffe274d70ce413bae8c3` (matches A2's pre pin and A2 rollback restore pin: match; HL1 itself has no post pin).

### A0 (20270120090000): preflight pins = pre-A0 text; the rollback re-checks the same values
| function | applied pre md5 (= pin, match) | applied post md5 (no post pin in repo) |
|---|---|---|
| `complete_competition_round(uuid,uuid)` | `dd0e1cd4c02bb51bbd75471c113a1f9f` | `e4c105ac6ea9017eb7f3c5fa5dea789f` |
| `set_competition_round_heat_capacity(uuid,integer)` | `4fbc864079928710917ea67d7968d8bb` | `acd3d68f8971b0292910d6c64236ec39` |
| `competition_audit_log(uuid,uuid,integer)` | `d38b87512d066907b37702addc6cd116` | `f6bb04ec82b4e39d2df0ef438a223ba1` |
| `_comp10d_copy_floor_plan(uuid,uuid)` | `8162a7341b7bcd00a141e81392c8c602` | `d8a61d3432db9f4b116227bff575a2ee` |
| `_comp10d_guard_floor_heat()` | `bd20973caffce985813daadde8be947a` | `f34af508b3da4d249c0245a8c16d8f0b` |
| `_comp10d_guard_heat_child()` | `9bb78230385387a3c6a39e66f2d9f8d0` | `f4b9277a0d6e2867640210ef513e5c5b` |
| `validate_competition_heat_schedule_placement()` | `f2079401a3a92c3289405547d2fe511b` | `2359c5515dcc8a1c10f87ee32faa3d4b` |

### A4a (20270120091000): no md5 pin by design (exact-fragment replace). Observed applied values, informational
`_cf1_callback_target_check(integer,integer)` `1bd9c67d...` -> `9d157c2f...`; `cf1_guard_callback_target_capacity()` `852618ba...` -> `97e78cbb...`; `cf1_guard_callback_target_program_lock()` `44ed866b...` -> `f564ff1b...`; `set_competition_round_heat_capacity(uuid,integer,text,uuid)` `52c174e6...` -> `d66154c6...`.

### A2 (20270120092000)
`lock_competition_round_ballots(uuid,uuid)`: pre `6e4175342d51ffe274d70ce413bae8c3` (match), post `c4ba327df7943d559ab52ccd07d20ea0` (match; the same literal is in the HL1 and A2 SQL suites and accepted by the A1 suite).

### A3 (20270120093000): pre and post pinned in the migration; the rollback pins both
| function | pre (match) | post (match) |
|---|---|---|
| `_compe2_guard_mark_insert()` | `786bdf3604fa36e5f8328ecc0d5385ad` | `055adcc12d8f903a7570c93008f303a9` |
| `_compe2_heat_entries(uuid)` | `f275ced91a3b319aaf0835f67bfe174d` | `fdcb8728dde030c8d9772fdaf2963524` |
| `_compe2_round_entries(uuid)` | `f0da6935a3dcc04320f7636da6655a3b` | `64859bac497c22fd7472b9e7ae6fc986` |
| `_compe2_round_heats(uuid)` | `1e75e888142ed1727eb6b2d6c8c0a906` | `7a5a1563a9450e2ec3b807a69737f9f4` |
| `_compf2_evidence(uuid,text,text)` | `2b1c9a22be4a4c4a4e5ba43adee37306` | `415a823b4a689cae26b8a20187af58e7` |
| `approve_competition_round_result(uuid,uuid,text,uuid)` | `0650367be64e3d1b4387a3dbceba3d4a` | `ac33e456925e64665db1ea0547bae18b` |
| `calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)` | `ddaa45cbb518f7592f5ca6dd0ba00176` | `bc3cc4397e740444a4d4a53d93b499cc` |
| `competition_judge_ballot_sheet(uuid)` | `21cd3df42b8789e3b1baade47a0231d0` | `2506cb2f466d1738fb1a8f298e805b5f` |
| `competition_round_ballot_status(uuid)` | `a3f5226acc9a40cdedd83d9c0a0fee24` | `7d3bebe922fed33604666009d3a593a5` |
| `competition_round_results_review(uuid)` | `c842be1dafce548cd279f1d2d6f6f1d0` | `c9d747907caad0a88b75da1c53862f43` |

### A7 (20270120096000)
`_compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)`: pre `4e16740112345ac0c306e841b82ac473` (match; this is the post-F2 value, so A7 depends on F2 and on no other CF1 file redefining it), post `e5cecd7b4cff91bbdb7222cc5061b4d9` (match).

### Earlier steps the CF1 chain depends on (all matched on the applied chain)
F2 pre pins `bf42705d...` (`_compe2_guard_ballot_insert`) and `f28880ce...` (`_compe2_insert_ballot`); NS1's six E2/F2 functions; CX1's two readers (pre pins = NS1 post values); K1 `add_competition_division` by `prosrc` md5 (LF variants `38b61707...` pre and `d503110a...` post matched; CRLF variants `ba42ef12...`, `b29d4ddc...` are not present on an LF checkout, as designed).

### Drift found
* **Committed vs applied: none.** No CR bytes in any CF1-chain file; no CR in any function the chain creates or redefines; every pre/post pin literal equals the applied value (110 of 110 non-CRLF-variant literals).
* The 5 K1 CRLF-variant literals cannot be exercised on an LF checkout (by design).
* 85 unrelated pre-existing public functions have CRs in their applied definitions (unchanged by CF1). They are why the pins normalise CRs.
* A0's 7 redefined functions have **no post-state pin** in the repo (only pre pins), and A0's rollback does not check the post state before restoring. A4a is intentionally unpinned. Hardening gaps, not failures (section 7).

## 4. Order and dependency (task 2)

Numeric order is the only order tested and it is clean. Dependency probe (`run4.log`): from the pre-CF1 baseline, apply all CF1 files in ascending order **omitting one file**, stop at the first refusal, roll the applied ones back, and compare the fingerprint to the baseline each time. All 8 cases restored the baseline (fp md5 `628ac46634b8`).

| omitted | result |
|---|---|
| A1 `085000` | A0 `090000` REFUSED: "CF1-A0 preflight: A1 (20270120085000) is missing." |
| A0 `090000` | A4a `091000` REFUSED: "A0 (20270120090000) is not applied" (later files not reached) |
| A4a `091000` | remaining 6 applied cleanly |
| A2 `092000` | remaining 6 applied cleanly (the OD-17 lock check would then be absent; the database does not force A2 before A3..A7) |
| A3 `093000` | A7 `096000` REFUSED: "A3 ... is missing" |
| A5 `094000` | A7 REFUSED: "A5 ... is missing" |
| A6 `095000` | remaining 6 applied cleanly |
| A7 `096000` | remaining 6 applied cleanly |

Refusals are atomic (single-transaction apply; fingerprint unchanged). Because the probe stops at the first refusal, dependencies deeper than the first refusal are not independently measured.

Slots: all CF1 files sit in the `20270120` block (`085000`..`096000`). Scan of 64 `origin/{cf1,competition,claude}/*` branches plus main for `2027*` migration files: no CF1 slot is reused by a different file. Competition files on other branches that would interleave with E1..HL1 if merged (not in int3, not composed with CF1 here): `20270103 r2_entry_refunds`, `20270108 sc1_scratch`, `20270111 checkin_balance_refund`, `20270112 checkin_front_desk`, and `20270205100000 competition_desk_suite_gate` (`claude/d7-desk-db-enforcement`). A grep of those files finds no `create function` for any function CF1 redefines. The only repeated slot is `20270208090000` (two unrelated non-CF1 files).

## 5. Composition with origin/main c06222b7 (task 2c)

int3 lacks main's newest migrations: `20261231090000_twilio_platform_admin_aal2`, `20261231100000_twilio_pilot_spend_hardening` and nine `20270201090000`..`20270207090000` files. In true timestamp order (the two `20261231` files before E1, the nine `202702` files after A7), after rolling the competition chain back to the pre-competition baseline (0 diff), the whole sequence applied with **0 failures**. Of the 1,091 public functions present after CF1, 3 changed afterwards, all from the `20261231` Twilio files (`_sms_onb_is_platform_admin`, `tw4_rfl_pilot_cover`, `tw4_spend_authorize`); no competition or CF1 function changed. The HL1 (42), A2 (32), A3 (113 checks, 4 blocked) and A7 (74 checks, 1 blocked) suites pass on this composed state. This is a local order replay, not a PROD simulation.

## 6. HL1 heat-lock regression (task 3)

Suite `test_T_competition_hl1_heat_guards.sql` (run as `supabase_admin`; it always ends with a raise, so the `ERROR:` prefix in the output is the suite's own verdict):

| chain state | verdict |
|---|---|
| post-CF1 (first apply) | `COMPETITION HL1 HEAT GUARDS SQL SUITE PASS (42 checks)` |
| CF1 rolled back (HL1 only) | `SUITE FAIL`: the single failing check is "lock_competition_round_ballots body is the pinned post-HL1 text" |
| after full rollback and reapply | PASS (42 checks) |
| composed with main extras | PASS (42 checks) |

The suite's pin (line 254, `c4ba327d...`) is the **post-A2** text, so the suite is green only with A2 applied. That is the intended "HL1 md5 test updated" part of RB4 (commit `ae90efec`); it also means the HL1 suite is no longer a standalone HL1-only regression: with CF1 rolled back it reports one expected failure. The A1 suite accepts both `6e41...` (post-HL1) and `c4ba...` (post-A2). The HL1 concurrency script `sql-tests/concurrency/run_hl1_reopen_vs_lock_ballots.sh` was **not run** here.

## 7. Rollback (task 4) and remaining gaps

Documented order (design A.9.1, A2 rollback header): app first; SQL in reverse numeric order; CF1 as a whole before HL1; A2's rollback before HL1's, because the HL1 rollback pins the pre-HL1 text `a10fc615...`. Executed on the container exactly so: A7, A6, A5, A3, A2, A4a, A0, A1 (all OK) -> baseline equal; then HL1, SS1-advancement, CX1, SS1-lock, NS1, F2, scoring-registry, K1, O1, E2, E1 (all OK) -> pre-competition baseline equal; forward reapply of all 19 -> equal to the first post-CF1 fingerprint. A repeat fingerprint of an unchanged post-CF1 state was also equal (stable).

Remaining gaps (none changes a PASS above):
1. Rollback and reapply with CF1 data present (exclusions, withdrawals, advancements, results): NOT VERIFIED. The app-first half of the order: NOT VERIFIED.
2. Pre-pins were proven against a local replay of the July prod dump plus repo migrations, not the actual PROD catalog (not read). PROD drift would fail the migration preflight safely; a read-only PROD pin probe before release is advisable and needs separate authorization.
3. A0's 7 redefinitions have no post-pin, A0's rollback does not verify the post state, and A4a is unpinned: a later redefinition of those functions would be silently overwritten by the rollback.
4. A2 is not a hard database prerequisite of A3..A7 (omit-A2 applies cleanly) although the HL1 suite and OD-17 depend on it; the release runbook must apply all eight files.
5. Other branches' interleaving competition slots (R2 refunds, SC1, check-in, desk suite gate) were not composed with CF1.
6. HL1 reopen-vs-lock concurrency script not re-run in this task.
7. Fingerprint scope is the public schema catalog: data, auth/storage schemas, cron/net jobs and comments are outside it.

## Appendix A. Committed file identity (git blob sha1 prefix, content md5, bytes, CR bytes)

| file | blob sha1 | md5 | bytes | CR |
|---|---|---|---|---|
| 20270101090000_competition_e1_officials.sql | a5fc88ceb4d0 | 38ab2dc5b03c271c939c5711244bf5f6 | 42925 | 0 |
| rollback/20270101090000_competition_e1_officials_rollback.sql | 7cf61d2d8169 | d2b70a87bf08a405bbbed819e25e0081 | 3405 | 0 |
| 20270102090000_competition_e2_ballots.sql | 2830628a75ea | c07dda0dd8a36bbbd744a0e67485a775 | 81144 | 0 |
| rollback/20270102090000_competition_e2_ballots_rollback.sql | c9b4c9f6a131 | c137d0355cc540e5b2242c249ec35551 | 4409 | 0 |
| 20270106090000_competition_o1_day_of.sql | a7c5c8b78c10 | f9bd6d1b94d5d013c5b8de551dbfddfb | 31927 | 0 |
| rollback/20270106090000_competition_o1_day_of_rollback.sql | d230bc2bb16b | c66224f878ded26b6fa66fbb3e531c58 | 1872 | 0 |
| 20270110090000_competition_k1_setup_fixes.sql | cc9deee8a613 | ea29cbb66af830fb37ac31cffb74d4c4 | 6496 | 0 |
| rollback/20270110090000_competition_k1_setup_fixes_rollback.sql | f3a9a8ff1de6 | f0483746c4d54ffbb3f1a410c17f05ff | 5186 | 0 |
| 20270113090000_competition_scoring_registry.sql | 37fc6371b31b | 435236c602153b400d68391b3907b34c | 29476 | 0 |
| rollback/20270113090000_competition_scoring_registry_rollback.sql | 586c4d34acfe | 4f3e992e21e2c42a7ce32276e95f4023 | 3706 | 0 |
| 20270114090000_competition_f2_results_lifecycle.sql | 3bced8e7a7f0 | 8b182f5fca5e221608eb36347ddb528e | 73925 | 0 |
| rollback/20270114090000_competition_f2_results_lifecycle_rollback.sql | 1103341b4ff1 | bc230b6fc209f854301b1c0c149b8905 | 6199 | 0 |
| 20270115090000_competition_ns1_heat_no_shows.sql | 64b305a4e9d6 | c4b988b945e22d8fdf6a67c99b206848 | 26797 | 0 |
| rollback/20270115090000_competition_ns1_heat_no_shows_rollback.sql | 415505867e3d | ecc850f24d4380e1b9a8498eeb07ee12 | 2528 | 0 |
| 20270116090000_competition_ss1_round_scoring_lock.sql | 0c0c8f84e5d7 | b5324bd229185abfe7b06cbbd405c4e8 | 13272 | 0 |
| rollback/20270116090000_competition_ss1_round_scoring_lock_rollback.sql | 066db2ef25f9 | e62100e4cc671dbce250fb9f6be7c5a1 | 1180 | 0 |
| 20270117090000_competition_cx1_correction_ballot_readers.sql | 39bb10dc1621 | 4c9234280b1e56fea74620447ce7958d | 2809 | 0 |
| rollback/20270117090000_competition_cx1_correction_ballot_readers_rollback.sql | c12ae40e120b | 07385e6319ac90996cda80e02b114b68 | 1350 | 0 |
| 20270118090000_competition_ss1_advancement_freeze.sql | f1602915be30 | 682255ddabe6a269f7493d3c182a68b3 | 3451 | 0 |
| rollback/20270118090000_competition_ss1_advancement_freeze_rollback.sql | 0f82c0b22f29 | 0e59ae2dfb2baa5a703dda17b6d1addd | 889 | 0 |
| 20270119090000_competition_hl1_heat_guards.sql | 3cca88b29581 | 30360e3fa703523f9e19c90754784f4b | 7852 | 0 |
| rollback/20270119090000_competition_hl1_heat_guards_rollback.sql | 8e2393b9fc85 | e7516e0162660168d4f6b1520ce4c686 | 1876 | 0 |
| 20270120085000_competition_cf1_a1_eligibility_helpers.sql | 1f1c9e309fad | 9ca5ba75fe743348199030120f2fc371 | 19243 | 0 |
| rollback/20270120085000_competition_cf1_a1_eligibility_helpers_rollback.sql | c500e0b0b535 | 4c54a2da7e5da468a24605f344fe8166 | 2695 | 0 |
| 20270120090000_competition_cf1_callback_final_advancement.sql | 4121e4d94108 | 5312620d511397ece550218c99bc2b39 | 99906 | 0 |
| rollback/20270120090000_competition_cf1_callback_final_advancement_rollback.sql | 369b3da8ce1c | 0c910da27f32af5a5df5266dcf6576b4 | 23905 | 0 |
| 20270120091000_competition_cf1_a4a_callback_target_guard.sql | 02ad7eeec525 | f40ad2094e776e796ac3b50051f31ef3 | 6219 | 0 |
| rollback/20270120091000_competition_cf1_a4a_callback_target_guard_rollback.sql | 3b52d1a78726 | d8b7705d7bf94049a1c937d9d312f09d | 2314 | 0 |
| 20270120092000_competition_cf1_a2_lock_check.sql | d1176018ecb6 | cfe2826c022c89bf8a1beca5c9b1d3f1 | 4582 | 0 |
| rollback/20270120092000_competition_cf1_a2_lock_check_rollback.sql | 20406d4c9cb9 | 5b4d4ca06bb6ab4fd546cc443409b8f1 | 1487 | 0 |
| 20270120093000_competition_cf1_a3_results_integrity.sql | e76b0fd2404a | 1ad1d1839936fa8e922680a116968227 | 13845 | 0 |
| rollback/20270120093000_competition_cf1_a3_results_integrity_rollback.sql | 1029b8144860 | 7c0a8fa2faaa36931e08d2b3253ea88c | 9197 | 0 |
| 20270120094000_competition_cf1_a5_exclusion_action.sql | 4df06a568fe3 | f4a4ecef0017c8f83a7b845f7ff83696 | 38385 | 0 |
| rollback/20270120094000_competition_cf1_a5_exclusion_action_rollback.sql | 28b5b96f80bb | cb97badffe785aadbc4aecc6daa9d6b6 | 2802 | 0 |
| 20270120095000_competition_cf1_a6_withdrawal.sql | 4592fa20e8d5 | 4fef21123f39896e408ff026680d004e | 45195 | 0 |
| rollback/20270120095000_competition_cf1_a6_withdrawal_rollback.sql | d6fe26ba3cdc | 3cf2e8fbd5d58ef759915aef8b6fd324 | 3855 | 0 |
| 20270120096000_competition_cf1_a7_od13_correction_integrity.sql | e927eb53be75 | 4bb5f536aa634b1b1a90d36a12ee4404 | 45536 | 0 |
| rollback/20270120096000_competition_cf1_a7_od13_correction_integrity_rollback.sql | cf171fcb185d | e394a4258140fead9cec0c3cceb00ada | 4909 | 0 |

## Appendix B. Per-migration function changes on the applied chain (md5 of pg_get_functiondef, CRs removed)

## 20270101090000_competition_e1_officials.sql  (new fns: 18, redefined: 0, dropped: 0)

## 20270102090000_competition_e2_ballots.sql  (new fns: 29, redefined: 0, dropped: 0)

## 20270106090000_competition_o1_day_of.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270110090000_competition_k1_setup_fixes.sql  (new fns: 0, redefined: 1, dropped: 0)
| add_competition_division(uuid,text,text,text) | pre 9be8c835d0d053101a685150b31f5229 [NOT in migration/rollback file] | post e85048964bd66bcb2c758275e7620997 [NOT in file] | CR in applied def: false |

## 20270113090000_competition_scoring_registry.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270114090000_competition_f2_results_lifecycle.sql  (new fns: 24, redefined: 2, dropped: 0)
| _compe2_guard_ballot_insert() | pre bf42705de4337864940a6f73b54afda9 [in rollback file] | post 1fba5e9f1c47b83440597afef2861490 [NOT in file] | CR in applied def: false |
| _compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid) | pre f28880cece349cd1a52179f89ccf2e7c [in rollback file] | post 4e16740112345ac0c306e841b82ac473 [NOT in file] | CR in applied def: false |

## 20270115090000_competition_ns1_heat_no_shows.sql  (new fns: 6, redefined: 6, dropped: 0)
| _compe2_guard_mark_insert() | pre 007fd7de4aa3dd6ca1ba25962b6f3b61 [in rollback file] | post 786bdf3604fa36e5f8328ecc0d5385ad [NOT in file] | CR in applied def: false |
| _compe2_heat_entries(uuid) | pre 280a98ecd18f3cac6a332312dae4c8f8 [in rollback file] | post f275ced91a3b319aaf0835f67bfe174d [NOT in file] | CR in applied def: false |
| _compe2_round_entries(uuid) | pre 5733a9f338621b983a0b771570ad4833 [in rollback file] | post f0da6935a3dcc04320f7636da6655a3b [NOT in file] | CR in applied def: false |
| _compe2_round_heats(uuid) | pre 588b53f7e7662cb0df46554310312426 [in rollback file] | post 1e75e888142ed1727eb6b2d6c8c0a906 [NOT in file] | CR in applied def: false |
| competition_judge_ballot_sheet(uuid) | pre f89262a01859317442be13c8d6be0239 [in rollback file] | post eada65f81faa04248816773818006a14 [NOT in file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre 6ed6628d3da9444ec24d25c36fd1d4c2 [in rollback file] | post d1aca173a954764731862a341a1d5e7e [NOT in file] | CR in applied def: false |

## 20270116090000_competition_ss1_round_scoring_lock.sql  (new fns: 3, redefined: 0, dropped: 0)

## 20270117090000_competition_cx1_correction_ballot_readers.sql  (new fns: 0, redefined: 2, dropped: 0)
| competition_judge_ballot_sheet(uuid) | pre eada65f81faa04248816773818006a14 [in rollback file] | post 21cd3df42b8789e3b1baade47a0231d0 [NOT in file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre d1aca173a954764731862a341a1d5e7e [in rollback file] | post a3f5226acc9a40cdedd83d9c0a0fee24 [NOT in file] | CR in applied def: false |

## 20270118090000_competition_ss1_advancement_freeze.sql  (new fns: 1, redefined: 0, dropped: 0)

## 20270119090000_competition_hl1_heat_guards.sql  (new fns: 3, redefined: 1, dropped: 0)
| lock_competition_round_ballots(uuid,uuid) | pre a10fc61528af902c0d7fd0e00caaa155 [in rollback file] | post 6e4175342d51ffe274d70ce413bae8c3 [NOT in file] | CR in applied def: false |

## 20270120085000_competition_cf1_a1_eligibility_helpers.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270120090000_competition_cf1_callback_final_advancement.sql  (new fns: 30, redefined: 7, dropped: 0)
| _comp10d_copy_floor_plan(uuid,uuid) | pre 8162a7341b7bcd00a141e81392c8c602 [in rollback file] | post d8a61d3432db9f4b116227bff575a2ee [NOT in file] | CR in applied def: false |
| _comp10d_guard_floor_heat() | pre bd20973caffce985813daadde8be947a [in rollback file] | post f34af508b3da4d249c0245a8c16d8f0b [NOT in file] | CR in applied def: false |
| _comp10d_guard_heat_child() | pre 9bb78230385387a3c6a39e66f2d9f8d0 [in rollback file] | post f4b9277a0d6e2867640210ef513e5c5b [NOT in file] | CR in applied def: false |
| competition_audit_log(uuid,uuid,integer) | pre d38b87512d066907b37702addc6cd116 [in rollback file] | post f6bb04ec82b4e39d2df0ef438a223ba1 [NOT in file] | CR in applied def: false |
| complete_competition_round(uuid,uuid) | pre dd0e1cd4c02bb51bbd75471c113a1f9f [in rollback file] | post e4c105ac6ea9017eb7f3c5fa5dea789f [NOT in file] | CR in applied def: false |
| set_competition_round_heat_capacity(uuid,integer) | pre 4fbc864079928710917ea67d7968d8bb [in rollback file] | post acd3d68f8971b0292910d6c64236ec39 [NOT in file] | CR in applied def: false |
| validate_competition_heat_schedule_placement() | pre f2079401a3a92c3289405547d2fe511b [in rollback file] | post 2359c5515dcc8a1c10f87ee32faa3d4b [NOT in file] | CR in applied def: false |

## 20270120091000_competition_cf1_a4a_callback_target_guard.sql  (new fns: 0, redefined: 4, dropped: 0)
| _cf1_callback_target_check(integer,integer) | pre 1bd9c67d1476753760fe2725e27fe121 [NOT in migration/rollback file] | post 9d157c2ff103eaa9889e549d44ac68e7 [NOT in file] | CR in applied def: false |
| cf1_guard_callback_target_capacity() | pre 852618baeb7cff14d8286aa241a59771 [NOT in migration/rollback file] | post 97e78cbb505cc56b9393afc931b70294 [NOT in file] | CR in applied def: false |
| cf1_guard_callback_target_program_lock() | pre 44ed866b50c0077c5ee537d13dd66f86 [NOT in migration/rollback file] | post f564ff1bc4163c0a37b29ce9a15253e5 [NOT in file] | CR in applied def: false |
| set_competition_round_heat_capacity(uuid,integer,text,uuid) | pre 52c174e637b3c7ba37fe1b6877b0adbf [NOT in migration/rollback file] | post d66154c6d7d8085b94e7d82609e492e6 [NOT in file] | CR in applied def: false |

## 20270120092000_competition_cf1_a2_lock_check.sql  (new fns: 0, redefined: 1, dropped: 0)
| lock_competition_round_ballots(uuid,uuid) | pre 6e4175342d51ffe274d70ce413bae8c3 [in rollback file] | post c4ba327df7943d559ab52ccd07d20ea0 [in migration file] | CR in applied def: false |

## 20270120093000_competition_cf1_a3_results_integrity.sql  (new fns: 0, redefined: 10, dropped: 0)
| _compe2_guard_mark_insert() | pre 786bdf3604fa36e5f8328ecc0d5385ad [in rollback file] | post 055adcc12d8f903a7570c93008f303a9 [in migration file] | CR in applied def: false |
| _compe2_heat_entries(uuid) | pre f275ced91a3b319aaf0835f67bfe174d [in rollback file] | post fdcb8728dde030c8d9772fdaf2963524 [in migration file] | CR in applied def: false |
| _compe2_round_entries(uuid) | pre f0da6935a3dcc04320f7636da6655a3b [in rollback file] | post 64859bac497c22fd7472b9e7ae6fc986 [in migration file] | CR in applied def: false |
| _compe2_round_heats(uuid) | pre 1e75e888142ed1727eb6b2d6c8c0a906 [in rollback file] | post 7a5a1563a9450e2ec3b807a69737f9f4 [in migration file] | CR in applied def: false |
| _compf2_evidence(uuid,text,text) | pre 2b1c9a22be4a4c4a4e5ba43adee37306 [in rollback file] | post 415a823b4a689cae26b8a20187af58e7 [in migration file] | CR in applied def: false |
| approve_competition_round_result(uuid,uuid,text,uuid) | pre 0650367be64e3d1b4387a3dbceba3d4a [in rollback file] | post ac33e456925e64665db1ea0547bae18b [in migration file] | CR in applied def: false |
| calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid) | pre ddaa45cbb518f7592f5ca6dd0ba00176 [in rollback file] | post bc3cc4397e740444a4d4a53d93b499cc [in migration file] | CR in applied def: false |
| competition_judge_ballot_sheet(uuid) | pre 21cd3df42b8789e3b1baade47a0231d0 [in rollback file] | post 2506cb2f466d1738fb1a8f298e805b5f [in migration file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre a3f5226acc9a40cdedd83d9c0a0fee24 [in rollback file] | post 7d3bebe922fed33604666009d3a593a5 [in migration file] | CR in applied def: false |
| competition_round_results_review(uuid) | pre c842be1dafce548cd279f1d2d6f6f1d0 [in rollback file] | post c9d747907caad0a88b75da1c53862f43 [in migration file] | CR in applied def: false |

## 20270120094000_competition_cf1_a5_exclusion_action.sql  (new fns: 14, redefined: 0, dropped: 0)

## 20270120095000_competition_cf1_a6_withdrawal.sql  (new fns: 17, redefined: 0, dropped: 0)

## 20270120096000_competition_cf1_a7_od13_correction_integrity.sql  (new fns: 16, redefined: 1, dropped: 0)
| _compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid) | pre 4e16740112345ac0c306e841b82ac473 [in rollback file] | post e5cecd7b4cff91bbdb7222cc5061b4d9 [in migration file] | CR in applied def: false |
