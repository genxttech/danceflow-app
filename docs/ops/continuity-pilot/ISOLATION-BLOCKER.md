# Phase 2 isolation: status BLOCKED (2026-11-14)

Owner requirement: the pilot's deny rules must apply to the Competition pilot only, never to the global Claude Code user settings; the Apps and Twilio coordinators must stay unaffected; isolation and enforcement must be demonstrated by test before activation; PR 512 review/merge stays separate from any security installation or activation; if reliable isolation cannot be demonstrated, Phase 2 is not activated.

**Result: isolation is designed but NOT demonstrated. Phase 2 must not be activated.** The "install the deny rules in user-level `settings.json`" step in earlier drafts of `PHASE2-ACTIVATION.md` is **withdrawn** (it would change every coordinator's session). Merging PR 512 installs nothing and activates nothing.

## Why a `/loop` inside the COMPETITION session cannot be isolated
A session shares the owner's user-level settings with every other session. Deny rules cannot be scoped to one session's loop. Project-scoped settings only follow the working directory, and the COMPETITION session's directory is the shared checkout.

## Verified (Claude Code 2.1.321, bundled with the desktop app)
The CLI offers per-process isolation flags (from `claude --help`):
- `--restricted`: ignores user, project and local settings files (only `--settings` and managed settings apply); removes the command-running tools unless `--tools` names them; confines file tools to the working directories; refuses `bypassPermissions`; settings, git and tool-configuration writes need a person to approve.
- `--strict-mcp-config` (no MCP connectors), `--tools "<list>"` (only the named built-in tools exist), `--permission-mode dontAsk` plus `--permission-prompts none` (anything not pre-approved is denied), `--settings <file>`, `--max-budget-usd`, `--no-session-persistence`, `--output-format stream-json`.
- A real run on this machine (local evidence in `C:\Dev\cpilot-iso\runs\feas.out`) confirmed the child starts with exactly `tools: ["Bash"]`, `mcp_servers: []`, `permissionMode: "dontAsk"`, and that the owner's global settings were not loaded.

## The blocker
The standalone `claude` CLI on this machine is **not logged in**. A plain `claude -p "Reply with the single word OK" --tools ""` (no custom flags) returns `Not logged in · Please run /login`, and there is no credentials file: the desktop app authenticates its own sessions internally. Without a logged-in or API-keyed CLI, a model-driven child cannot run, so the deny rules and the allowlist cannot be exercised against the real harness. Making the CLI usable needs an owner credential step (`claude auth login`, `claude setup-token`, or an `ANTHROPIC_API_KEY`). I will not perform or work around it (no entering credentials, no lifting the app's token). Child runs would also consume the owner's plan or API budget.

## Options (owner decision)
- **A. Isolated headless child (recommended if you accept the credential step).** After you run `claude auth login` once, a reviewed `driver.mjs` claims one item at a time and launches a restricted child with default-deny permissions: a per-item allowlist taken from the owner-authorized policy template, the pilot deny list as a second layer, no MCP, a minimal tool set, file tools confined to the item's worktrees, a budget cap and a hard timeout. The model cannot claim further items. Isolation is then tested with the real harness: the child's stream-json output gives objective tool-use and permission-denial records for every probe (including chaining, flag-injection and path-escape abuse of allowed prefixes), plus allowed controls that must succeed. Apps and Twilio are unaffected because nothing global changes. Build cost: a driver, a settings builder, allow lists in the policy templates, an isolation test and preflight integration.
- **B. A short-lived worker session in a dedicated folder.** The app can start a session in a folder you name; project-scoped `.claude/settings.local.json` in that folder carries the deny rules for that session only. Limits: the app cannot attach per-session rules or restrict tools, user-level allow rules still merge, MCP connectors exist unless denied, and it is a new session (your constraint on additional standing coordinators needs your explicit call). Enforcement can be tested through the app's authenticated session without a CLI login.
- **C. No-model scripted executor.** The four Phase 2 items are deterministic engineering steps. A reviewed script runner with a code-level command allowlist (no Claude process, no deny-rule question) could perform them with its own start, stop and limits. It proves job continuity but not AI-agent continuity.
- **D. Pause Phase 2.** Phase 1 evidence stands; nothing else changes.

## Until one option is chosen and tested
`preflight.mjs` still requires user-level deny coverage and a user-settings probe (checks 6.*). Because those rules must not be installed globally, the preflight **cannot pass today**, so `claim` cannot be attested and the loop HALTs: the fail-closed state is the intended state. Those checks will be replaced by the isolation evidence of whichever option is chosen.
