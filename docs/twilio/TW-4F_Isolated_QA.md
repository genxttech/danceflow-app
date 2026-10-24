# TW-4F isolated regression QA (2026-10-21)

Purpose: run the TW-4F SQL / local-stack suites against a DISPOSABLE database stack, so a crash or leftover fixtures from one session can never contaminate another session's result, and so migration ORDER (R2a, PR #251, future R2b) can be tested without touching the shared QA stack.

## 1. The PostgreSQL signal 11 (root cause, reproduced)

**Finding.** The crash seen on the shared QA stack (`supabase_db_danceflow-e2e-qa`, image `public.ecr.aws/supabase/postgres:17.6.1.106`, PostgreSQL 17.6) is an infrastructure defect, not an application regression, and it is not specific to the TW-4R1 test.

**Trigger.** Any `permission denied for FUNCTION` error raised for the roles `anon`, `authenticated` or `service_role` kills the backend with signal 11 (and the postmaster restarts every backend: "all server processes terminated; reinitializing"). A permission error on a TABLE does not. Minimal reproduction, no application object involved:

```sql
create function public.f() returns int language sql as 'select 1';
revoke all on function public.f() from public, anon;
set role anon;
select public.f();        -- server closed the connection unexpectedly (signal 11)
```

**Bisect (all on a fresh container of the same image).**

| Variant | Result |
|---|---|
| image defaults | crash |
| `session_preload_libraries=` (supautils not loaded) | survives |
| `shared_preload_libraries=` and `session_preload_libraries=` both empty | survives |
| supautils loaded, `supautils.hint_roles=` (emptied) | survives |
| shared libraries without pgaudit / plpgsql_check / auto_explain / plan_filter / pg_stat_statements / pg_tle | not the cause (supautils still loaded) |
| stock `postgres:17` (17.9) with an equivalent role | survives |
| `public.ecr.aws/supabase/postgres:17.11.0.004` (newer supautils) | survives |

Conclusion: the `supautils` extension's `hint_roles` feature (it appends "Grant the required privileges ..." HINTs for the three API roles) segfaults when the denied object is a function in image 17.6.1.106. Fixed in the newer image. The shared stack's log shows the same `terminated by signal 11` after tw4sender, tw4a/tw4r1 and rollback runs.

**Why it looked like "contamination".** Every crash restarts all backends and drops in-flight transactions, so whichever suite was running failed with PGRST002 / "recovery mode" and left its fixtures behind. The crash is deterministic; the tests that provoke it are any that call a service-role-only function as an API role (the TW-4R1 "API roles cannot call runner functions" test is one; `tw4a` another).

**Mitigation in the isolated stack.** Postgres is started with `-c supautils.hint_roles=`. The canary test (`isolatedQa.canary.test.ts`) fails the run if that stops being true. The shared stack is NOT changed by this work; until it is rebuilt on a fixed image, do not run permission-denied-function suites against it.

## 2. Isolation strategy

