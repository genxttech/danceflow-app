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
- FAIL, not in known-failures.json: f3recon 9/10 (F3-09 d rollback refused: another function calls _tw4usage_reconciler_ready), j2owner 11/12 (checklist has a 7th area "review"), r2a 28/30 (rollback discovery: 20270202090000_..._rollback.sql has no probe), j4activation 9/10 (reproduced 2/2; funding_continuity break expected to also fail rfl_ready, only funding_continuity fails)
- BLOCKED: isolatedQa.canary (5 skipped), r2b (refuses the merged chain by design: real recurring-fee lifecycle present)
Harness gaps found and fixed in run-chain.mjs: 11 suites need public.tw4_local_qa_only and 3 need auth.users columns (iso-qa.mjs parity) -> `--marker`; suites use TW4RFL_DB / TW4F4_DB / TW4A9_DB / TW4A_RFL_DB_CONTAINER -> `--env ... {db}`.
Host was 70-90% CPU for most of run 1 (other sessions); resource-exhaustion annotations in run1-all-suites.md. Reruns (run3) were on a 13-48% host.
