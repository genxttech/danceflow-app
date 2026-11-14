# Phase 2 activation request: Competition-only continuity pilot (PROPOSED, not active)

Nothing here runs until the owner (a) approves and merges the PR that carries it and (b) starts the single `/loop` command below in the COMPETITION session. Twilio and Apps are excluded. No new coordinator, no archived session resumed.

## What the owner is authorizing (exact)
1. Merge of the continuity-pilot PR, which includes the CODEOWNERS line `/docs/ops/continuity-pilot/ @genxttech` so that the policy, templates and authorizations are changeable only with owner approval.
2. Four class-A items (Q1 to Q4 in `phase2/queue.json`), nothing else. Each is bound by scope hash (template + params + deps) to an entry in `phase2/authorizations.json`, valid until 2026-11-17T00:00Z.
3. The loop may, for those items only: run local disposable Postgres containers (prefix `cf1pilot-`), read-only `sb.sh prod-read` / `dev-read`, read git on the release branch, write evidence docs and one script into the existing worktrees, and make LOCAL commits there.
4. OPTIONAL (strike if not wanted): after all four are done, the COMPETITION coordinator (not the loop) may push one branch and open one DRAFT PR through the App identity. Never ready-for-review, never approve, never merge.

## Not authorized (cannot be handed out by the orchestrator even if local files are edited)
Q5 `prod-sql-apply` and anything class G: hosted SQL apply (PROD, and DEV stays held), merges, deploys or promotions, flag activation, Stripe/Twilio live, financial actions, credentials, settings/CLAUDE.md/hook edits, outreach.

## Bounds
| Limit | Value |
|---|---|
| Wall clock after first claim | 4 hours (`maxHours`) |
| Wakeups | 10 (`maxWakeups`), heartbeat 20 to 30 minutes, never a fast poll |
| Claims | 4 (`maxClaims`) |
| Claim TTL | 60 minutes without a heartbeat (from protected policy); heartbeat about every 10 minutes |
| Calls | 60 claim invocations (`maxCalls`) |
| Retries | 2 attempts per item, then NEEDS-REVIEW |
| Authorization window | 2026-11-14T12:00Z to 2026-11-17T00:00Z (protected policy) |
| Containers | one `cf1pilot-` Postgres at a time, removed at item end; never the `cf1c-qa` or TW-4F `df-isoqa` stacks |
| Disk / CPU | one container, no parallel builds, no `npm ci`, no Gradle |

## Stop conditions (the loop stops, reports once, and does not retry or reroute)
Any permission prompt or denial; any failed safety check or unexpected hosted-system output; protected source unreachable or invalid (HALT); policy `enabled:false` on the protected ref (remote kill: merge a one-line PR, or just stop the loop); STOP file; any limit above; an item that touches a protected path (parks BLOCKED-OWNER); usage/budget warning; an owner message in chat.

## Recovery behavior
State is in `queue.json` and `log/execution.jsonl` (local, outside the repo). A runner that dies is detected by heartbeat expiry; its item returns to PENDING once (attempt 2), then NEEDS-REVIEW. A late completion from a dead runner is refused. After a Claude Code restart nothing resumes by itself; the owner re-issues the single `/loop`. Disposable containers are named `cf1pilot-*` so leftovers are identifiable and removable.

## Manual controls for the owner
Stop: type in chat, or `node orchestrator.mjs stop --root C:/Dev/continuity-live/COMPETITION`. Inspect: `... status` and `... log`. Remote kill: `pilot.enabled=false` in `phase2/policy.json` on main (needs an owner-approved PR, so the practical stops are chat or the STOP file).

## Exact loop prompt (the loop is allowlisted to run only `orchestrator.mjs`; it has no source, TTL or limit flags)
```
Continuity pilot, COMPETITION only. Each iteration run:
node C:/Dev/studioapp/docs/ops/continuity-pilot/orchestrator.mjs claim --wake --root C:/Dev/continuity-live/COMPETITION --worker COMPETITION
CLAIMED: do exactly that item's title/cmd/done, nothing broader. Run `heartbeat --id <id> --token <token>` about every 10 minutes during long work. When finished run `complete --id <id> --token <token> [--changed path1,path2] [--error "<reason>"]` with the same --root, then claim again.
WAIT or IDLE with only owner-gated items left: report once and stop the loop. HALT or STOPPED: stop the loop and report the reason.
Use only what the claim gave you. On any permission prompt, denial or surprise: stop and report. If a step is not named by the claimed item, it is not authorized.
Use the long fallback wakeup (1200 to 1800 s) only while a claimed item's work is genuinely running in the background.
```

## Deny rules: STRONGLY RECOMMENDED precondition (owner installs; I will not edit settings)
The independent review confirmed the orchestrator controls only what it hands out, not what the model then runs. User-level deny rules hold in every mode and are the real barrier. Proposed set: `sb.sh prod-apply`, `sb.sh dev-apply`, `ghapp pr merge`, `gh pr merge`, `vercel` deploy/promote, `git push --force`, `git push` of the protected branches, and writes to `.claude/settings*.json`, `CLAUDE.md` and `docs/ops/continuity-pilot/`. I recommend not starting the loop until at least the first four are in place.

## Honest limits (incl. independent review, 10 P2 + 4 P1 findings fixed)
The pilot is an advisory scheduler for a cooperative agent. The orchestrator cannot make the model obey; it removes every route by which the pilot itself would grant gated work. The protected ref is only as strong as GitHub branch protection plus the CODEOWNERS line; admin-bypass is not available to the App. Counters (`startedAt`, wakeups, claims) are local state and could be reset by a local edit; the hard bounds that survive that are the protected authorization window and per-entry `not_after`.
