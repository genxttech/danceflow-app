# Phase 2 activation: Competition-only continuity pilot (NOT active)

Merging the pilot PR does **not** activate anything. The shipped `phase2/policy.json` has `pilot.enabled: false`, and `claim` refuses to run without a fresh preflight attestation, so even a started loop HALTs. Activation is a separate, explicit owner decision after independent review and merge. The pilot is **local-only**: no push, no PR, no hosted access of any kind (including PROD reads). Twilio and Apps are excluded. No new coordinator, no archived session resumed.

## Sequence (each step is a gate; a failure stops here)
1. **Independent review and merge of the pilot PR.** Owner code-owner approval (the PR changes `.github/CODEOWNERS`; `/docs/ops/continuity-pilot/` becomes owner-protected). Result: inert code, tests and a disabled policy on `main`. Recommended hardening for the owner: a tag ruleset for `main` (the code already fetches `refs/heads/main` explicitly, so a shadowing tag has no effect).
2. **Owner installs the pilot-window deny rules** (the pilot never edits settings): `phase2/required-deny.json` > `recommendedRules` into the **user-level** `settings.json` (only user-level rules count; paths use absolute `//c/...` forms so they do not depend on the working directory). 130 rules cover 116 required variants:
   - shell strings, mirrored for Bash and PowerShell: `prod-apply`, `dev-apply`, any `sb.sh`, `wd-prod`, `db push`, `supabase db|link|login|projects|migration|functions|secrets`, the Supabase pooler and `.supabase.co` hosts, `DATABASE_URL`/`POSTGRES_URL`/service keys, `pr merge|create|review`, `pulls/*/merge`, `graphql`, `ghapp`, `gh api`, `gh *merge*`, `gh release`, `gh workflow`, `vercel`, `vc`, `*git*push*` (so `git -C <path> push`, `git --no-pager push`, `git.exe push` are caught), `send-pack`, git alias definitions, and the test seam. Database rules are command- and host-qualified, so `docker exec ... psql` inside a `cf1pilot-` container and git reads of `src/lib/supabase/migrations` are NOT blocked;
   - edits and writes to settings, hooks, `.claude.json`, `~/.claude/CLAUDE.md`, plugins, agents, skills, commands, `.gitconfig`, project `CLAUDE.md`/`CLAUDE.local.md`/`.mcp.json`, `docs/ops/continuity-pilot/**`, the live queue/attestation root, `danceflow-ops/**` and the credential helper; and **reads** of `danceflow-ops/**` (including prod working-directory secrets), `d24-app-key/**`, `.env*` and `.ssh`;
   - non-shell tools that reach the same effects: the terminal tools, PR auto-merge, both browsers, settings, permission-mode and connector-enable tools, session start / move-to-cloud / send-message, `SendMessage`, scheduled tasks, cron and remote triggers, the docs connector, `Artifact`, `ArtifactData`, `ArtifactComments`, `NotebookEdit` and `Monitor`.
   - While these rules are installed this session cannot use `sb.sh`, `ghapp`, `gh`, `vercel`, `git push`, the connectors above, `Artifact*`, `SendMessage` or `Monitor`. Remove them after the pilot. Not denied: memory files under `~/.claude/projects` (the coordinator writes them).
