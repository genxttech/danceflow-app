# TW-4F QA baseline (Q1)

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
