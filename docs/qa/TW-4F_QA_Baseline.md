# TW-4F QA status (Q1), current at main 84f52048 (2026-10-23)

Main now contains every TW-4F pilot PR (#251 #269 #288 #290 #277 #280 #276 #278 #279 #294 #296 #298 #300); migrations run 20261206..20261227 (1220 unused; 21 files, each with a rollback, no CRLF, checked statically). Everything below the line "Historical" is dated evidence and is NOT re-run on this main.

## What Q1 actually executed, and what is still BLOCKED

| Item | Evidence | Status |
|---|---|---|
| Chain apply / extras rollback / re-apply for #276 (1222), #277 (1218), #279 (1224), #280 (1219), #288 (1221) on main 78bc699c | Run 2 below, branch heads at that time | PASS per slice. Not re-run on 84f52048 (1223, 1225, 1226, 1227 and the later PRs were not chain-checked by Q1) |
| r2a, main vs J1 (#278) | Run 2 below | identical 25/26 with the single known R2a rollback refusal (2BP01): no J1 regression |
| tw4rfl 87/87, r2brfl 28/28 | Run 2 below, main 78bc699c | PASS at that main |
| r2bp2.rfl (KI-3) | Run 2 below, failed twice on an idle host | FAIL on main 78bc699c, listed as KNOWN in known-failures.json (probable stale-test cause, unconfirmed); not re-run |
| Rollback of the whole chain restores the baseline catalog | Run 1 and 2 | FAIL: three CHECK constraints stay wider (pre-existing at main, no slice adds more). Owner decision pending |
| Per-slice DB results recorded in each merged PR (F1, F3, F4, F5, J1, J2, J3, J4) | those PRs | Not re-run or verified by Q1; read them there |
| Browser E2E (all tw4f-*.spec.ts) | none | BLOCKED: no auth-capable isolated stack (GoTrue/TOTP). The UIs exist on main; the specs are test.fixme with that single reason (cancellation also needs a second platform-admin fixture). The activation console spec (J4) is the owner's |
| r2b on the merged chain | none | BLOCKED by design (it refuses the merged chain; runs only on a partial chain) |
| Suites #266 verified (tw4payhardening, tw4rflops and the list in its notes) | #266 | not duplicated here |
| Original full matrix (Run 1) | historical, 7 of 25 suites on a saturated host | superseded by #266's matrices; do not use as a release gate |

Reproduce: see scripts/qa/tw4f/README.md; known environment items: scripts/qa/tw4f/known-failures.json.

---

# Historical, at 960a9d02 (Run 1) and 78bc699c (Run 2). Not re-run on current main.

## Run 1: baseline at 960a9d02 (2026-10-22)

Base: `origin/main` 960a9d02. Date: 2026-10-22. Runner: `scripts/qa/tw4f/run-chain.mjs` (see `scripts/qa/tw4f/README.md`).
Environment: Windows 11 host, Docker, dedicated containers (`df-q1-*`, own network, label `df.tw4fq1=1`), baseline image `df-isoqa/base:20261205090000` (id 00748f0063e6, built by PR #266's harness: July production schema + repo migrations through 20261205), Postgres image `public.ecr.aws/supabase/postgres:17.6.1.106` with `supautils.hint_roles=` (signal-11 mitigation from `TW-4F_Isolated_QA.md`), PostgREST v14.8, Kong 2.8.1, Node v24.14.1. Migrations applied on top of the image, from git: 20261207 20261208 20261209 20261210 20261211 20261212 20261213 20261214 20261216 20261217 (20261120..20261205 are inside the image; 1206 = PR #251 and 1215 = PR #269 are not on main).

**Host condition (affects every timing and the load-sensitive results):** during the run the host was at 100% CPU with about 0.5 GB of 31.5 GB RAM free (other sessions' ~40 containers). Timings are therefore 3-10x slower than an idle host and the matrix below is INCOMPLETE; it must be re-run on an idle host before it is used as a release gate.

## Reproduction

```bash
git fetch origin
node scripts/qa/tw4f/run-chain.mjs chain  --label main                  # apply -> rollback -> re-apply, fingerprints
node scripts/qa/tw4f/run-chain.mjs suites --label main                  # all localStack suites, serial, fresh DB each
node scripts/qa/tw4f/run-chain.mjs suites --suite localStack.tw4usage   # one suite
```
Per-suite command (what the runner executes, cwd = detached worktree of the ref, env `TW4A_LOCAL_URL`, `TW4A_LOCAL_JWT_SECRET`, `TW4A_LOCAL_DB_CONTAINER`, `TW4_ISO_QA=1`): `node node_modules/vitest/vitest.mjs run --no-file-parallelism --testTimeout=60000 --hookTimeout=120000 <file>`.

## QA matrix: migration chain (executed)

| Workflow | Environment | Execution | Expected | Observed | Result |
|---|---|---|---|---|---|
| Baseline image reachable (tw4_ functions present) | dedicated container | script | present | 6115 catalog entries | PASS |
| Apply main chain 1207..1217 | dedicated container | script | no SQL error | 10 migrations, 19-61 s | PASS |
| Reverse rollback of all 10 | same | script | no SQL error | all 10 rollback files ran | PASS |
| Catalog after rollback == baseline catalog | same | fingerprint (CRLF-normalised bodies, ACLs, constraints, policies...) | identical | 3 constraint differences (below) | FAIL (finding) |
| Re-apply == first apply | same | fingerprint | identical | 0 differences | PASS |
| Second rollback/apply cycle == first apply | same | fingerprint | identical | 0 differences | PASS |

Rollback finding (not an application defect, a rollback-completeness gap): after rolling back 1207..1217 three CHECK constraints stay wider than the baseline: `studio_sms_approval_refs_shape` and `studio_sms_approval_refs_source_check` still accept `number_selection`, and `studio_sms_onboarding_audit_action_check` still lists the later `rfl_*`, `runner_*`-era action names. This is safe (a widened allowlist) and probably deliberate (narrowing would fail if rows exist), but the rollbacks do not restore the pre-migration catalog. Owner decision needed (document as intentional, or narrow when no row uses the value). The `source_check` pair also differs textually (`ARRAY[...]` vs `'{...}'::text[]`), which is cosmetic.

## QA matrix: localStack suites (serial, fresh clone of the applied chain per suite)

| # | Suite (src/lib/...) | Execution | Result | Tests | Seconds | Note |
|---|---|---|---|---|---|---|
| 1 | billing/localStack.tw4f3bpay | executed | PASS | 18/18 | 368 | |
| 2 | billing/localStack.tw4f3bui | executed | PASS | 7/7 | 74 | |
| 3 | billing/localStack.tw4monthly | executed | PASS | 28/28 | 1078 | |
| 4 | billing/localStack.tw4payhardening | executed | FAIL (known, load) | 12/15 | 465 | property test timeout (90 s) and 2 cascaded assertions; passes on an idle host per #266 |
| 5 | billing/localStack.tw4recexec | executed | FAIL (known, load) | 19/20 | 716 | wall-clock assertion "expected 180 to be greater than 900"; passes 20/20 on idle host per #266 |
| 6 | billing/localStack.tw4recurring | executed | BLOCKED (infra) | 0/0 | 1888 | test process hit the 30-minute cap (ETIMEDOUT) under CPU saturation; no result |
| 7 | sms/localStack.tw4inbound | executed | PASS | 28/28 | 1041 | |
| 8 | sms/localStack.tw4recon | interrupted | BLOCKED | - | - | run stopped by the operator when the host stayed saturated |
| 9-25 | sms/tw4sender, sms/tw4usage, sms/onboarding/tw4a, sms/provisioning/r2ci1, r2ci2, sms/twilioIsv/feeres, r2a, r2b, r2bp2.rfl, r2brfl, tw4f1b, tw4f3a, tw4f3b0, tw4fi, tw4r1, tw4rfl, tw4rflops | not run | BLOCKED | - | - | not executed in this baseline; nothing is claimed about them. Expected known items from PR #266 (`expected-results.json`): tw4a "TW-1/2 code is untouched", tw4f1b evaluation-events pin (14 vs 16 runner functions), r2a rollback test (2BP01 once R2b is applied) |

Known environment items are in `scripts/qa/tw4f/known-failures.json`; the runner reports a suite as KNOWN only when every failing test matches a listed phrase. The `outbound_deliveries` authenticated-grant gap on the isolated image was not exercised (no suite that hits it was reached); it remains to be recorded when `tw4sender`/`tw4usage` run.

## QA matrix: browser E2E

| Workflow | Environment | Execution | Result | Note |
|---|---|---|---|---|
| `tw4f-admin-panel-smoke` (fixture seeding + existing admin panel + tenant isolation) | needs local dev server + auth-capable local stack + `TW4_ISV_FAKE=on` | not executed (typecheck only) | BLOCKED | the isolated harness has no GoTrue, so platform-admin TOTP sign-in cannot run on it; running against the shared `supabase_*_danceflow-e2e-qa` stack was not done. Needs an `iso-qa up` stack with an auth service or an owner decision to use the shared e2e stack |
| owner journey (J2), number selection (J3), R2a/R2b run (J1), recovery (F4), cancellation (F5), activation refusal (F1/F3) | - | `test.fixme`, UI absent | BLOCKED | owners and requested `data-testid`s are in each spec header |

## Not claimed

No Wave 1 slice branch had been pushed when this was written, so no slice run exists yet; run the commands in `scripts/qa/tw4f/README.md` with `--extra-branch <branch>` when each lands. Combined-order checks (1218+1219 etc.) depend on F1 and F3 branches.

---

## Run 2: exclusive slot (2026-10-23), main 78bc699c (includes 1206 and 1215)

Harness: PR #266's `iso-qa.mjs` (head ffb4ac10, detached checkout, `main` scenario = 1207..1217 + 1215 + 1206 applied last), one fresh database per suite, serial, unique `q1s<pid>-*` names, tests from `--tests-ref origin/main` (or the named branch). Chain checks: `scripts/qa/tw4f/run-chain.mjs chain --base origin/main --extra-branch origin/<branch>` on the baseline image. Before each suite no other TW-4F DB container was running (only the two shared `supabase_*` stacks). Host per suite (CPU % / free GB / containers, start -> end): tw4rfl 34%/8.4/22 -> 25%/11/22; r2brfl 7%/11/22 -> 28%/10.7/22; r2bp2.rfl 17%/10.7/22 -> 20%/10.7/22 and again 36%/10.8/22 -> 36%/10.7/22; r2a (main) 76%/7.9/22 -> 69%/7.9/22 and r2a (J1) 74%/7.8/22 -> 71%/7.6/22 (those two ran during unrelated website work). No result below is a timeout or a skip.

Two false starts are recorded rather than hidden: the first attempts of tw4rfl/r2brfl/r2bp2.rfl were SKIPPED (87/28/3 skipped) or exit 3, because (a) the detached #266 checkout had no `node_modules` link (infrastructure, exit 3), (b) the suites were run from #266's tree instead of `--tests-ref origin/main`, (c) `tw4rfl`/`r2brfl` need `ISO_QA_MARKER=1` (their `beforeAll` asserts the `tw4_local_qa_only` marker table; without it every test shows as skipped) and (d) `r2bp2.rfl` reads `TW4A_RFL_DB_CONTAINER`, not `TW4A_LOCAL_DB_CONTAINER`. Those runs are not counted.

| Suite | Environment | Command shape | Expected | Observed | Result |
|---|---|---|---|---|---|
| localStack.tw4rfl | iso-qa `main`, fresh DB | `iso-qa run main --tests-ref origin/main -- <file>` with `TW4RFL_DB=postgres ISO_QA_MARKER=1` | all pass | 87/87 | PASS |
| localStack.r2brfl | same | same env | all pass | 28/28 | PASS |
| localStack.r2bp2.rfl | same, `TW4A_RFL_DB_CONTAINER=df-isoqa-<name>-db`, `ISO_QA_MARKER=1` | same | all pass | 2/3, run twice, same failure both times (idle host, not a timeout): "the real outbox's own runner can claim and finish what P2 raised" (`expected +0 to be 2` at line 67) | FAIL (main; real, not resource) |
| localStack.r2a, tests from main | iso-qa `main`, fresh DB | `--tests-ref origin/main` | 26 pass (R2a rollback test is a known refusal) | 25/26; only failure: "rollback parses and completes where there is no evidence" | KNOWN (R2b objects depend on the R2a ledger, 2BP01; listed in #266 expected-results) |
| localStack.r2a, tests from J1 (#278, 629e7314, no SQL) | same, fresh DB | `--tests-ref origin/claude/twilio-tw4f-j1-admin-orchestration-c57e64` | same as main | 25/26, the identical single failure | KNOWN, identical to main |

**#278 control:** r2a gives the identical result on main and on J1's branch (25/26, same single known failure), so J1 introduces no r2a regression; the failures J1 saw came from its non-standard harness.

**New main finding (r2bp2.rfl):** likely cause, from reading migration 20261211 (not confirmed by toggling the switch): `tw4_rfl_alerts_claim` has returned nothing while the delivery kill switch is off (fail closed, absence of an audited row = OFF) since the RFL-ops migration, and the test claims without turning delivery on. That would make the test stale relative to the fail-closed behaviour, not an application defect, but it is a failing suite on main; owner of r2bp2.rfl/RFL ops should decide whether to fix the test (switch delivery on in setup) or the function.

### Chain checks against origin/main 78bc699c (1206..1217 + 1215), idle-ish host (apply of 12 migrations 6-7 s)

| PR | Branch head | Extra migration | Apply | Rollback extras == main-only catalog | Re-apply == first apply | Rollback all == baseline | Second cycle | Result |
|---|---|---|---|---|---|---|---|---|
| #276 J2 owner read | d99f42a0 | 20261222090000 | PASS | PASS (0 diff) | PASS | FAIL (same 3, pre-existing) | PASS | PASS for the slice |
| #277 F3 recon gate | 94bc0a1f | 20261218090000 | PASS | PASS | PASS | FAIL (same 3) | PASS | PASS for the slice |
| #278 J1 orchestration | 629e7314 | none (no SQL) | PASS | n/a | PASS | FAIL (same 3) | PASS | n/a, main chain only |
| #279 F5 release adapters | 57780760 | 20261224090000 | PASS | PASS | PASS | FAIL (same 3) | PASS | PASS for the slice |
| #280 F1 funding | 4046b8f6 | 20261219090000 | PASS | PASS | PASS | FAIL (same 3) | PASS | PASS for the slice |
| #288 F4 recovery | f68321ca | 20261221090000 | PASS | PASS | PASS | FAIL (same 3) | PASS | PASS for the slice |

"Rollback all == baseline" fails identically on main alone and with each slice: the three CHECK constraints in the earlier finding (`approval_refs_shape`, `approval_refs_source_check`, `onboarding_audit_action_check`) stay wider after rollback. None of the slices adds a new difference, so the runner's exit 1 here is that known main-level gap, not a slice defect. The combined orders (e.g. 1218+1219) were not run in this slot.

### Still not covered by Q1 (by agreement)

tw4payhardening and tw4rflops (verified by #266), the other suites listed as verified by #266 on 1207..1217, r2b (refuses the merged chain by design), and the browser E2E smoke (no auth-capable isolated stack; see the E2E table above).