3. **Live deny probe.** The coordinator runs every probe from `node deny-probe.mjs plan` and records whether the harness denied it (`node deny-probe.mjs record`). Command probes only echo the protected text, quoted so nothing can execute (verified against real bash and PowerShell with hostile text, including Unicode single quotes; variants must be pure ASCII). Edit probes use the real protected path with an impossible match string (cannot change anything even if allowed). Write probes create a new scratch file inside the protected glob. Read probes use a nonexistent path inside the protected glob (a real secret is never read). Tool probes send only empty or invalid arguments: a tool counts as denied only if it is absent from the tool list or the call is refused by a permission rule; an input-validation error is NOT a denial. Evidence is bound to the sha256 of the settings files and of `required-deny.json`, must be under 24 hours old and not future-dated.
4. **Separate explicit owner activation approval** in chat naming (a) the sha256 of `policy.json` and `authorizations.json` as merged (`git cat-file blob <commit>:<path> | sha256sum`), (b) that the deny rules are installed, (c) the intended start time. Without this message nothing proceeds.
5. **Activation PR** (tiny, owner-approved, CODEOWNERS-gated): flips `pilot.enabled` to `true` and sets the authorization window. Its hashes are the ones named in step 4.
6. **Activation preflight** (`node preflight.mjs --root ... --expect-policy-sha ... --expect-auth-sha ... --probe ...`). Writes `PREFLIGHT_REPORT.json` always and `PREFLIGHT_OK.json` only if every check passes; any failure deletes the attestation and the loop HALTs:
   - 1 policy and code integrity: fresh fetch of `refs/heads/main` from the hard-coded source; hashes equal the owner-approved values; policy and authorizations validate (unique ids, authorizations only for class-A templates); **every local code file (orchestrator, protected-source, config, deny-check, deny-probe, preflight, owner-tool, `required-deny.json`, the pinned runner script) byte-equals (CRLF-normalized) the reviewed copy at the fetched commit**, so a stale or edited working-tree copy cannot attest. `claim` repeats the code check on every call.
   - 2 scope and expiry: `enabled=true`, inside the window with at least `maxHours` remaining, every authorization expires at least `maxHours` away, coordinator is COMPETITION.
   - 3 authorization scope: the live queue holds exactly the authorized class-A items (scope hash, template, params, deps), no class-G authorization, no unauthorized item, no duplicate ids, class-A commands pass an **advisory** local-only text screen (the real control is the deny rules), no class-A template touches a protected path.
   - 4 stop controls and fail-closed behavior, run against the real `claim`/`complete` code on the live queue with throwaway protected remotes: items completed through `complete()` so dependencies clear; class-G items parked by the class gate (a mutation test proves removing the gate fails this check); forged local owner-done hands out nothing; a policy authorizing a class-G template HALTs; STOP and resume; unreachable source, wrong worker, missing or stale attestation, settings drift, duplicate ids, remote disable and the claim limit each HALT with the specific reason.
   - 5 limits and host: policy limits within the hard caps in code (4 h, 10 wakeups, 4 claims, 60 calls, 60 min TTL, 2 attempts); Docker reachable, no leftover `cf1pilot-` containers, at least 20 GiB free, live root writable. A run that skips host checks or the fail-closed suite cannot attest.
   - 6 deny rules: coverage of every variant from user-level rules; **the pilot's own representative commands (docker/psql in a `cf1pilot-` container, git reads of migration paths, the pinned runner, the orchestrator) are not denied by those rules**; settings posture over user, session-cwd, current-cwd and managed settings (no bypass mode, no hooks, no enabled plugins, which can carry hooks); complete, all-denied, fresh probe.
7. **Start the single `/loop`** (prompt below). `claim` re-hashes the settings files on every call: any change to them after the preflight HALTs the loop until the deny rules are re-verified.

## Scope when active (exact)
Four class-A items in `phase2/queue.json`; nothing else is authorized. Q5 (PROD SQL apply) is class G with no authorization and can never be handed out.
- Q1 rollback rehearsal, Q2 tooling residual check, Q4 SQL-suite runner script: disposable local Postgres (container name starts `cf1pilot-`, one at a time, removed at the end), local commits in existing worktrees only. They run only the reviewed script `phase2/scripts/run_u18s2.sh` fetched from `main`, after verifying its sha256 (`410b1ee68a0ab6a1949571f9932af4fedf499250cd7f9eb9246f8e6b8acb6bb8`).
- Q3 migration inventory: git reads only. No database access of any kind; the comparison with PROD migration history is done by the coordinator outside the loop.
- Never: any push, PR, merge, hosted access or write, deploy, flag change, credential use, settings edit, or Twilio/Apps work.

