# CF1 Integration-5 closeout (2026-11-07)

Status: LOCAL evidence only. Nothing in this document was applied to DEV or PROD, pushed, merged or deployed. All CF1 PRs stay draft. OD-17 stays disabled for live events.

Tested baseline: `cf1/integration-5` at `e84d535b` (composed runs). Later commits on the branch change only the test runner, test scripts and RB4 documentation (listed in section 7); no migration SQL changed after `e84d535b`.

## 1. Composed run on `e84d535b` (raw reports: `cf1-rb4-int5/evidence_composed_r2_e84d535b.txt`, `..._nor2_e84d535b.txt`)

| | R2 chain | no-R2 chain |
|---|---|---|
| Suites passed | 29 of 29 | 27 of 29 |
| Composed-result counts | 40 PASS, 0 FAIL, 0 NO VERDICT, 1 NOT VERIFIED | 37 PASS, 1 FAIL, 2 NO VERDICT, 1 NOT VERIFIED |
| Apply (A1..RB3R), OD-17 apply, additive-only, second-apply refusal | PASS | PASS |
| OD-17 rollback exactness and reapply | 0 diff lines | 0 diff lines |
| F3 apply | PASS | PASS |
| Reverse rollback (F3, OD-17, RB3R..A0, A1) vs pre-CF1 | 0 fingerprint diff lines | 0 fingerprint diff lines |
| Reapply vs first composed apply | 0 diff lines | 0 diff lines |
| Expected-mode precheck | PASS (`r2_ledger`) | PASS (`absent`) |
| OD-17 OFF identity (verdicts with vs without OD-17) | 0 differing lines | 0 differing lines |

The no-R2 failures are exactly the three R2-dependent items: RB3 NO VERDICT, RB3R NO VERDICT, RB3R concurrency FAIL. They are recorded as they happened. Section 3 changes only how the runner classifies them in future runs; the evidence above is unchanged.

Per-suite counts on the R2 chain: A1 136 (5 blocked), A0 199 (5), A2 35 (0), A3 119 (4), A4a 63 (2), A5 186 (4), A6 247 (3), A7 81 (1), A4 55 (3), A0 tie 96 (1), A5 U38 14, RB3 76 (4), RB3R 100 (3), F3 191, U66 57 (1), OD-17 59; HL1 42, E2 211, E2 P1FIX 10, F2 198, O1 95, SS1 adv 13, SS1 lock 36, NS1 152, CX1 15, K1 23, REG 80, P10D 79, P10D.1 22.

## 2. Findings closed in Integration-5

* Rollback P1 (reviewer, SECFIX-3): the `101000` rollback lost its `where` keyword. Restored in `e84d535b`; the restored `_cf1_revoke_advancement` body was diffed against the `090000` body (identical). The composed run on `e84d535b` reverse-rolls back with 0 fingerprint diff lines.
* P2-a (advancement revocation audit attribution): fixed. The correction trigger requires `from_state = old.status`; `_cf1_revoke_advancement` takes only a correction-opening edge (`from_state` in calculated / approved / published) and tie-breaks on id. A newer rival lock row (active to ballots_locked) or U66 recovery row (ballots_locked to ballots_locked) can no longer supply the request id or reason. Failing first: the new `revoke P2-a` check and the existing revocation-reason check both failed on the old lookup; the advancement suite passes (199 checks, 5 blocked). Edited in place in unapplied migrations (hosted catalog check 2026-11-07 ~14:00Z found no CF1 object on DEV or PROD).
* P2-b (expected ledger mode): fixed. See section 5.
* P2-c (A3 non-applicable check): fixed, now BLOCKED, same in A2.
* Earlier in the integration: A7 same-transaction misattribution (A7 trigger `from_state` filter, suite 5d), A3 approve-refusal exact reason, catalog-based ledger mode with an agreement check, A2 helper without SECURITY DEFINER.
* Open P0/P1/P2: none known.

## 3. No-R2 classification (this phase)

`run_cf1_od17.sh` + `run_cf1_od17_lib.sh`: RB3, RB3R and the RB3R concurrency script report NOT APPLICABLE (original output kept in the log, counted in a new `NOT APPLICABLE` total) only when `EXPMODE=absent` AND the catalog shows no ledger AND `_cf1_refund_evidence_mode()` is `absent`. On an R2-required chain the same result stays FAIL / NO VERDICT; any other suite is never reclassified. `test_run_cf1_od17_classification.sh` covers 13 cases, all pass (R2-required suites on R2 chain keep their verdict; R2 required but missing keeps the verdict; inconsistent catalog/code state fails closed; only rb3/rb3r/RB3R are reclassifiable). The runner's exit code still fails on any FAIL or NO VERDICT outside the NOT APPLICABLE set.

