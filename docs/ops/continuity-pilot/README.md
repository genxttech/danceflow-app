# Continuity pilot (Competition-first; NOT installed, NOT active)

An **advisory scheduler for a cooperative agent**. A self-paced Claude Code `/loop` in the COMPETITION session calls `orchestrator.mjs claim` once per iteration to learn which queue item it may work next. The session does the work and calls `complete`. It is not a sandbox.

## What it guarantees
It never **hands out** a class-G, unauthorized, expired, replayed or out-of-policy item, using only state fetched from a protected remote ref:
- Trust anchor (`config.mjs`): the repo URL, ref and file paths are constants in code. The production CLI has no flag or env var to change them, the TTL, the limits or the authorization.
- `protected-source.mjs`: fetches `policy.json` and `authorizations.json` from `main` into a fresh throwaway bare repo on every claim, under a scrubbed git environment (no user/system config, no replace refs, no hooks, https only, no `ext::`). No persistent cache. Failure of any kind means HALT.
- Class, templates, limits, window, retry count and `owner_done` come from that policy. Each authorization carries `template`, `params`, `deps` verbatim plus a scope hash covering id, template, params, deps and the template content; changing any of them voids it.
- The local `queue.json` holds ordering and state only. Duplicate ids, forged DONE/OWNER-DONE, replayed DONE items, re-pointed templates and edited params are rejected or ignored.

## What it does NOT do
- It cannot stop a non-cooperative or compromised agent from running a command itself, or from editing the orchestrator code locally. `cmd` is text handed to a model that already has a shell. **The enforcing layer is Claude Code permission deny rules** (see PHASE2-ACTIVATION.md); without them the guarantee covers a mistaken agent following the protocol, not a hostile one.
- The protected ref is only as strong as GitHub branch protection plus the CODEOWNERS entry `/docs/ops/continuity-pilot/`.
- Local counters (`startedAt`, wakeups, claims, calls) can be reset by editing local state. The bounds that survive that are the protected authorization window and per-entry `not_after`.
- `--changed` paths on `complete` are self-reported; a protected path reported there parks the item for the owner.

## Files
`orchestrator.mjs` (claim/complete/heartbeat/stop/status), `protected-source.mjs`, `config.mjs`, `owner-tool.mjs` (prints authorization entries for the owner to review and merge; never in the loop's allowlist), `test-cli.mjs` (test helper only), `orchestrator.test.mjs`, `phase2/` (proposed policy, queue, authorizations), `PHASE2-ACTIVATION.md`.

## Behavior
Claim picks the next item that is PENDING, authorized, has satisfied dependencies (class-A DONE with a log record, or listed in `owner_done`), and holds no worktree/DB slot a RUNNING item holds. Class-G items park BLOCKED-OWNER once and are re-evaluated if the policy changes; dependents wait; independent items continue. A dead runner (pid gone or heartbeat older than the policy TTL) is requeued; a failed item retries up to `maxAttempts`, then NEEDS-REVIEW and is reported on IDLE. A zombie completion with a stale token is refused. `stop` writes a STOP file; remote disable is `pilot.enabled=false` on main.

## Tests
`node --test orchestrator.test.mjs` (slow: each test builds a real local git remote). Includes a regression test per finding of the independent review.
