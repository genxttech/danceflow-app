# CF1-C Phase 2c: DB-level gate audit on integration-2 17250a4e (2026-10-31)

Supersedes `...-31b.md`. Single local Postgres container `cf1c-pg`, clean full chain (271 applied, 4 skipped, 0 failed) + CF1 from `origin/cf1/integration-2` **17250a4e**
(A0 bd66a144, A1 69139b5a, A2 5d875430, A3 50aba43a, A4a 3d5a38ed, A5 0afa4f45, A6 a3707461, A7 e061a596, B 78b008d7, B2 e2974e9d, A4 4d4daadd). Never hosted; slot taken and released by C.
Raw: `docs/qa/cf1c-db-run/report_full_integration2.txt`, `gate_audit.tsv`.

## Chain and suites
- Composed apply PASS; reverse rollback fingerprint diff 0; re-apply diff 0.
- 22 of 22 SQL suites PASS: HL1 42, E2 211, E2p1 10, F2 198, O1 95, SS1adv 13, SS1lock 36, NS1 152, CX1 15, K1 23, REG 80, 10D 79, 10D.1 22, A1 132 (5 blocked), A0 198 (5), A2 32, A3 113 (4), A4a 63 (2), A5 187 (4), A6 230 (3), A7 74 (1), A4 55 (3). Suite-declared "blocked" checks are not counted as passed.
- Concurrency: A0, A2 (19), A4, A5, A6, A7 PASS. **A3 lock probe NOT VERIFIED** again ("cannot create a3probe"): owner A3 / A4 harness.

## Audit method
A passing suite proves every labelled `chk` row in it (the suite raises PASS only if none is FAIL). Gate ids were extracted from check labels (`audit.cjs`); suite-declared BLOCKED sub-checks counted separately; concurrency scripts count only where their header names the gate and they passed. Owner packages from design A.9.5. A "PASS (+n BLOCKED sub-checks)" gate has labelled passing checks but part of it is declared blocked in the suite; read the suite for which part.

## Result
- The 20 gates previously NOT PROVEN are now each proven by labelled checks (U4, U8-U11, U14, U19-U22, U32, U34, U38, U53-U55, U57, U67, U68). **Zero NOT PROVEN remain** among U1-U85 in this table.
- **BLOCKED / not run:** U7, U46 (hosted permissions; owner/host), U66 (F3 not built), U18 and U28 (UI stack / B-owned; E2E not run), U24 (owner decision pending); **BLOCKED in suite:** U16, U27, U31, U42, U73, U77; U15 N/A.
- U61 passes its labelled SQL checks; its lock-probe script is NOT VERIFIED.
- New A6 behaviour D-A, D-B, D-C and A0 L5: PASS (rows at the end of the table).