Not rerun as a whole: the next composed run (not done in this phase, by instruction) will show the new `NOT APPLICABLE` counts.

## 4. A3 concurrency probe: harness defect, not a database failure

Root cause: the runner patched `run_cf1_a3_locks.sh` with `sed` before running it. Since the probe's retry loop became one psql session, the `sed` rule replaced that line with `:` and the probe never created its `a3probe` database ("cannot create a3probe"), so all nine values were missing. Evidence: `runs_r2/a3_conc.out` contained only that message.

Fix: the runner now runs the probe as shipped through `concurrency/verify_cf1_a3_locks.sh`, which judges the nine expected `RESULT` lines from the probe's own stdout (no mixing with kept intermediate files) and reports PASS / FAIL / NOT VERIFIED.

Independent run on a fresh R2 chain (R2 + A1..RB3R + F3, OD-17 not applied): all nine values equal the expected ones, verdict `CONC A3: PASS (9/9 probe values)` (`evidence_a3_probe_verdict.txt`, `evidence_a3_probe_results.txt`). Limits: not re-run inside the full composed runner, not run on the no-R2 chain, not run with OD-17 applied. The composed A3 line will change from NOT VERIFIED to PASS only when the runner itself runs it.

## 5. Expected-mode enforcement

* Runner precheck (before any suite): catalog ledger and `_cf1_refund_evidence_mode()` must both equal the mode the run requires; otherwise exit 6.
* Negative test of the runner itself (`evidence_expected_mode_negative.txt`): `CF1_TEST_SKIP_R2=1` runs the real `run_cf1_od17.sh` in mode `r2` without applying R2. Apply, rollback and reapply passed, then `EXPECTED MODE (r2_ledger): catalog ledger=f, _cf1_refund_evidence_mode()=absent FAIL -- the chain is not in the mode this run requires; no suite verdict is valid`, exit status 6, zero suite lines. The hook only makes the run stricter (it removes the R2 apply); the production path is unchanged.
* Suite level: A1, A2, A3 fail when `:expected_mode` differs from the catalog, and report BLOCKED when it is not supplied (negative tests on R2 and no-R2 containers recorded in the session; R2 required but absent: FAIL in all three).

## 6. RB4 (local) — evidence `cf1-rb4-int5/evidence_rb4_int5.log`, script `cf1-rb4-int5/rb4_int5.sh`

Disposable container from `cf1od17-chain:base` (chain through HL1), R2 then every CF1 migration in order.

| # | Item | Result |
|---|---|---|
| 1 | Apply R2 + 14 CF1 migrations in order, function snapshot after each | PASS (1036 to 1155 public functions) |
| 2 | Each reverse rollback restores the state before its migration (function snapshot and full fingerprint) | PASS, 14 of 14, 0 diff lines each |
| 3 | Reapply equals first composed apply | PASS, 0 diff lines (fingerprint and function snapshot) |
| 4 | Pin coverage (118 md5 literals in 2027 migrations, rollbacks and competition suites) | 89 found in applied snapshots, 29 not found. Every CF1 file's pins are found. All 29 not found are pre-states of pre-CF1 migrations (K1, F2, NS1, CX1, HL1, with their rollbacks and K1 test); they cannot appear because the base image already contains those migrations. Those pre-states were covered by the 2026-11-05 RB4 (110 of 115 found). Not re-verified here. |
| 5 | Pre-CF1 function surface survives the CF1 chain | PASS: 1003 functions, 0 missing, 0 changed owner or ACL |
| 6 | Data-present rollback (seeded by the A0, A6, A5, A7, A4, A0tie, F3, U66, RB3R, OD-17 concurrency scripts) | see below |
| 7 | App-first | see below |

Data-present rollback (448 public tables content-hashed before and after each attempt; seeded evidence rows: OD-17 audit 6, RB3 reconciliations 5, correction causes 17, final withdrawals 2, publications 13, advancements 2, exclusions 18; business/financial rows: orders 4, order items 3, refunds 3, refund allocations 3, registrations 5, competition entries 203, payments 0):

* REFUSED with the documented message and nothing changed (0 content changes, 0 dropped tables, 0 fingerprint diff lines): F3, OD-17 (audit rows), RB3R (5 reconciliation rows), U66, A7, A6, A5, A3, A0, A1.
* APPLIED while data was present: RB3 (`102000`, dropped only the empty `competition_cf1_rb3_gate_overrides`), A0 review fixes (`101000`), A2 (`092000`), A4a (`091000`). No table changed content; none of the business or financial tables changed.
* Policy consequence: CF1 evidence is append-only, rollback with evidence present is refused by design; the supported path is roll forward. This test did not exercise any export-and-clear path (none is documented as safe for the append-only tables) and the four rollbacks that applied did so out of order, with later packages still installed, so the resulting schema is not a supported state. They show only that no retained data was altered.
* Limit: the seeded financial data is small and synthetic (no `payments` rows).

