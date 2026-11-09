# CF1-C Phase 2b: DB-level gate audit on integration bdc6fb75 (2026-10-31)

Supersedes the suite-to-gate mapping of `cf1-c-db-acceptance-2026-10-31.md` (that mapping was unaudited). Single local Postgres container `cf1c-pg`, clean full chain
(271 applied, 4 skipped, 0 failed) + CF1 from `origin/cf1/integration` **bdc6fb75** (A0 5d84bf12, A1 e3b73914, A2 859e1fb7, A3 c85f751d, A4a 954cc347, A5 b66df1f0,
A6 a3707461, A7 e061a596, B 2b78d512, B2 e2974e9d). Never hosted. Slot taken and released by C. Raw: `docs/qa/cf1c-db-run/`.

## Chain and suites
- Composed apply PASS; reverse rollback fingerprint diff 0; re-apply diff 0.
- 22 of 22 SQL suites PASS: HL1 42, E2 211, E2p1 10, F2 198, O1 95, SS1adv 13, SS1lock 36, NS1 152, CX1 15, K1 23, REG 80, 10D 79, 10D.1 22, A1 131 (4 blocked), A0 148 (4), A2 29, A3 107 (3), A4a 63 (2), A5 187 (4), A6 230 (3), A7 74 (1), A4 55 (3). "Blocked" = checks the suite itself declares out of scope; not counted as passed.
- Concurrency: A0, A2 (19), A4, A5, A6 (incl. R6a/R6b cancel || co-sign, R7 cancel || cancel), A7 PASS. **A3 lock probe NOT VERIFIED** (`cannot create a3probe`; none of the 9 expected probe values appeared). Owner: A3 / A4 harness.

## How the gates were audited
A suite check inserts a named row (`pg_temp.chk(name, ok)`), the suite raises `... SUITE PASS` only when no row is FAIL, so a passing suite proves every labelled check in it. I extracted, from the suite sources, the check labels carrying each gate id (`audit.cjs`; table below), counted the suite-declared BLOCKED sub-checks separately, and treated concurrency scripts as proof only where the script header names the gate and the script passed. **"NOT PROVEN" means no labelled check or script carries the id; the gate may be covered under an untagged label.** That is a finding for the owner to tag or confirm, not a failure. Gate list and owner packages are from design A.9.5.

## New A6 behaviour (bdc6fb75)
- **D-A** (`COMP_WITHDRAWAL_NO_APPROVED_RESULT`, stale open requests, history untouched, accepts again after re-approval): 17 labelled checks, A6 suite, PASS.
- **D-B** (cancel authz: front desk / judge / other studio / unverified / anon refused; weak reason; requester cancels; evidence row; replay; cap of ten live requests freed): 32 labelled checks, PASS. Race: A6 concurrency R6a, R6b (exactly one winner, both orders) and R7 (replay, one row) PASS.
- **D-C**: 5 labelled checks, PASS (unchanged behaviour).
- **L5** (A0 freeze): 7 labelled checks in the A0 suite, PASS.

## Gate-by-gate
| Gate | Owner pkg | Status | Proof (suite / check labels) |
|---|---|---|---|
| U1 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_a6_concurrency,cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U2 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_a6_concurrency; scripts passed, per-check label mapping is by script header only |
| U3 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U4 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U5 | A0 | PASS | 2 labelled check(s) in cf1_callback_final_advancement |
| U6 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U7 | A0, A1 | BLOCKED | hosted permissions check needs the hosted DB |
| U8 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U9 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U10 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U11 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U12 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U13 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U14 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U15 | none | N/A | OD-10 route (b) not chosen |
| U16 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U17 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U18 | A0 | BLOCKED | needs UI stack + block-mode fixture: not run (no Stripe TEST key in env, memory) |
| U19 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U20 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U21 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U22 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U23 | A0 | PASS (concurrency script, header-tagged) | tagged in cf1_concurrency; scripts passed, per-check label mapping is by script header only |
| U24 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U25 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U26 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U27 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U28 | B | BLOCKED | B-owned vitest/PostgREST gate; not run by C |
| U29 | A0 | PASS | 3 labelled check(s) in cf1_callback_final_advancement |
| U30 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U31 | A0 | BLOCKED in suite | suite declares 1 check(s) blocked, none passing |
| U32 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U33 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U34 | A0 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U35 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement |
| U36 | A0 | PASS | 1 labelled check(s) in cf1_callback_final_advancement (+1 suite-declared BLOCKED sub-checks) |
| U37 | A6 | PASS | 10 labelled check(s) in cf1_a6_withdrawal |
| U38 | A2, A5 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
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
| U53 | A3 | NOT PROVEN | no labelled check or run found |
| U54 | A0, A2 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U55 | A0 | NOT PROVEN | no labelled check found |
| U56 | A4 | PASS | 1 labelled check(s) in cf1_a4_minimum_integration |
| U57 | A1 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U58 | A2 | PASS | 7 labelled check(s) in cf1_a2_lock |
| U59 | A3 | PASS | 21 labelled check(s) in cf1_a3_results |
| U60 | A3, A4 | PASS | 15 labelled check(s) in cf1_a3_results,cf1_a4_minimum_integration |
| U61 | A2, A3 | PASS (labelled SQL checks); lock probe NOT VERIFIED | 4 labelled check(s) in cf1_a3_results; A3 lock-probe script could not create its probe database |
| U62 | A6 | PASS | 3 labelled check(s) in cf1_a6_withdrawal |
| U63 | A5, A6 | PASS | 19 labelled check(s) in cf1_a5_exclusion,cf1_a6_withdrawal (+1 suite-declared BLOCKED sub-checks) |
| U64 | A0, A1 | PASS | 3 labelled check(s) in cf1_callback_final_advancement (+2 suite-declared BLOCKED sub-checks) |
| U65 | A5 | PASS | 6 labelled check(s) in cf1_a5_exclusion (+1 suite-declared BLOCKED sub-checks) |
| U66 | F3 (external) | BLOCKED | F3 not built |
| U67 | A4a | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
| U68 | A2 | NOT PROVEN | no suite check or concurrency script carries this gate id (may be covered under an untagged label) |
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

## Browser / E2E (Playwright matrix) - all BLOCKED, none run
Reason (exact): the process environment has **no Stripe TEST secret key or test connected account** (`E2E_STRIPE_TEST_SECRET_KEY`, `E2E_STRIPE_TEST_CONNECTED_ACCOUNT` unset), and every scenario in `docs/qa/cf1-acceptance-matrix.md` begins with a paid registration, so no scenario can reach its first assertion. A cf1c-qa Supabase stack, production build and Chromium were therefore **not started** (no point spending ~5 GB). Owner: owner/host (supply the TEST key and connected account in the environment). Affected: SCN-11.4a, 11.4b, 11.4b-cap, 11.5, 11.5b, 11.5c-locked/-started/-ballot/-cancelled, SCN-R80-R83, SCN-X1, SCN-X2, and the QA-A halves of U80-U83, U18. The specs also still need the real B wording in `CF1_UI` on first run.

## Verdict
No product defect found in this run. RB1 (b) is **not** established: the QA-A halves of U80-U83 did not run, and the gates marked NOT PROVEN above need their owners to tag or confirm a covering check.