## Gate-by-gate
| Gate | Owner pkg | Status | Proof (suite / check labels) |
|---|---|---|---|
| U1 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_a6_concurrency,cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U2 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_a6_concurrency; scripts passed, per-check label mapping is by script header only |
| U3 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U4 | A0 | PASS | 2 labelled check(s) in cf1_callback_final_advancement |
| U5 | A0 | PASS | 2 labelled check(s) in cf1_callback_final_advancement |
| U6 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U7 | A0, A1 | BLOCKED | hosted permissions check needs the hosted DB |
| U8 | A0 | PASS | 3 labelled check(s) in cf1_concurrency; concurrency cf1_concurrency |
| U9 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U10 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U11 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U12 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U13 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U14 | A0 | PASS | 6 labelled check(s) in cf1_callback_final_advancement |
| U15 | none | N/A | OD-10 route (b) not chosen |
| U16 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U17 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U18 | A0 | BLOCKED | needs UI stack + block-mode fixture: not run (no Stripe TEST key in env, memory) |
| U19 | A0 | PASS | 2 labelled check(s) in cf1_callback_final_advancement |
| U20 | A0 | PASS | 2 labelled check(s) in cf1_concurrency; concurrency cf1_concurrency |
| U21 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U22 | A0 | PASS | 4 labelled check(s) in cf1_callback_final_advancement |
| U23 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U24 | A0 | BLOCKED | owner decision pending (coordinator) |
| U25 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U26 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U27 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U28 | B | BLOCKED | B-owned vitest/PostgREST gate; not run by C |
| U29 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U30 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U31 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U32 | A0 | PASS | 12 labelled check(s) in cf1_callback_final_advancement |
| U33 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U34 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U35 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U36 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U37 | A6 | PASS | 10 labelled check(s) in cf1_a6_withdrawal |
| U38 | A2, A5 | PASS | 17 labelled check(s) in cf1_a2_lock,cf1_a5_u38_composed |
| U39 | A6 | PASS | 17 labelled check(s) in cf1_a6_withdrawal |
| U40 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U41 | A6 | PASS | 3 labelled check(s) in cf1_a6_withdrawal (+1 suite-declared BLOCKED sub-checks); concurrency cf1_a6_concurrency |
| U42 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U43 | A4 | PASS | 1 labelled check(s) in cf1_a4_minimum_integration (+1 suite-declared BLOCKED sub-checks) |
| U44 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U45 | A0 | PASS | 2 labelled check(s) in cf1_a6_withdrawal,cf1_callback_final_advancement |
| U46 | A1 | BLOCKED | hosted permissions check needs the hosted DB |
| U47 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U48 | A6 | PASS | 5 labelled check(s) in cf1_a6_withdrawal |
| U49 | A6 | PASS | 5 labelled check(s) in cf1_a6_withdrawal |
| U50 | A0 | PASS | 2 labelled check(s) in cf1_callback_final_advancement |
| U51 | A6 | PASS | 2 labelled check(s) in cf1_a6_concurrency,cf1_a6_withdrawal (+1 suite-declared BLOCKED sub-checks); concurrency cf1_a6_concurrency |
| U52 | A0, A5, A6 | PASS | 12 labelled check(s) in cf1_a5_exclusion,cf1_a6_withdrawal,cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U53 | A3 | PASS | 5 labelled check(s) in cf1_a3_results (+1 suite-declared BLOCKED sub-checks) |
| U54 | A0, A2 | PASS | 9 labelled check(s) in cf1_a2_lock,cf1_callback_final_advancement,cf1_concurrency; concurrency cf1_concurrency |
| U55 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U56 | A4 | PASS | 1 labelled check(s) in cf1_a4_minimum_integration |
| U57 | A1 | PASS | 29 labelled check(s) in cf1_a1_helpers (+1 suite-declared BLOCKED sub-checks) |
| U58 | A2 | PASS | 7 labelled check(s) in cf1_a2_lock |
| U59 | A3 | PASS | 21 labelled check(s) in cf1_a3_results |
| U60 | A3, A4 | PASS | 15 labelled check(s) in cf1_a3_results,cf1_a4_minimum_integration |
| U61 | A2, A3 | PASS (labelled SQL checks); lock probe NOT VERIFIED | 4 labelled check(s) in cf1_a3_results; A3 lock-probe script could not create its probe database |
| U62 | A6 | PASS | 3 labelled check(s) in cf1_a6_withdrawal |
| U63 | A5, A6 | PASS | 19 labelled check(s) in cf1_a5_exclusion,cf1_a6_withdrawal (+1 suite-declared BLOCKED sub-checks) |
| U64 | A0, A1 | PASS | 3 labelled check(s) in cf1_callback_final_advancement (+2 suite-declared BLOCKED sub-checks) |
| U65 | A5 | PASS | 6 labelled check(s) in cf1_a5_exclusion (+1 suite-declared BLOCKED sub-checks) |
| U66 | F3 (external) | BLOCKED | F3 not built |
| U67 | A4a | PASS | 50 labelled check(s) in cf1_a4a_target_guard |
| U68 | A2 | PASS | 1 labelled check(s) in cf1_a2_lock |
| U69 | A2, A3 | PASS | 9 labelled check(s) in cf1_a2_lock,cf1_a3_results |
| U70 | A1 | PASS | 14 labelled check(s) in cf1_a1_helpers,cf1_a6_withdrawal,cf1_callback_final_advancement |
| U71 | A4 | PASS | 6 labelled check(s) in cf1_a4_minimum_integration |
| U72 | A3 | PASS | 2 labelled check(s) in cf1_a3_results |
| U73 | A3 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U74 | A1, A5 | PASS | 25 labelled check(s) in cf1_a1_helpers,cf1_a5_exclusion |
| U75 | A5 | PASS | 5 labelled check(s) in cf1_a5_exclusion,cf1_a6_withdrawal (+1 suite-declared BLOCKED sub-checks) |
| U76 | A5 | PASS | 2 labelled check(s) in cf1_a5_exclusion (+3 suite-declared BLOCKED sub-checks) |
| U77 | A4a | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U78 | A5 | PASS (concurrency script, header-tagged) | tagged in cf1_a5_concurrency; scripts passed, per-check label mapping is by script header only |
| U79 | A3 | PASS | 18 labelled check(s) in cf1_a3_results |
| U80 | A3 | PASS (DB), browser BLOCKED | 4 labelled checks in cf1_a3_results; QA-A browser half not run |
| U81 | A3 | PASS (DB), browser BLOCKED | 5 labelled checks in cf1_a3_results; QA-A browser half not run |
| U82 | A1, A3 | PASS | 9 labelled check(s) in cf1_a2_lock,cf1_a3_results |
| U83 | A3 | PASS (DB), browser BLOCKED | 2 labelled checks in cf1_a3_results; QA-A browser half not run |
| U84 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U85 | A2, C | PASS | 13 existing suites passed (hl1,e2,e2p1,f2,o1,ss1adv,ss1lock,ns1,cx1,k1,reg,p10d,p10d1) |
| D-A | A6 | PASS | 17 labelled checks in cf1_a6_withdrawal |
| D-B | A6 | PASS | 32 labelled checks in cf1_a6_withdrawal |
| D-C | A6 | PASS | 5 labelled checks in cf1_a6_withdrawal |
| L5 | A0 | PASS | 7 labelled checks in cf1_callback_final_advancement |

## Browser / E2E - all BLOCKED, none run
Environment still has no `E2E_STRIPE_TEST_SECRET_KEY` / `E2E_STRIPE_TEST_CONNECTED_ACCOUNT` (checked 2026-10-31), and every scenario in `docs/qa/cf1-acceptance-matrix.md` starts with a paid registration. No stack, build or browser was started. Owner: owner/host. Affected: all SCN-* and the browser halves of U80, U81, U83, U18. RB1 (b) is therefore not established.

## Verdict
No product defect found. DB level: 22/22 suites, 6 concurrency scripts, chain apply/rollback/re-apply clean; gate audit has no NOT PROVEN; open items are the named BLOCKED gates, the A3 lock-probe harness, and the whole browser layer.
