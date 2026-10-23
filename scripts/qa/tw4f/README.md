# TW-4F Q1 continuous QA runner

`run-chain.mjs` proves a TW-4F migration set on a DEDICATED, disposable Postgres container (own labels `df.tw4fq1=1`, prefix `df-q1-`, own docker network, Kong on 127.0.0.1:56800-56899 only). It never touches the shared `supabase_*_danceflow-e2e-qa` stack, PR #266's `df-isoqa-*` containers, any hosted database, Twilio or Stripe.

It builds on the baseline image `df-isoqa/base:20261205090000` that PR #266's `scripts/qa/iso-qa.mjs baseline` produces (July production schema + repo migrations through 20261205); it does not edit #266's files. The SQL chain it applies on top is everything above that cutoff at `--base` (default `origin/main`), plus the slice's own migrations.

```bash
git fetch origin
# 1. baseline: main only
node scripts/qa/tw4f/run-chain.mjs all --label main
# 2. a slice branch: its migrations are every file above the cutoff that exists at the branch but not on main
node scripts/qa/tw4f/run-chain.mjs all --label f3 --extra-branch origin/twilio-tw4f-f3-recon-gate
# 3. one file from a branch, or several branches in the combined order (numeric by default)
node scripts/qa/tw4f/run-chain.mjs chain --label f1+f3 --extra-branch origin/twilio-tw4f-f1-funding --extra-branch origin/twilio-tw4f-f3-recon-gate
node scripts/qa/tw4f/run-chain.mjs chain --label pr251 --extra origin/twilio-tw4f-sender-reverify:20261206
# 4. a single suite (substring of the path)
node scripts/qa/tw4f/run-chain.mjs suites --suite localStack.r2a --extra-branch origin/twilio-tw4f-f4-recovery
node scripts/qa/tw4f/run-chain.mjs down      # remove leftovers
```

* `chain` stages: baseline reachable; apply main chain; (extras) apply, roll back extras and compare with the main-only catalog, re-apply and compare; roll everything back in reverse order and compare with the baseline catalog; re-apply and compare with the first apply; second rollback/apply cycle. Function bodies are fingerprinted after CRLF removal, together with signature, owner, security-definer, config and ACL; tables, constraints, indexes, policies, triggers, views, enums and default ACLs are included.
* `suites` clones one pristine database per suite from the applied chain (a committed local image, removed afterwards) and runs each `localStack.*` vitest file serially from a private detached worktree of `--tests-ref` (default: the last `--extra-branch`, else `--base`). The `node_modules` link into that worktree is a junction; it is unlinked (never recursed) before the worktree is removed.
* Results: `report.md` / `report.json` plus per-suite `vitest.log` and `postgres.log` under `--out`. Exit codes: 0 green, 1 failure on a healthy database, 3 infrastructure (container crash, OOM, migration error), 4 BLOCKED (nothing ran / skipped), 6 only KNOWN failures from `known-failures.json`, 2 usage.
* A skipped suite or a suite that ran nothing is BLOCKED, never PASS. A listed known failure must match every failing test name, otherwise the suite is FAIL.

Requirements: Docker, the images `df-isoqa/base:20261205090000`, `public.ecr.aws/supabase/postgrest:v14.8`, `public.ecr.aws/supabase/kong:2.8.1`, Node 20+, and `node_modules` in the worktree you run from (copy it; do not `npm ci` through a junction).

Host conditions: every suite records CPU %, free RAM and container count at start and end (`report.md` column, `report.json` `host`). A suite whose failure or infrastructure result coincides with CPU >= 85% or free RAM < 2 GB is annotated "resource exhaustion suspected"; report those separately from real regressions, and never count timeouts, skips or infra-blocked suites as passes.