App-first:

* Pre-CF1 function surface (item 5): every function that existed before CF1 is still present with the same owner and ACL after the CF1 chain. This supports "SQL before app" for an unchanged pre-CF1 app, but signature and owner/ACL equality does not prove that return shapes are unchanged.
* CF1 app on a rolled-back schema: `rollbackSchema.cf1rb4.test.ts` (new, vitest, passes with the existing `pageLoadError` tests, 29 tests) shows PGRST202 / 42883 on any secondary or primary read throws the generic "Could not load this page" error, never a 404, never a page without its safety panels, never the raw message. So with the new app still deployed and SQL rolled back, the results page is unavailable (fails closed); this is why the order is app first, then SQL.
* NOT VERIFIED: a browser or running-app test of either direction in this phase.

## 7. Commits after `e84d535b` (no migration SQL)

Runner and test changes (`run_cf1_od17.sh`, `run_cf1_od17_lib.sh`, `concurrency/verify_cf1_a3_locks.sh`, `test_run_cf1_od17_classification.sh`), the new vitest file, `docs/qa/cf1-rb4-int5/*` and this document.

## 8. Remaining blockers

* RB4: hosted read-only catalog verification is prepared but NOT approved or run (`docs/qa/cf1-rb4-hosted-readonly-request-2026-11-07.md`). Browser-level app-first and a larger financial-data rollback test are not done. Pins for pre-CF1 migrations were not re-derived from a pre-competition base.
* RB3: refund evidence for external / desk / legacy refunds (no ledger) needs an owner decision; without R2 the RB3 gate refuses (mode absent).
* RB1(a), RB2: unchanged since earlier status; not re-verified in this phase.
* A3 concurrency: PASS standalone; not yet re-run inside the composed runner.
* Merge sequence still needs owner approval (nothing merged or pushed).

## 9. Owner-decision register (preserved; no product policy was chosen to make a test pass)

Classification is a proposal for the owner. "Blocks next merge" means the shipped (dark) code embeds a behavior the owner has not decided; "Later release gate" means the code is dark or flag-gated and the decision is needed before enabling.

| Decision | Proposed class |
|---|---|
| F1 partial exclusion semantics (OD-F1-1/2/3, F1 P2-5) | Blocks the F1 PR merge (engine behavior ships in it) |
| F1 `6e75d95d` hunk (X-5: an entry excluded as scratched/no-show skips the one-heat coverage check) | Must be carried into the F1 PR branch `competition-f1-studio-engines` (`7886e830`, lacks it) before that PR merges; it is already in `cf1/int4-f1a3` and `cf1/integration-5` |
| K0 reversal | Later release gate |
| Ballot reopen after U66 | Later release gate |
| Public-results setting; public `excluded` list; unlisted-event entrant visibility | Later release gate (before publication) |
| U66 manager UI button | Later release gate |
| RB3 external / desk / legacy refund evidence path | Later release gate for public Competition registration |
| OD-17 rollout and flag ownership | Later release gate (OD-17 stays disabled) |
| RB3R co-sign identity check | Later release gate |
| Kong 15 s idle trial | Later release gate |

Absolute paths in some older QA docs are still present (docs only).

## 10. Where the evidence lives

`docs/qa/cf1-rb4-int5/`: `rb4_int5.sh`, `pins_int5.mjs`, `fn_md5.sql`, `fp_ext.sql`, `tbl_md5.sql`, `evidence_*`, `hosted/` (request SQL and expected values, nothing executed against a hosted database).

## 11. Addendum: fingerprint script defect (found by Workstream B, 2026-11-08)

`fp_ext.sql` had a type error on its function-volatility line (`text || "char"`), fixed in both copies (`cf1-rb4-int5/` and `cf1-rb4-run/`). In the RB4 integration-5 run (section 6) every fingerprint call logged that error silently, so those fingerprints lacked the `prosecdef` / `proconfig` / volatility (`Z`) lines. The function md5s (full `pg_get_functiondef`) already include SECURITY DEFINER, SET options and volatility, and the runner's own `fp.sql` is unaffected, so the rollback and reapply conclusions stand; the extended lines will be restored when RB4 is rerun on the hosted-equivalent baseline.
