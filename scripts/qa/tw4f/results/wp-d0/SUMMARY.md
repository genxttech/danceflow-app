# WP-D0 results (2026-10-31, main 23ffbc43, local Docker only)

## 1. DEV-equivalent baseline
`run-chain.mjs baseline --image df-isoqa/base:20261119092100 --cutoff 20261119092100 --until 20261231100000`
applied 44 files (1120, 1121, 1122 + the 41 files of manifest 4.1) to a fresh container.
`probe_fingerprint.sql` (read only): `rollup:ALL | (1224 objects) | 3a38f6b6` = the hosted DEV value. No difference.
Also recorded: FP_SQL of run-chain.mjs (6826 rows, md5 47bf97ea), 820 public functions, 590 volatile.
**Two different fingerprint methods.** `run-chain.mjs` `FP_SQL` (its rollback/re-apply catalog comparisons) and `scripts/hosted/tw4f/probe_fingerprint.sql` use different methods, row sets and hashing; their values are NOT comparable. Only `probe_fingerprint.sql` (`rollup:ALL 3a38f6b6`, 1224 objects) is verified equal to hosted DEV. The FP_SQL value (47bf97ea) has no hosted counterpart and must not be quoted as DEV equivalence.

## 2. Function coverage (track_functions=all, one fresh DB per suite)
Scope = functions listed by probe_fingerprint.sql (tw4_functions 413 + other_sms_functions 9, 421 names): 277 volatile.
Called by at least one suite: 248. Never called: 29 (see coverage.md). Notes: trigger/guard functions only count when their trigger fires;
localStack.r2b is refused by design on the merged chain, so tw4_num_* functions exercised only by r2b show as uncovered.

## 3. Suite results (41 files; best result per suite)
PASS 31, KNOWN 4 (reproduced), FAIL 4 (unlisted), BLOCKED 2.
- PASS: aal2, tw4f3bpay, tw4f3bui, tw4monthly, tw4recurring, tw4recexec (20/20 on rerun), tw4inbound, tw4recon, tw4rv, tw4sender, tw4usage, j3owner, r2ci1, r2ci2, f1funding, f4recovery, f5canceltarget, feeres, r2brfl, tw4a9, tw4f3a, tw4f3b0, tw4fi, tw4fj1, tw4pilothard, tw4r1, tw4rfl, tw4rfld5, tw4rflevid, tw4rflops, tw4rflspend
- KNOWN (reproduced): tw4payhardening 14/15 (property test, failed again on the rerun), tw4a 14/15, r2bp2.rfl 2/3, tw4f1b 18/19
- FAIL, not in known-failures.json: f3recon 9/10 (F3-09 d rollback refused: another function calls _tw4usage_reconciler_ready), j2owner 11/12 (checklist has a 7th area "review"), r2a 28/30 (rollback discovery: 20270202090000_..._rollback.sql has no probe), j4activation 9/10 (reproduced 2/2; later diagnosed as a date-dependent test and fixed, see rerun table)
- BLOCKED: isolatedQa.canary (5 skipped), r2b (refuses the merged chain by design: real recurring-fee lifecycle present)
Harness gaps found and fixed in run-chain.mjs: 11 suites need public.tw4_local_qa_only and 3 need auth.users columns (iso-qa.mjs parity) -> `--marker`; suites use TW4RFL_DB / TW4F4_DB / TW4A9_DB / TW4A_RFL_DB_CONTAINER -> `--env ... {db}`.
Host was 70-90% CPU for most of run 1 (other sessions); resource-exhaustion annotations in run1-all-suites.md. Reruns (run3) were on a 13-48% host.

## 4. Triage of the newly discovered failures (stale test assumptions; no production SQL, no assertion weakened, known-failures.json untouched)
Rerun on the DEV-equivalent chain (`--until 20261231100000 --marker`), one suite at a time; the host was 75-93% CPU the whole time (other sessions), so each result carries the runner's "SATURATED" annotation.
| Suite | Before | After | Change |
|---|---|---|---|
| f3recon | 9/10 FAIL | 11/11 PASS | F3-09 (d): the rollback is refused on the composed chain because 20261226 `_tw4act_items(uuid)` calls `_tw4usage_reconciler_ready()` (a true dependency). Test now asserts the refusal, the exact caller set and unchanged fingerprints; the clean-rollback/re-apply leg (d2) runs in one rolled-back transaction with that single caller stubbed, with every original fingerprint and ACL assertion kept. |
| j2owner | 11/12 FAIL | 12/12 PASS | checklist now has a 7th area `review` (from `pilot_ki1_redecided`, 20261227); expected area list updated, per-area `{area, ok}` key assertions unchanged. |
| r2a | 28/30 (+1 skip) FAIL | 29/30 (+1 skip) runner verdict BLOCKED | rollback discovery: `20270202090000_..._read_watermark_rollback.sql` (#360) is a single idempotent `alter table ... drop column if exists` with no precondition guard by design; it is not unguarded in a harmful way (drops only a standalone ordering column). Discovery now classifies it by column existence. Also run on the full chain without `--until` (2027 layers applied): layers incl. 20270202090000 classified `applied`, layered rollback tests pass (29/30 + 1 skip). The one skip is the "R2a-only stack" test, skipped by design whenever later layers exist (it was already skipped in the failing baseline); the runner reports any skip as BLOCKED. |
| j4activation | 9/10 FAIL | 11/11 PASS | date-dependent test, not a product defect: the break set the number authorization to now+30d, which fails rfl_ready only while the next billing month starts at least 2 days away (rfl_ready exempts an authorization running more than 28 days past the next month start). Not caused by 20261231100000 (same failure without it). Break expiry is now capped just below that threshold (no-op on other days) and a date-independent boundary test (2b) was added incl. a cancelled-campaign counter-example; assertions unchanged. Run on 2026-10-31 (last day of the month) at 85% CPU. Evidence: run4-j4activation.md |
Not re-run (files and SQL untouched): tw4payhardening, tw4a, r2bp2.rfl, tw4f1b (KNOWN), isolatedQa.canary, r2b (BLOCKED).
Effect on the classification: 31 PASS + f3recon + j2owner + j4activation = 34 PASS; KNOWN 4; FAIL 0; BLOCKED 3 (isolatedQa.canary, r2b, r2a-by-design-skip).
Uncovered mutating functions: see `uncovered-functions.md` (10 guard triggers the meter cannot see, 11 only in refused r2b, 8 with no database test).
