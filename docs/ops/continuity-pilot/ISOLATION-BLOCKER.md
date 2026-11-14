# Phase 2 isolation: status (2026-11-14)

Owner requirements: deny rules apply to the Competition pilot only, never to global Claude Code user settings; Apps and Twilio unaffected; isolation and enforcement demonstrated by test before activation; PR 512 review/merge separate from any security installation or activation; if reliable isolation cannot be demonstrated, do not activate and report the blocker with an alternative.

**Decision (owner, 2026-11-14): option A, an isolated headless child process.** The earlier plan (global deny rules plus an in-session `/loop`) is withdrawn: a session shares the owner's user-level settings with every other session, so its rules cannot be scoped.

## What is built (all inert until activation; covered by tests with a fake CLI)
- `child-config.mjs`: the exact CLI flags (`--restricted --strict-mcp-config --tools "Bash,Read,Edit,Write,Glob,Grep" --permission-mode dontAsk --permission-prompts none --settings <per-item file> --add-dir <item dirs> --max-budget-usd --no-session-persistence`), a per-item settings builder, a scrubbed environment (no GitHub, Supabase, Vercel or database tokens), and strict validation: every template's allowlist must sit inside a few reviewed command shapes (exact commands, `git -C C:/Dev/<dir> <read subcommand> *`, `docker exec ... cf1pilot-qN psql|pg_dump|pg_restore *`, one reviewed SQL-apply helper). Interpreters, wildcards outside those shapes, shell metacharacters, `..` traversal, paths outside the item's directories and anything that would permit a protected variant are rejected.
- `driver.mjs`: replaces the `/loop`. Deterministic code claims ONE item, writes that item's settings, runs the child, watches its stream-json for permission denials, and completes through the orchestrator. Any denial, timeout, STOP file or HALT ends the run. The model never claims, schedules or completes anything.
- `isolation-test.mjs`: runs the real binary with the real flags and each template's real settings against about 120 probes per template (every protected variant, ten abuse shapes on each allowed command: `&&`, `;`, pipe, redirect, `$()`, backticks, newline, env prefix, `--output=`, `..` traversal; file-tool confinement; allowed controls that must succeed). It judges from the harness's own stream-json records plus filesystem canaries that would exist if an injected command had run, not from the model's account. The preflight accepts only a passing, fresh report bound to the exact child configuration hash.
- The attestation and `claim` bind to that configuration hash and to the reviewed local code, not to anyone's user settings.
- Scope tightened where isolation demands it: Q4 may write the runner script but the isolated environment never executes model-written code; host SQL files are applied only through a small reviewed helper.

## What is NOT yet demonstrated
The standalone `claude` CLI on this machine is not logged in (`claude auth status`: `loggedIn: false`; even a plain `-p` call returns `Not logged in`). The desktop app authenticates its own sessions internally. Until the owner signs the CLI in, the isolation test cannot run, so enforcement has not been shown against the real harness. Per the owner's rule, **Phase 2 is not activated and must not be activated until `isolation-test.mjs` passes and the preflight accepts its report.**

Verified so far (real binary, 2.1.321): the child starts with exactly the intended tool surface (`tools` = the six named tools, `mcp_servers` empty, `permissionMode` = `dontAsk`) and without the owner's global settings.

## Owner step
Run once in a terminal (opens the standard browser sign-in; credentials are never visible to the pilot):
`"C:/Users/mcurt/AppData/Local/Claude-Data/claude_pzs8sxrjxfjjc/claude-code/2.1.321/d0e23af87588/claude.exe" auth login`
This creates a separate CLI login that bills the owner's plan for the pilot's child runs and probe runs. It does not change desktop-app sessions or any global setting.

## If the test fails or cannot reach full evidence
Report the failing probes, tighten the allowlist (or drop the offending item), re-run. If a class of abuse cannot be denied reliably (for example an allowed prefix that the harness lets chain a second command), the fallback is option C (a no-model scripted executor with a code-level command allowlist), which needs no deny-rule isolation.
