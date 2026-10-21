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

- One disposable stack per scenario instance: Postgres (Supabase image, own container) + PostgREST + Kong (`/rest/v1`), all labelled `df.isoqa=1`, prefixed `df-isoqa-`, on their own docker network `df-isoqa-net`, host ports 56600-56799 on 127.0.0.1. The harness refuses to touch a container without the label; the shared `supabase_*_danceflow-e2e-qa` / `-local-staging` stacks are never read or written.
- Baseline (`baseline` command): the production schema dump of 2026-07-15 (schema only, local and git-ignored: `backups/danceflow-production-pre-accounting-v1-2026-07-15.sql`; override with `ISO_QA_BASE_SCHEMA`) plus the repo's own migrations replayed in version order from a git REF up to a cutoff (default `20261205090000`) and committed as the local image `df-isoqa/base:<cutoff>`. Nothing is copied from the shared database, so another session's unmerged objects (the shared database already holds R2b's) cannot leak in. 24 application migrations that cannot be replayed onto the July dump (production-state preflights, Supabase storage tables) are listed with reasons in `scripts/qa/known-unreplayable.txt`; a failure of any OTHER migration, in particular any TW-4F one, fails the baseline build.
- Scenarios apply further migrations from git refs (never from a working tree): `main` (R2a), `r2a-then-pr251` (the real merge order), `pr251-then-r2a` (numeric order), `baseline`; extra files with `--migration <ref>:<version>`. R2b joins with `--migration <ref>:20261208`.
- `run` classifies results: exit 0 pass, 1 test failure on a healthy database, 3 INFRASTRUCTURE failure (database crashed / never ready). Evidence per run is kept under `C:\Dev\danceflow-iso-qa\runs\<time>-<instance>` (vitest log, postgres log, result.json).
- `matrix <scenario>` runs every local-stack suite in its own fresh database (default 3 in parallel) and prints PASS / FAIL / INFRA per suite. `compare A B` diffs the resulting catalogs (functions with body hashes, table columns and ACLs, constraints, triggers) of two scenarios: it answers "does applying these migrations in a different order change the schema?". `--tests-ref <ref>` runs another commit's own suites (for example PR #251's) from a private detached worktree under the QA home.

## 3. Usage

```bash
node scripts/qa/iso-qa.mjs baseline                                   # once per baseline change (about 7 minutes)
node scripts/qa/iso-qa.mjs run main -- src/lib/sms/twilioIsv/__tests__/localStack.r2a.test.ts
node scripts/qa/iso-qa.mjs matrix main                                # every local-stack suite, one fresh database each
node scripts/qa/iso-qa.mjs compare pr251-then-r2a r2a-then-pr251      # migration order
node scripts/qa/iso-qa.mjs run r2a-then-pr251 --tests-ref origin/twilio-tw4f-sender-reverify -- src/lib/sms/__tests__/localStack.tw4sender.test.ts
node scripts/qa/iso-qa.mjs down --all                                 # remove every isolated container
```

Requires Docker, the images `public.ecr.aws/supabase/{postgres:17.6.1.106,postgrest:v14.8,kong:2.8.1}` (already present locally), Node 20+. No network access, no Twilio, no hosted database.

## 4. Results

Recorded in the PR description and in section 5 once the runs complete.