- One disposable stack per instance: Postgres (Supabase image, own container) + PostgREST + Kong (`/rest/v1`), all labelled `df.isoqa=1` and `df.isoqa.owner=<pid>`, prefixed `df-isoqa-<instance>-`, on their own docker network `df-isoqa-net`. Only Kong publishes a port (127.0.0.1:56600-56799); Postgres is never published. Resource limits: database 1.5 GB / 2 CPUs, Kong 1280 MB / 1 CPU, PostgREST 256 MB (override with `ISO_QA_*` variables). Instance names carry the process id, so two harness processes can never collide.
- The harness refuses to touch a container without the label; the shared `supabase_*_danceflow-e2e-qa` / `-local-staging` stacks and other sessions' databases are never read or written. `down --all` removes only stacks whose owner process is dead (`--force` for the rest).
- Cross-process start lock plus a port-claims registry (holder pid, 30 minute expiry) make concurrent starts safe; every start asserts the port binding and the database health afterwards.
- Every vitest run gets its own TEMP directory, because the suites keep cross-process mutexes under `os.tmpdir()` (a shared one makes concurrent runs, and other sessions, wait on or inherit each other's stale locks).
- Kong keep-alive is raised (3600 s): a test that blocks the event loop in synchronous psql calls otherwise returns an empty-code network error on its next request.
- Baseline (`baseline` command): the production schema dump of 2026-07-15 (schema only, local and git-ignored: `backups/danceflow-production-pre-accounting-v1-2026-07-15.sql`; override with `ISO_QA_BASE_SCHEMA`), a bootstrap that supplies GoTrue-equivalent `auth.uid()/role()/email()/jwt()` (with an identity round-trip guard), then the repo's own migrations replayed from a git REF in version order (git add-time tie-break for date-only files), all-or-nothing per file, committed as the local image `df-isoqa/base:<cutoff>`. Nothing is copied from the shared database. 22 application migrations that cannot be replayed onto the July dump are listed with reasons in `scripts/qa/known-unreplayable.txt` (218 apply); a failure of any OTHER migration fails the baseline build, a stale entry errors, and the list refuses any TW-4F migration. See `TW-4F_Isolated_QA_Omissions.md`.
- Scenarios (`scripts/qa/scenarios.json`) apply further migrations from git refs, never from a working tree: `baseline` (through 20261205, no scenario migrations); `main` (origin/main in repo order: 20261207..20261217, then 20261206 from PR #251, merged after 1217, then 20261218..20261227; 1220 is unused); `numeric` (fresh-install order, 20261206..20261227). The earlier pre-merge scenarios (`main-then-pr251`, `pr251-then-main`, `pr251-mid`, `main-pr269`, `full-chain`) were retired because #251 and #269 are merged. **Completeness check:** every TW-4F (sms|twilio|tw4) migration above the cutoff that exists at a ref a scenario uses must be applied by the scenario or listed under `excluded`, otherwise the scenario refuses to start (exit 2). Both scenarios were checked against origin/main 84f52048 (21 migrations, none missing). The baseline itself stops at 20261205090000.

## 3. Commands and exit codes

```bash
node scripts/qa/iso-qa.mjs baseline                                   # once per baseline change
node scripts/qa/iso-qa.mjs selftest                                   # harness negative controls (pass/fail/skip/crash/ports/cleanup/ownership)
node scripts/qa/iso-qa.mjs run main -- src/lib/sms/twilioIsv/__tests__/localStack.r2a.test.ts
node scripts/qa/iso-qa.mjs matrix main --parallel 1                   # every local-stack suite (URL-gated and container-gated, section 6), one fresh database each
node scripts/qa/tw4f/run-chain.mjs rehearse --dry-run                 # manifest-order rehearsal plan and hash checks, no docker (section 7)
node scripts/qa/iso-qa.mjs compare pr251-then-r2a r2a-then-pr251      # catalogs of two migration orders (functions, tables, constraints, indexes, policies, triggers, views, ACLs)
node scripts/qa/iso-qa.mjs run r2a-r2b --tests-ref origin/twilio-r2b-number-activation -- <suite>
node scripts/qa/iso-qa.mjs repro                                      # the three-line signal-11 reproduction (crash / survive / survive)
node scripts/qa/iso-qa.mjs down --all                                 # remove isolated stacks of dead owners
```

| Exit | Meaning |
|---|---|
| 0 | all tests passed on a healthy database (matrix: every suite; compare: identical) |
| 1 | tests failed on a healthy database (compare: catalogs differ) |
| 2 | usage error |
| 3 | infrastructure failure: database or API container crashed, restarted, OOM-killed, never became ready, or a migration failed (never reported as a test result) |
| 4 | nothing ran / tests skipped / matrix incomplete (never green) |
| 6 | matrix only: not green, but every non-pass is explained in `scripts/qa/expected-results.json`: a KNOWN failure (every failing test listed) or an explained NON-RUN (a disposition: every test of the suite skipped). A listed suite that now passes is a stale expectation and fails the matrix (exit 1) |

Requires Docker, the images `public.ecr.aws/supabase/{postgres:17.6.1.106,postgrest:v14.8,kong:2.8.1}`, Node 20+. No network access to Twilio or any hosted database. Evidence per run: `<QA home>/runs/<time>-<instance>/` (vitest.log, postgres.log, result.json with provenance and failed-test names).

## 4. Known limits (read before trusting a PASS)

- Local / developer tool: the July dump is git-ignored, so CI cannot build the baseline. The CI check is limited to typecheck and lint of the harness-adjacent TypeScript.
- Not production-equivalent (22 omitted migrations, schema-only).
- Known failures that are not caused by TW-4F work: `tw4a` "TW-1/2 code is untouched", `tw4f1b` "evaluation events" (pins 14 runner functions, main has 16), R2a rollback test when R2b is applied (2BP01), `tw4sender` count 8 when main's version of the suite runs against #251's migration.
- Load sensitivity: `tw4recexec` (a wall-clock assertion, "expected N to be greater than 900"), `tw4recurring` (a 120 s test timeout) and `tw4payhardening` fail intermittently when other sessions saturate the shared host CPU; each passed in other runs of the same migrations (recexec 20/20, recurring 30/30, usage 26/26 in sequential reruns). They are reported as unexpected failures, never suppressed; rerun singly on an idle machine before treating one as a regression. `tw4payhardening` has a property test pinned at 90 s in the test file; it passes on an idle machine and times out (cascading to two later assertions in that file) when other sessions saturate the CPU. It is reported as a failure, not suppressed.
- `localStack.tw4fi` returns early (vacuously) when the pilot slot is already taken; `localStack.r2ci2` needs R2b migrations newer than the scenarios carry (it skips and the matrix reports that).

## 5. Results

> **Everything under this heading is HISTORICAL.** It records what earlier runs showed on earlier chains. None of it validates the current chain (through 20261230090000, and 20261231090000 / 20261231100000 once they merge). The first current-chain evidence is the full-chain rehearsal (section 7), which has not been run.

### 2026-10-23: `main` baseline at 6422e050 (HISTORICAL, not current-chain validation) (origin/main 6422e050, chain 20261207..20261217 incl. 1215; one test database at a time)

19/23 suites passed; 3 KNOWN explained (tw4a pin, tw4f1b function-count pin, R2a rollback after R2b); 1 unexpected: `localStack.r2b.test.ts` skips all 53 tests because its beforeAll refuses a database that has the real recurring-fee lifecycle (an R2b/RFL follow-up: that suite only runs on a partial chain). Not discovered by `matrix` (need their own databases/env): `localStack.tw4rfl`, `localStack.tw4rflops` (64/64 pass on a stock stack with `ISO_QA_MARKER=1 TW4RFL_DB=postgres`), `localStack.r2brfl`, `localStack.r2bp2.rfl`. Every stack now gets idempotent per-stack steps (auth.users `email_confirmed_at/banned_until/deleted_at`, `grant update, delete on outbound_deliveries to authenticated`); the shared baseline image is unchanged. Host at start: 82% CPU, 8.6/31.5 GB RAM free, 25 containers.

### 2026-10-21 (earlier chain)

- Catalog comparison (6,494 entries: functions with bodies, argument defaults, owner, security-definer, config, ACL; tables with columns, defaults, constraints, RLS, ACL; column ACLs; indexes; policies; triggers; views; sequences; enums; default ACLs): `main-then-pr251` = `pr251-then-main` = `pr251-mid` (0 differences each); `main` vs `main-then-pr251` differs only by #251's own objects (intended).
- Matrices (one fresh database per suite): all TW-4F suites pass except the known, explained items in `expected-results.json` and the load-sensitive `tw4payhardening` (section 4). R2b's own suite passes 41/41 in three sequential runs in two migration orders.
- Independent Opus review (read-only) of the harness: no false-PASS path found in crash detection; findings fixed in this PR: a failed start could remove another process's live stack (now removes only what the process owns), check/remove/create now happen under the start lock, matrix exit precedence (infrastructure/skips before stale expectations), known-failure matching (no skip, one phrase per failing test, exact count), vitest timeout and signal death classified as infrastructure, missing dump refused, scenario completeness check, argument defaults and column ACLs in the catalog fingerprint, audit reference is explicit. Not fixed (documented): `up` stacks are owned by the short-lived `up` process, so a concurrent `down --all` without `--force` can remove them (use `run`/`matrix`, which own their stacks, or `--force` discipline); the baseline image is not re-verified against the current ref sha (rebuild after migrations at or below the cutoff change).

Note (2026-10-23): section 5 results predate the #251/#269 merges and the 1218..1227 migrations. The harness (selftest, scenario completeness and a single-suite scenario proof on both `main` and `numeric`) was re-verified on the current chain. No full matrix run exists yet on the current chain (20261206..20261227); the last full run is the 6422e050 matrix above. The per-slice DB results are recorded in each merged PR. Order independence between `main` and `numeric` is checked with `compare main numeric`.

## 6. Matrix discovery and dispositions (2026-10-24)

**Discovery.** `matrix` used to grep for the `TW4A_LOCAL_URL` gate, which silently left out every suite that talks to the database container directly. It now also runs every suite declared in `scripts/qa/matrix-suites.json`, each on its own fresh stack with the environment it needs (`env`, where `{DB}` is the stack's database container, and `marker` for the `tw4_local_qa_only` table). Declared: `tw4rfl`, `tw4rflops`, `tw4rfld5`, `tw4rflevid`, `tw4rflspend`, `r2brfl`, `r2bp2.rfl`, `f1funding`, `f5canceltarget`, `j4activation`, `f4recovery`, `tw4a9`. A `localStack.*.test.ts` file at the tested ref that has neither the URL gate nor an entry in that file makes the matrix refuse to start (exit 4, "incomplete"), so a new suite can never be left out unnoticed. `run` accepts `--env KEY=VALUE` (repeatable) and `--marker`. Of these, only the four named in the 2026-10-23 record (`tw4rfl`, `tw4rflops`, `r2brfl`, `r2bp2.rfl`) have been run on this harness before; the other eight are newly discovered and unvalidated on the current chain, and a failure there is a real failure until explained.

**Scenarios.** `main` and `numeric` stopped at 20261227, so on current `origin/main` the completeness check refuses to start them (1228, 1229 and 1230 exist at the ref). They now include `20261228`, `20261229` and `20261230`. When 20261231090000 (slice A) and 20261231100000 (slice B) merge, the tracker/manifest sync PR (phase 2) adds them to both scenarios; until then the harness refuses, by design.

**Dispositions.** Each state below is shown by the matrix and never counts as a pass; the exit code can reach 6 at best, never 0.

| Suite | State | Reason | Recorded in |
|---|---|---|---|
| `localStack.r2b` | SKIPPED-by-design (a disposition) | All 53 tests skip on the full chain (`main`, `numeric`): its `beforeAll` refuses a database that has the real recurring-fee lifecycle (20261209+). It only runs on a partial R2b chain with the RFL stand-ins. Full-chain coverage is carried by `r2brfl`, `tw4rfl` and `tw4fj1`. The matrix prints `SKIP*`. A run in which anything passed, failed, or ran no tests is not covered by the disposition. | `expected-results.json` `dispositions` |
| `localStack.r2bp2.rfl` | KNOWN (KI-3) | Fails on plain `main`, deterministically. Probable cause, **unconfirmed**: `tw4_rfl_alerts_claim` returns nothing while the RFL delivery kill switch is off (fail closed since 20261211) and the test never turns delivery on. The tracker records 2 of 3 tests failing; only "the real outbox's own runner can claim and finish what P2 raised" (the Q1 observation) is listed, so any other failing set is reported as FAIL. **Not fixed**: the cause is unconfirmed and a fix needs a platform-admin actor fixture, so the test is documented, not edited. Never change the fail-closed function to make it pass. | `expected-results.json` `known` |
| `localStack.tw4fj1` | was BLOCKED-by-harness; the harness gap is closed, result UNVERIFIED | Its first `beforeAll` assertion needs the `tw4_local_qa_only` marker table, which `matrix` did not create for URL-gated suites, so the suite failed in `beforeAll` regardless of the code (and the scenarios lacked 1228..1230). `matrix-suites.json` `urlSuiteOptions` now sets `marker` for it. No run on the fixed harness exists yet; until one passes, treat it as not proven. | `matrix-suites.json` |

Retained KNOWN failures (unchanged): `tw4a` pin, `tw4f1b` function-count pin, `r2a` rollback after R2b, `tw4payhardening` (flaky, performance-bound).

## 7. Full-chain rehearsal (prepared, NOT yet run)

One command, on a fresh isolated stack, driven by the hosted manifest rather than by directory order:

```bash
node scripts/qa/iso-qa.mjs baseline --cutoff 20261118090000                 # once: pre-TW-4F baseline image df-isoqa/base:20261118090000
node scripts/qa/tw4f/run-chain.mjs rehearse --dry-run                        # plan + hash checks, no docker (safe anywhere)
node scripts/qa/tw4f/run-chain.mjs rehearse                                  # steps (a)-(d) only
node scripts/qa/tw4f/run-chain.mjs rehearse --matrix --exclusive             # steps (a)-(e); owner-scheduled window, no other stack running
```

1. **(a) Apply in manifest section 4 order** (read from the manifest at `--base`, default `origin/main`; tokens such as `1119_092100`, `[1215, merged]`, `1231` and `1231b` = 20261231100000 are understood). Before any SQL runs, each forward file's LF-normalised sha256 and its rollback's sha256 must equal the manifest row, every order entry must have a row and exactly one file, and every TW-4F file in range on the ref must be in the order; `verify_manifest_hashes.sh` must also pass. Any mismatch exits 1 without touching docker.
2. **(b)** The catalog fingerprint is recorded after every file (count and sha256 per step in `rehearsal-steps.json`; the forward-final fingerprint is saved in full).
3. **(c) Strict reverse rollback.** After each rollback the catalog must equal the one recorded before that file was applied; at the end it must equal the baseline fingerprint. A rollback that refuses or fails is a FAIL. The only tolerated difference is the documented KI-2 residue (three widened CHECK constraints), which makes the result KNOWN (exit 6), never green.
4. **(d) Re-apply** in order; each step must equal its first-apply fingerprint.
5. **(e) `--matrix`**: `iso-qa.mjs matrix main --parallel 1` at the same commit. Requires `--exclusive` (no other isolated stack running) and a scenario `main` that equals the manifest chain (otherwise exit 1 before anything starts; this is what forces the 1231/1231b scenario update in phase 2). The exit code is the worse of the structural and matrix codes; the matrix is "NOT RUN" when the structural stages did not pass.

Exit codes: 0 all green; 1 failed (including a hash mismatch); 3 infrastructure (an apply/rollback error with an unhealthy database is INFRA, not FAIL); 5 plan only (`--dry-run`, `matrix --plan-only`: nothing ran); 4 BLOCKED (host-load rule: another isolated stack is already running beyond the allowed number, or any with `--exclusive`); 6 only KNOWN items. Host-load rule: at most 2 isolated stacks across all sessions.

Offline proof: `node --test scripts/qa/tw4f/rehearsalPlan.test.mjs` (order and hash parsing, plan cross-checks including the 1231/1231b tail, KI-2 masking, and the PASS/KNOWN/FAIL decision).

Limits (read before trusting a rehearsal PASS):

- The fingerprint covers the public-schema catalog (functions, tables, constraints, indexes, policies, triggers, views, ACLs), **not row data**. A migration that inserts a config or switch row and a rollback that forgets to delete it would not be seen. Row-level checks stay in the per-migration suites.
- KI-2 is masked only when one of the three named constraints exists on both sides with a different definition (widened). A dropped, missing or new one is a FAIL.
- `--matrix` runs the suites with `ISO_QA_REF_MAIN` set to the rehearsed commit, so the matrix applies the same SQL that the structural stages checked; `ISO_QA_MARKER` from the caller's environment is cleared (the marker is per-suite, from `matrix-suites.json`).
- The host-load gate counts every `df-isoqa` and `df-q1` database container; the older `verify_manifest_hashes.sh` cross-check is opt-in (`--shell-verify`, very slow on Windows).
- Matrix discovery without `--tests-ref` reads the working tree for URL-gated suites and HEAD for container-gated ones: commit new `localStack.*.test.ts` files before running, or pass `--tests-ref`.