## Bounds
| Limit | Value |
|---|---|
| Wall clock after first claim | 4 hours (`maxHours`) |
| Wakeups | 10 (`maxWakeups`), 20 to 30 minute heartbeat, never a fast poll |
| Claims / claim calls | 4 / 60 |
| Claim TTL | 60 minutes without heartbeat; heartbeat about every 10 minutes |
| Retries | 2 attempts per item, then NEEDS-REVIEW |
| Containers | one `cf1pilot-` Postgres at a time; never the `cf1c-qa` or TW-4F `df-isoqa` stacks |
| Attestation | expires at the earlier of `maxHours` after preflight and the policy window end |

## Stop conditions (the loop stops, reports once, does not retry or reroute)
Any permission prompt or denial; any failed safety check or unexpected output; protected source unreachable or invalid (HALT); missing, expired, mismatched or settings-drifted attestation (HALT); policy `enabled:false` on the protected ref; STOP file; any limit; an item reporting a protected path (parks BLOCKED-OWNER); a usage or budget warning; an owner message in chat.

## Recovery
State is local (`queue.json`, `log/execution.jsonl`, `PREFLIGHT_REPORT.json`). A dead runner is requeued once, then NEEDS-REVIEW; a stale completion is refused. After a Claude Code restart nothing resumes by itself: re-run the preflight if the attestation expired, then the single `/loop`. Leftover `cf1pilot-*` containers are identifiable and removable.

## Manual controls
Stop: chat, or `node orchestrator.mjs stop --root C:/Dev/continuity-live/COMPETITION`. Inspect: `status`, `log`, `PREFLIGHT_REPORT.json`. Remote kill: `pilot.enabled=false` via an owner-approved PR.

## Loop prompt (this is prompt discipline, not an enforced allowlist; the deny rules are the enforcement)
```
Continuity pilot, COMPETITION only, local-only. Each iteration run:
node C:/Dev/studioapp/docs/ops/continuity-pilot/orchestrator.mjs claim --wake --root C:/Dev/continuity-live/COMPETITION --worker COMPETITION
CLAIMED: do exactly that item's title/cmd/done, nothing broader. Run `heartbeat --id <id> --token <token>` about every 10 minutes during long work. When finished run `complete --id <id> --token <token> [--changed path1,path2] [--error "<reason>"]` with the same --root, then claim again.
WAIT or IDLE with only owner-gated items left: report once and stop the loop. HALT or STOPPED: stop the loop and report the reason.
Use only what the claim gave you. Never push, open a PR, merge, or touch any hosted system. On any permission prompt, denial or surprise: stop and report. If a step is not named by the claimed item, it is not authorized.
Use the long fallback wakeup (1200 to 1800 s) only while a claimed item's work is genuinely running in the background.
```

## Honest limits
- The pilot is an advisory scheduler for a cooperative agent. The orchestrator removes every route by which it would itself hand out gated work and refuses to start without the preflight, but it cannot stop a non-cooperative agent from running a command or editing local files.
- **The attestation and the probe evidence are both self-reported local files.** The attestation proves a cooperative loop only that the exact policy and authorization bytes and the settings it was verified against are still the ones in force; a local writer can forge it. The hard gate is the protected policy's `enabled` flag and the CODEOWNERS-protected files.
- String deny rules cannot match obfuscated spellings, indirect execution (`node -e`, scripts, language runtimes) or shell redirection onto protected files, and they only cover the tools listed. See `knownResidual` in `required-deny.json`. The static matcher approximates Claude Code's matcher; the live probe is the authority.
- Every claim runs the GitHub App credential helper to read the protected ref; that helper can mint a write-capable token. It is run by git, not by an agent tool call, and is not restricted here. Using a read-only credential is a recommended follow-up.
- Local counters can be reset by a local edit; the bounds that survive that are the protected policy window and per-entry expiry.
