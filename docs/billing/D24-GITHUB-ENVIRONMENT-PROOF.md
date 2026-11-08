# D24 Stripe TEST proof: GitHub environment option

Status: **built, inactive.** Nothing in this change runs, configures GitHub, or touches Stripe. The workflow
(`.github/workflows/d24-stripe-test-proof.yml`) does nothing until the owner creates the `d24-stripe-test` environment and its secret,
and it fails closed while the account ids or the evidence key are placeholders.

Owner-approved intent: engineering operates the Stripe TEST-mode proof; the owner only approves each run, and the restricted TEST key
never needs to sit on a developer machine or in this conversation.

Facts this design rests on: `genxttech/danceflow-app` is a **public** repository owned by a **personal** user account (not an organization), on the free plan.
Engineering will act as a dedicated agent identity, never as the owner: a GitHub App owned by the owner and installed only on this repository (recommended) or the dedicated account `danceflow-engineering-bot` (2FA by authenticator app) with a classic token (section 3.B).
**Everything below that says "engineering cannot" is true only after section 3 is completed and verified, and only within the accepted residual of 3.0: the owner approves on the same Windows PC, so none of this is an independent boundary against a deliberately hostile agent on that account.** Until section 3 is done nothing here is a control at all.

## 1. How a run works

1. Engineering posts, in chat, the **workflow path** (`.github/workflows/d24-stripe-test-proof.yml`), the commit SHA and the harness manifest SHA-256 it wants run.
2. Engineering (or anyone with write access) dispatches the workflow on `main` (`workflow_dispatch` only).
3. GitHub pauses the job at the `d24-stripe-test` environment. The owner sees the run, its commit SHA (also in the run title) and the workflow file path,
   and approves **only if the workflow path is exactly `.github/workflows/d24-stripe-test-proof.yml` and the SHA matches the chat message**. A run with any other workflow path
   that uses the same environment is not this proof: reject it. (What the approval screen actually shows is UNVERIFIED, section 6; check before the first approval.)
4. After approval the job: refuses unless the repository, event, ref and **`github.workflow_ref`** are right and the pinned account ids are real; fetches exactly the dispatched
   commit with plain `git` (no checkout action, no stored credential) and requires that commit to still be the tip of `main`; **verifies, in plain shell before any node process, the git tree id of
   `scripts/qa/d24-m3d-proof` and the SHA-256 of `package.json`, `package-lock.json` and `tsconfig.json` against pins in the workflow file**; installs with `npm ci --ignore-scripts`;
   fails unless the harness manifest hash equals the pinned hash; runs `--dry-run`; refuses if a stray `node`/`esbuild` process exists; runs `--preflight`; and only then runs `run.ts --live`.
   Every node/npm step runs from the tool-cache binary by absolute path in a scrubbed environment (`env -i`, explicit `PATH`, absolute `/usr/bin` helpers, an absolute shell, empty `BASH_ENV`/`ENV`), which narrows what an earlier step can put in `GITHUB_ENV` / `GITHUB_PATH` in front of the process that holds the key. It is **not** an isolation boundary (section 4).
5. All live output (terminal text and the harness's evidence pack) is written outside the checkout, never to the public log, bundled,
   **encrypted to the engineering evidence public key**, and only the ciphertext is uploaded as an artifact (3-day retention).
   The job summary shows only: outcome, PASS / FAIL / BLOCKED counts, Stripe request count, and two SHA-256 values
   (the ciphertext file and the plaintext bundle). No account id, no object id.
6. Engineering decrypts with `scripts/qa/d24-gh-proof/decrypt-cli.ts` (verifies the GCM tag, the plaintext hash and, if given, the hashes the summary showed).
   **The envelope proves integrity, not origin:** anyone holding the public key can mint a valid envelope. Fetch the artifact from the specific run and match its ciphertext SHA-256 to the one in that run's job summary.

The harness keeps all of its own protections unchanged: default-deny allow-list, 40-call cap (8 reserved for cleanup), identity gate,
pinned `Stripe-Version`, environment hardening, redaction, cleanup, exclusive-create evidence.

## 2. What is pinned in the workflow file (reviewed on `main`)

| Pin | Where | Enforced by |
|---|---|---|
| Harness git tree id | `D24_PROOF_PINNED_TREE` | the job, in plain shell **before any node runs** (`git rev-parse HEAD:scripts/qa/d24-m3d-proof`); a unit test (equals the real tree) |
| Harness manifest SHA-256 | `D24_PROOF_PINNED_SHA256` | the job (`--print-hash` must equal it; computed by the harness itself, so a consistency check; the tree id is the independent one) and a unit test |
| `package.json`, `package-lock.json`, `tsconfig.json` SHA-256 | `D24_PIN_*_SHA256` | the job (`sha256sum`, before `npm ci`); unit tests. A changed lockfile breaks the run until the pin is updated under code-owner review |
| Workflow identity | `D24_WORKFLOW_REF_EXPECTED` vs `github.workflow_ref` | the job's guard step. This protects only the real file; the control against a *rogue* file is CODEOWNERS on all of `/.github/` |
| Platform and connected account ids | `D24_PROOF_EXPECT_PLATFORM_ACCT` / `_CONNECTED_ACCT` | the harness identity gate; the guard step refuses `PLACEHOLDER` (substring check; the owner must compare real ids to the sandbox dashboard during code-owner review) |
| Authorization sentence | `D24_PROOF_AUTHORIZATION` | The harness was designed around an owner-typed approval sentence. In this option that sentence is **a constant supplied by this reviewed file** (test-checked equal to the harness constant). The owner's approval click on the environment *is* the authorization; the sentence control is retired as a human gate |
| Evidence public key | `scripts/qa/d24-gh-proof/evidence-public-key.pem` | `encrypt-cli.ts --check-key` runs **before** any Stripe request and refuses a placeholder, a private key, a non-RSA or sub-4096-bit key |
| Actions | two official actions, each pinned to a full commit SHA | unit test (no tag, no short SHA, nothing else) |
| Tooling and stray config | `D24_PIN_TOOLING_SHA256` (listing hash of `encrypt-cli.ts`, `evidence-crypto.ts`, `summary.ts`, `evidence-public-key.pem`); the job refuses to run if `.npmrc`, `scripts/package.json`, `scripts/qa/package.json` or `scripts/qa/d24-gh-proof/package.json` exists | the job, in plain shell before node; unit tests |
| Node | exact version in `actions/setup-node`, and the same version in the tool-cache path | unit test |

The unit tests make the pins equal to the repository content at the same commit, so changing any pinned input forces a reviewed update of the workflow file **only if the tests run and are required** (3.E).

**Placeholders currently in the PR:** the two account ids (`acct_PLACEHOLDER...`) and the evidence public key. Real values arrive in a
later, code-owner-reviewed PR after a **new production-equivalent Express connected account** exists (section 5) and the keypair has been generated offline.

## 3. Owner setup sequence (one sequence, in this order)

Owner-only actions are marked **[OWNER]**. Engineering does the rest locally and never touches GitHub settings. Run section 3.H after each stage that changes something.

### 3.0 [OWNER] ACCEPTED RESIDUAL: the owner approves on the same Windows PC, plus compensating controls

**Owner decision (recorded):** the owner keeps approving deployments, code-owner reviews and merges, and changing Settings, **on this Windows PC**, in a browser signed in to GitHub. This is accepted for **TEST-only proofs**. It is not a separate-device design.

**What the residual is.** The agent runs arbitrary commands as the same Windows user and has browser-automation tools that can drive a signed-in browser. A **deliberately hostile agent** on this account could therefore drive the owner's signed-in GitHub browser (or read other owner credentials stored on the account) and approve its own deployment, approve and merge a pull request, or change settings. **This design does not claim an independent boundary against a deliberately hostile agent on the owner's own Windows account.** The ruleset, the environment reviewer and CODEOWNERS constrain an agent that behaves as the bot, App or token it was given; they do not constrain an agent that uses the owner's session.

**Why it is accepted (bounded and visible).** The only secret behind the gate is a restricted `rk_test_` key with three permissions (Invoices=Write, Customers=Write, connected-account Read), in a throwaway sandbox, with a 40-call cap (8 reserved for cleanup), no money movement, allow-listed endpoints and pinned accounts, and every approval/merge/review generates a notification the owner receives elsewhere (below). A misuse would be limited to the sandbox and visible after the fact.

**When this must be re-opened (do not rely on this acceptance beyond TEST-only):** any live-mode key, any secret that can move money or touch real customers, any production credential in the environment, a higher request cap, or a wider key scope. Then the owner's GitHub activity must move to a separate device or Windows account, and sections 3.G and 3.H must be re-done on that basis.

**Standing rule (record of the owner's decision):** the agent **never uses** the owner's browser sessions (Chrome, Edge, the built-in browser pane or any browser extension session signed in as `genxttech`), the `gh` keyring token, the Git Credential Manager login, SSH keys, or any other owner credential, and never approves, merges or changes settings as the owner. Anything done as the owner is done by the owner. This is a rule, not a technical control.

**Compensating controls the owner sets up (all on the owner's side, none by the agent):**
1. **Hardware security key on the owner's GitHub account** (GitHub -> Settings -> Password and authentication -> Two-factor authentication -> Security keys -> Register new security key, and make it a primary method). Sensitive actions (Settings, rulesets, secrets, tokens, apps) then require **sudo-mode** re-authentication with the key, which a browser-driving agent cannot supply. UNVERIFIED: whether deployment approvals and merges also re-prompt; the key protects settings, rulesets and secrets, not necessarily the approval click.
2. **Notification e-mails to a different device or account the agent cannot read**: GitHub -> Settings -> Notifications -> turn on e-mail (and the mobile app push) for **deployment reviews/approvals**, pull request reviews, merges and Actions, and set the notification address to a mailbox that is **not** opened on this PC (read on a phone or another account). Optionally add a second verified address. The owner treats any approval, review or merge notification they did not perform as an incident: revoke the agent credential, rotate the key, and check the Stripe dashboard.
3. **Hygiene** that removes the easy paths even though the browser stays signed in: the credential inventory and removal in 3.G (`gh` keyring token, Git Credential Manager, SSH keys, editor logins, `credential.interactive never` / `GCM_INTERACTIVE=never`).
4. **Keep the owner's session short-lived**: sign out of github.com when not approving; use the hardware key as the second factor so a stolen cookie alone cannot reach settings.

**Honest residual list (still true after all of the above):** a hostile same-machine agent can drive the owner's signed-in browser for approvals and merges; can read anything else the owner stores on the account; can cancel or delete workflow runs and artifacts; and shares the machine with the evidence private key. Notifications and the small blast radius are what make this acceptable for TEST-only, not an independent boundary.

### 3.A0 [OWNER] Checks before the bot or App is given access (all UNVERIFIED)

The repository has 10 environments created by the Vercel GitHub integration, so Vercel builds branches from this repository. A write-role agent can push a branch whose build script prints or sends Vercel **Preview** environment variables (which can include DEV database service keys, Stripe TEST keys or messaging credentials). No GitHub setting in this document controls that. Before inviting anything:
1. Vercel -> the project -> **Settings** -> **Git**: check how deployments from a commit author who is not a Vercel team member are handled (blocked, or waiting for authorization), and the *Git fork protection* setting. Record what you see. (Vercel's behaviour for a non-team author on a public repository is UNVERIFIED.)
2. Vercel -> **Settings** -> **Environment Variables**: list every variable with the **Preview** scope. Remove any secret that is not needed for previews, or scope it to Production only. Treat anything that remains in Preview as readable by the agent.
3. Check every other GitHub App installed on the repository (GitHub -> Settings -> Applications -> Installed GitHub Apps) that builds or tests on push, and apply the same question to it.

### 3.A [OWNER] Invite the bot as a collaborator (needed for Option B only)

If Option A (the GitHub App, 3.B) is chosen, the bot account is **not** invited: the App is the agent identity, and having both would give the agent two identities that can review each other's pull requests.

1. github.com -> `genxttech/danceflow-app` -> **Settings** -> **Collaborators** (left menu: *Access* -> *Collaborators*) -> **Add people**.
2. Type `danceflow-engineering-bot`, choose it, **Add**. (On a personal repository there is normally **no role dropdown**: a collaborator gets read/write access. UNVERIFIED, see section 6; if a dropdown does appear, choose **Write**, never Maintain or Admin.)

What a collaborator on a personal repository can do (from GitHub's documentation): push, create and merge pull requests (when the ruleset allows), enable auto-merge, submit reviews that count toward mergeability, act as a code owner, create releases, edit the wiki, publish packages. It cannot manage webhooks or deploy keys, invite collaborators or rename the default branch.
Not covered by that documentation page (so UNVERIFIED until `--as-bot` runs): Settings, secrets, environments and rulesets are expected to be admin-only.
Things a write-role identity can still do and that matter here: **dispatch the workflow** (a reference to a missing environment would auto-create it unprotected, hence the merge-order rule), **edit any workflow in a PR branch** (hence CODEOWNERS on all of `/.github/`), **cancel or delete workflow runs, logs and artifacts** (it can destroy evidence or interrupt a live run so harness cleanup is skipped; the owner records the run id at approval and the reconciliation in section 5 catches leftovers), and **post commit statuses** (so the required status check is a correctness gate, not a security control; see 3.E).
The agent identity must **not** be a required reviewer on the environment, must **not** be a code owner, and must **not** be in any ruleset bypass list.

### 3.B [OWNER] The agent's credential: decision and steps

A token created by `genxttech` **always acts as the user who created it**, so it can never be the agent's credential. The agent needs a **separate identity** with no administrative role. A **fine-grained personal access token also cannot be used by a collaborator on another user's repository** (documented limitation: fine-grained tokens do not work "to contribute to repositories where the user is an outside or repository collaborator"), so the bot account cannot have one for this repository.
Decision for the owner, with a recommendation:

**Option A (recommended): a GitHub App owned by the owner, installed only on `danceflow-app`.**
1. On the owner's PC (signing in with the hardware key, 3.0): github.com -> avatar -> **Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**. Name e.g. `danceflow-engineering`; Homepage URL the repository URL; **Webhook: untick Active**; **Where can this GitHub App be installed: Only on this account**.
2. Repository permissions: Contents **Read and write**; Pull requests **Read and write**; Actions **Read and write** (to dispatch the proof workflow and re-run CI); Workflows **Read and write** (see the trade-off below); Metadata **Read** (automatic). **Nothing else** (no Administration, Environments, Secrets, Deployments, Statuses, Checks, Variables, Webhooks). No organization or account permissions.
3. **Create GitHub App**, then **Generate a private key** (a `.pem` downloads). Note the App ID. **Install App** -> your account -> **Only select repositories** -> `danceflow-app`.
4. Hand the key to engineering **as a file path on a protected location, never in chat**; engineering mints short-lived installation tokens (about one hour) from it. The App is not a required reviewer, not a code owner and not a ruleset bypass actor.
5. Why recommended: tokens are short-lived and limited to one repository; permissions are exactly the list above (a classic token cannot be this narrow); there is no second account to invite; the verifier (`--as-app`, 3.H) checks the installation scope and the refusals.
6. Costs and cautions: the private key on this machine **is** the agent's credential (protect it like a token; rotate by generating a new key and deleting the old one); with Pull requests write the App can approve pull requests, so **the App must be the only agent identity** (do not also invite the bot account) and a rule applies: *the owner never lets the agent identity approve a pull request that the agent identity also pushed to*; commits and pull requests appear as the App.

**Option B: a classic personal access token for `danceflow-engineering-bot`** (after 3.A), scopes `repo` and `workflow` only, 90-day expiry, created while signed in as the bot (a private window; sign out afterwards).
Its extra powers, which cannot be removed from a classic token: `repo:status` (post commit statuses, including one with the required check's name), `repo_deployment` (create deployments and deployment statuses; whether creating a deployment with a new environment name creates that environment unprotected is UNVERIFIED, which is why 3.D happens before any token exists), write access to **any other repository** the bot is ever added to, and read access to the bot's own account data. A write-level account still cannot use admin endpoints, whatever the scope.

**Workflows permission trade-off (both options):** without it the identity cannot push anything under `.github/workflows/`, a useful extra barrier that also blocks legitimate CI maintenance; with it the identity can push a workflow change to a branch and open a pull request but **cannot merge it to `main`** because `/.github/` is code-owned and the ruleset (3.E) requires the owner's approval. Recommended: grant it, because the control is the ruleset and an unusable agent invites weakening the ruleset.
A private-key file or token is stored only where the agent's tooling reads it (3.G) and is never put in chat, in the repository or in a workflow.

### 3.C [OWNER] Repository Actions settings

Settings -> **Actions** -> **General**:
- *Actions permissions*: **Allow genxttech, and select non-genxttech, actions and reusable workflows**, tick **Require actions to be pinned to a full-length commit SHA** (leave GitHub-created actions allowed; the proof uses only `actions/setup-node` and `actions/upload-artifact`).
  **Prerequisite:** `.github/workflows/e2e-public-event-registration.yml` uses unpinned tag references (`@v4`) and would stop running. Engineering opens a separate PR that pins them to SHAs **before** the owner ticks this box.
- *Fork pull request workflows from outside collaborators*: **Require approval for all external contributors**.
- *Workflow permissions*: **Read repository contents and packages permissions**; **untick** *Allow GitHub Actions to create and approve pull requests*.

### 3.D [OWNER] Environment `d24-stripe-test`

Settings -> **Environments** -> **New environment** -> name `d24-stripe-test` -> **Configure environment**:
- **Required reviewers**: tick, search `genxttech`, add **only** the owner. Tick **Prevent self-review**.
- **Wait timer**: leave unticked (none).
- **Allow administrators to bypass configured protection rules = OFF**: untick it.
- **Deployment branches and tags**: *Selected branches and tags* -> **Add deployment branch or tag rule** -> *Ref type* **Branch**, name pattern `main` -> **Add rule**. Make sure it is the only rule.
- **Environment secrets** -> **Add environment secret**: Name `D24_PROOF_STRIPE_KEY`, Value the restricted `rk_test_...` key (Invoices=Write, Customers=Write, connected-account Read; everything else None), **Add secret**. **Not** a repository secret, and not entered in chat.
  Do this only when a real run is about to be authorized (section 5 first); an environment without the secret is harmless.
- Leave *Environment variables* empty.

### 3.E [OWNER] Ruleset `Protect main`

Today's ruleset has admin bypass `always`, 0 required approvals, code-owner review off, last-push approval off, no required status check, and review-thread resolution **on** (kept on below). Replace it with the values below.
Settings -> **Rules** -> **Rulesets**: first rename the existing one to `Protect main (old)`, then **New ruleset** -> **Import a ruleset** and upload this JSON saved as `protect-main.json`, then check the imported ruleset shows **Active**, then delete `Protect main (old)`:

<!-- RULESET-JSON-BEGIN -->
```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "Typecheck, build, lint, unit/integration tests", "integration_id": 15368 }]
      }
    }
  ]
}
```
<!-- RULESET-JSON-END -->

What each value does and why:
- **Squash only**, **pull request required**, **at least 1 approval**, **Require review from Code Owners ON**, **require approval of the most recent reviewable push** ON, stale approvals dismissed on push.
  *Why the count is 1, with no 0 fallback:* the owner's approval is **the** merge boundary. With the agent authoring every pull request the owner can approve them (an author cannot approve their own pull request). One required approval from the owner, plus code-owner review and approval of the most recent push, means **no change reaches `main` without the owner**, code-owned or not, which matches the standing rule that merges need the owner's authorization. A count of 0 is **not an accepted setting**: the agent could then merge every non-code-owned change (all of `src/`, `.npmrc`, nested `package.json` files) alone once checks pass. The cost of 1 is one approval click per pull request on the owner's PC. Keep **"Allow GitHub Actions to create and approve pull requests" OFF** (3.C), otherwise a workflow could supply the approval. Review-thread resolution stays **on** (it is on today).
  Rules of use: the owner never uses the admin bypass to merge a branch the agent identity has pushed to (a last-push approval from the owner is still possible for agent-authored pull requests, but not for an owner-authored branch the agent pushed onto); and if the agent identity can approve pull requests (it can with Pull requests write), the owner never counts such an approval.
- **Bypass**: only the repository **admin role** (id 5, the owner), and only in **pull-request** mode. The bot has no bypass actor, so there is **no bypass for the agent identity**. (Role id 5 = Admin is what the current ruleset uses.)
- **Block force pushes and deletions** (`non_fast_forward`, `deletion`).
- **Required status check** `Typecheck, build, lint, unit/integration tests`, pinned to the GitHub Actions app (`integration_id` 15368), so another app or a plain status post from a third-party app cannot satisfy it. **This is a correctness gate, not a security control against the agent:** any identity with write access can run a workflow that posts a status or check under that name using its own `GITHUB_TOKEN` (and a classic token can post a status directly). The only merge boundary is the owner's approval above. **Prerequisite:** that job lives in a workflow with a `pull_request.paths` filter, so a PR outside the filter never reports the check and could never merge (the owner's admin bypass would be the only way). Engineering opens a separate PR to remove the filter (or add a trivial always-running job under the same name) **before** this ruleset is imported.
- **Restrict updates** (`update`) is deliberately **not** in the JSON: the pull-request rule already blocks direct pushes, and `update` is reported by GitHub as blocking everyone without bypass, possibly including pull-request merges (UNVERIFIED). The owner may add it as extra hardening after the harmless test in section 6.

CODEOWNERS (`.github/CODEOWNERS`, in this PR) lists the owner for **all of `/.github/`** (any workflow file could reference the environment or the secret), `package.json`, `package-lock.json`, `tsconfig.json`, `.npmrc`, `scripts/package.json`, `scripts/qa/package.json` (files that change how npm or node resolve things; the workflow also refuses to run if any of the `.npmrc` / nested `package.json` files exist),
`scripts/qa/d24-m3d-proof/`, `scripts/qa/d24-gh-proof/` (tooling, verifier and the evidence public key), this document and `vitest.config.mts`. It only bites because of the code-owner setting above.

### 3.F Merge ordering (one rule)

**Do not merge this PR until the environment (3.D), its protection rules and the ruleset (3.E) exist and the owner has checked them in the browser** (and `--as-owner-readonly`, 3.H, is clean except the secret name, which is added last).
Reason: a workflow that references an environment that does not exist makes GitHub **create it automatically, unprotected**, on first use, and after merge anyone with write access can dispatch the workflow on `main` (the job's `if:` is true on `main`).
The run would fail at the guard step (placeholders), but the unprotected environment would then exist, and a secret added later in the UI would be released without approval.
Order: 3.0 (hardware key, notifications) -> 3.A0 -> 3.C -> 3.D (without the secret) -> 3.E -> 3.A (Option B only) and 3.B -> 3.G credential transition -> 3.H verification (agent identity and owner-readonly) -> owner approves and merges this PR -> new Express sandbox and real ids/key in a follow-up PR (section 5) -> add the secret (3.D last bullet) -> dispatch.

### 3.G Credential transition on the engineering machine

Facts: the GitHub CLI keeps the owner's token in the OS keyring (`gh auth status` shows account `genxttech`, scopes repo, workflow, gist, read:org); `git push` goes through Git Credential Manager (`credential.helper=manager`) whose stored GitHub login must **also** be identified and replaced; no `GH_*` / `GITHUB_*` environment variables are set; no repository script calls `gh`.
The agent and the owner share one Windows user. The credentials below are removed as **hygiene** so the easy paths are closed; the owner's signed-in browser stays by the decision recorded in 3.0 (accepted residual), and the standing rule there forbids the agent to use it.

**Inventory (read-only; do all of it before removing anything).** Every item below is a way for this account to act as `genxttech`:
- `gh`: `gh auth status` (keyring entry for `genxttech`); `%APPDATA%\GitHub CLI\hosts.yml`.
- Git Credential Manager: Windows Credential Manager -> Windows Credentials -> entries `git:https://github.com` and `gh:github.com`; `git config --show-origin --get-all credential.helper`.
- Plain-text stores: `%USERPROFILE%\.git-credentials`, `%USERPROFILE%\.netrc`, `_netrc`.
- SSH: keys under `%USERPROFILE%\.ssh` that are registered on the `genxttech` account (check github.com -> Settings -> SSH and GPG keys; `git remote -v` for any `git@github.com:` remotes).
- Editors and desktop apps: VS Code (Accounts menu, GitHub Pull Requests extension), GitHub Desktop, JetBrains IDEs, any other tool signed in to GitHub.
- **Browsers: Chrome, Edge and the in-app browser pane** (cookies and saved passwords for github.com), and the browser-extension connection the agent can drive. **These stay signed in by the owner's decision (3.0)**; the standing rule forbids the agent to use them and the compensating controls (hardware key, notifications elsewhere) apply.
- Environment variables and scheduled tasks that carry a GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, CI helper scripts).
- The owner's terminal tabs in this app (the agent can read them): never paste or type owner material there.
- **Re-acquisition paths to close:** Git Credential Manager can open an interactive OAuth sign-in and `gh auth login --web` shows a device code the owner could be asked to complete; set `git config --global credential.interactive never` and the user environment variable `GCM_INTERACTIVE=never` for this account so a prompt cannot be used to obtain a new owner token here.

**Steps**
1. **Add the agent credential.** Option A: store the App private key file at a protected path (user-only ACL, outside any repository) and let engineering mint installation tokens per session. Option B: `gh auth login --hostname github.com --git-protocol https --with-token` reading the bot's token from stdin (it must not appear in a terminal tab that later shows owner material); then `gh auth switch --user danceflow-engineering-bot` and `gh auth setup-git`.
2. **Verify ordinary development works as the agent identity:** the token's user (Option B) or installation (Option A) is the expected one; clone/fetch; push a throwaway branch `bot-verify/<date>`; open a **draft** PR; close it; delete the branch.
3. **Verify admin operations are refused:** run the read-only verifier (3.H) `--as-bot` or `--as-app`. Run it after 3.D, because a missing environment makes some refusals vacuous (the verifier fails in that case).
4. **Remove the owner's `genxttech` token / `gh` login and every other owner credential** found by the inventory: `gh auth logout --hostname github.com --user genxttech`; delete the Credential Manager entries that hold the owner's login (`git credential-manager github logout genxttech`, or delete them in the Credential Manager UI); remove the owner's SSH keys from `.ssh` or deregister them from the account; sign the owner out of VS Code and GitHub Desktop. (The owner's browser session is the accepted residual of 3.0 and is **not** removed.) Re-run the inventory and confirm that nothing for `genxttech` remains **except the browser session**.
5. **Then, after dependencies have been found, recommend revoking or rotating** the owner's old `gho_` token (GitHub -> Settings -> Applications) and any owner PATs. This is a **separate approval**: other tools may depend on that grant, and revoking it too early breaks them.
6. After 4., the agent can no longer act as `genxttech` **through the non-browser credentials that were found and removed**. It still can through the owner's signed-in browser, which is the accepted residual in 3.0; anything the inventory missed reopens more paths.

### 3.H Read-only verification (`scripts/qa/d24-gh-proof/verify-github-config.ts`)

Sends only `GET` requests, through a default-deny allow-list of exact paths; reads its token from `D24_GH_VERIFY_TOKEN`; prints fixed ids and enumerated values only (never the token, never a secret value). **If the output has no final `RESULT:` line, treat the run as failed** (a tool that did not start prints nothing).
- `--as-bot` (the bot's classic token) / `--as-app` (an App installation token): confirms the identity (the bot is `write`, with a present `role_name`, not `admin`/`maintain`; the installation covers exactly this repository), that it **cannot bypass the ruleset** (`current_user_can_bypass` is `never`), that the environment exists, and that five endpoints are refused (repository secrets, Actions permissions, workflow permissions, environment secrets, webhooks). **This is five GET checks plus a role and a bypass check; it does not prove the identity cannot approve deployments, merge or change settings.** Those rest on the role, the ruleset and the reviewer list.
- `--as-owner-readonly`: compares the ruleset (above JSON, including the pinned status-check source, every listed parameter and a report of parameters it does not know), the environment (reviewer = owner only, prevent self-review, admin bypass off, branch policy `main` only, no wait timer, secret **name** present), the repository Actions settings (including `allowed_actions: selected`), pending invitations, CODEOWNERS parse errors and the direct collaborators.
- **Token handling for `--as-owner-readonly`:** run it by the owner, in a terminal window that is not one of this app's terminal tabs (the agent can read those). Create a fresh fine-grained token **as `genxttech`** with Administration: Read, Environments: Read, Secrets: Read, Metadata: Read, 1-day expiry, for this repository only; set it as `D24_GH_VERIFY_TOKEN` in a throwaway process from a prompt or a file (never on a command line, in shell history or in a pasted command); revoke the token afterwards. The agent never needs to see it, and the standing rule of 3.0 forbids using it.
Any deviation or any inconclusive answer exits 1 (fail closed).

## 4. What is and is not a security boundary

Is (after 3.0-3.H):
- The restricted TEST key lives only in a GitHub environment secret. It is released only to a job on `main` that a required reviewer (the owner) approved.
- The workflow file, all of `/.github/`, the harness, the tooling and the node inputs (`package*.json`, `tsconfig.json`) are code-owned and the ruleset requires owner approval for every merge, so changing them needs the owner.
- The key never appears in logs (masked by GitHub, never echoed, output redirected to a file), and evidence leaves the runner only encrypted.
- The harness itself bounds blast radius: TEST-mode key only, 40 requests, allow-listed endpoints, pinned accounts.

Is not:
- **An independent boundary against a deliberately hostile agent on the owner's Windows account.** The owner approves on the same PC (accepted residual, 3.0). The gates constrain an agent that behaves as its bot, App or token; the compensating controls (hardware key for settings, notifications elsewhere) make misuse visible, they do not prevent it.
- **A control over Vercel preview builds or any other installed GitHub App.** A branch the agent pushes may be built by Vercel with Preview environment variables; see 3.A0 (UNVERIFIED). Nothing in the GitHub settings of 3.C-3.E limits that.
- **A control over the required status check.** Any write-role identity can post a status or run a workflow that reports under that name; the owner's approval is the only merge boundary (3.E).
- **Isolation of the key step from earlier steps.** The scrubbed environment (`env -i`, absolute binaries, empty `BASH_ENV`/`ENV`) narrows what an earlier step can influence; it does not isolate the step: a node process can still write to the runner's file-command files, whose location is predictable. It is not exploitable beyond the already-trusted pinned `tsx` and harness, because the same code runs in the live step.
- **Protection of the evidence from the agent identity**: it can cancel or delete runs, logs and artifacts (destroying evidence, not forging it), and any branch workflow can reuse the concurrency group `d24-stripe-test-proof` with `cancel-in-progress: true` to cancel a live run so harness cleanup is skipped. The owner records the run id at approval; section 5 reconciliation catches leftover TEST objects.
- **The approval is bound to a commit SHA and a workflow path read by eye, not to a cryptographic envelope.** The owner compares them; GitHub does not verify the pinned manifest for them. The SHA identifies a whole tree, of which the owner has reviewed only the code-owned parts.
- **Agent-modifiable even with the identity split and the code-owner rule:** dispatching (and therefore auto-creating a missing environment), re-runs, and the private evidence key and everything decrypted with it.
- **Engineering holds the evidence private key.** Anything the run puts in its output reaches engineering. The terminal output is bundled in full; if the harness's redaction ever failed, or a compromised dependency wrote the key to stdout, the key would reach the agent's machine.
  This contradicts the aim "the key never sits on a developer machine" in that failure case; the remaining protection is the harness redaction and the pinned inputs. (Dropping `--terminal` from the encrypt step would remove the raw terminal text from the bundle at the cost of diagnostics.)
- **The runner image and egress.** `ubuntu-24.04` is a moving image label, not a pinned image, and there is no egress restriction: code running in the job can send the key anywhere. The scrubbed environment, tool-cache node, pinned inputs (including the tooling) and stray-process check narrow this; they do not remove it. Accepted only because the key is a restricted TEST-mode key.
- **A stray process under another name.** The stray-process check only covers `node` and `esbuild`.
- The runner is GitHub-hosted: GitHub, the two pinned actions and the npm registry are in the trust path. A re-run with debug logging (`ACTIONS_STEP_DEBUG`) can be enabled by anyone with write access; secrets stay masked, but verbose logs are in the trust path.
- Anyone with write access can dispatch (then the owner approval gates it). A repository admin (the owner) can edit environment settings, protection rules and secrets.
- The public repository means workflow logs and artifacts are world-readable. The design assumes that: only ciphertext, counts and hashes are public. (The "what was approved" summary is written after approval; before approval only the run title and workflow path are visible.)

### Residual P2 (future risk, not present today): repository-level secrets

Today the repository has **0 repository-level Actions secrets and 0 variables** (observed read-only by the reviewer on 2026-11-08), so there is nothing for a write-role agent to read through a branch workflow. The principle is what matters for later: GitHub gives any user with write access read access to repository-level secrets through a workflow in their own branch. If the E2E workflow (`.github/workflows/e2e-public-event-registration.yml`, which today expects `E2E_*` values) is ever given repository-level secrets, they become readable by the agent identity. Put any such credential in a protected environment (required reviewer = the owner, deployment branches limited) instead. The verifier (`--as-owner-readonly`) fails if any `D24*` secret exists at repository level and reports the count of others.

## 5. Dashboard request-log reconciliation, and the sandbox that must exist first

**Independent reconciliation needs a Dashboard glance.** The harness's own count and cleanup are not an independent record. Stripe offers **no API to read the request log**, and the Events API covers only events caused by writes (not reads, and not rejected requests), so it cannot prove "no other calls were made".
Owner decision per proof run (pick one and record it before the first run):
- **(a) Dashboard glance, about 1 minute per proof**: the owner (or whoever holds the sandbox Dashboard) opens Developers -> Logs for the sandbox and the connected account for the run's time window and compares the request count and paths with the expected list engineering produces from the decrypted evidence, plus "no customers or invoices remain on the connected account". Discrepancies are a failed run.
- **(b) Accept engineering's Events-API plus list-endpoint reconciliation** for the throwaway TEST sandbox: engineering lists events and objects through the API and compares them to the harness transcript. Weaker (blind to reads and to calls that created nothing), acceptable only if the owner explicitly accepts that for a throwaway sandbox with a restricted key.
Procedure for (a): see `D24-REQUEST-RECONCILIATION.md` and the README of `scripts/qa/d24-m3d-proof`.

**A new production-equivalent Express connected account must exist before any proof.** The previous test account failed the harness identity gate (it was not Express-equivalent), so no proof can pass against it. Creating the new sandbox account is itself a Stripe write that needs its **own separately authorized provisioning workflow and key**; it is not part of this change, and the account ids in the workflow stay placeholders until it exists.

## 6. UNVERIFIED GitHub behaviours (none has been tested) and the harmless check for each

Everything below is from memory of GitHub's documentation, not observed on this repository. Each has an exact check that changes nothing.

| Item | Harmless verification |
|---|---|
| Personal repositories have only owner and collaborator levels; a collaborator cannot open Settings, secrets, rulesets or environments (the GitHub documentation page for collaborators does not cover them) | As the agent identity, open `https://github.com/genxttech/danceflow-app/settings` (expect 404) and run `--as-bot` / `--as-app` after 3.D |
| What the **approval screen** shows (SHA, workflow path, run name), including for a different workflow that uses the same environment | Create a throwaway environment `d24-verify-throwaway` with a required reviewer and no secret, run a no-op workflow that references it from a throwaway branch with a **`push` trigger** (`workflow_dispatch` only works for a workflow file that is already on the default branch, so it cannot be used from a branch), look at the approval screen, then delete the environment. Never reference `d24-stripe-test` |
| **Prevent self-review**, whether a re-run needs re-approval, and whether the agent identity re-running counts as the initiator | In the same throwaway environment (push trigger), start a run as the agent identity and as the owner, observe who can approve; re-run and observe. Standing rule until known: the owner never dispatches or re-runs |
| Vercel behaviour for commits by a non-team author on a public repository, and which Preview variables exist | The checklist in 3.A0 (read-only in the Vercel dashboard) |
| Whether creating a deployment through the API with a new environment name creates that environment unprotected (classic token `repo_deployment`) | Not tested; avoided by creating `d24-stripe-test` (3.D) before any agent credential exists |
| Semantics of the ruleset parameter `require_extra_approval_for_unattributed_changes` and of an empty `required_reviewers` list (both returned by GitHub today) | Reported by the verifier as parameters it does not cover; read GitHub's ruleset documentation before relying on either |
| Import of the minimal ruleset JSON in 3.E (no `source_type`/`source`) | Import it; the verifier then reads back every listed parameter |
| **Allow administrators to bypass = OFF** and what the admin can still do | Read it back with `--as-owner-readonly` (`environment-admin-bypass-off`) |
| `sha_pinning_required`, `allowed_actions` and the *fork-pr-contributor-approval* endpoint names | `--as-owner-readonly` reports INCONCLUSIVE if a field or endpoint is absent |
| Whether code-owner review is enforced when `required_approving_review_count` is 0 | Open a draft PR that touches only `CODEOWNERS`-listed files with a count of 0 in a throwaway ruleset on a throwaway branch pattern (not `main`); observe the merge box |
| Whether *Restrict updates* blocks pull-request merges | Same throwaway branch pattern with an `update` rule; observe the merge box |
| Free-plan availability of rulesets, environment required reviewers and secrets on a public personal repo | Observed while doing 3.D and 3.E (the options simply exist or do not); the verifier then confirms the stored values |
| Artifact and log visibility on a public repo; artifact retention behaviour with `retention-days: 3` | Secret-free workflow on a branch uploading a dummy artifact; read it logged out |
| `ubuntu-24.04` Docker availability for the runner user; the setup-node tool-cache layout `$RUNNER_TOOL_CACHE/node/24.14.1/x64/{bin/node,lib/node_modules/npm/bin/npm-cli.js}`; `npm ci --ignore-scripts` leaving `tsx` runnable | Same secret-free workflow: `docker ps`, `ls` of the cache path, `npm ci --ignore-scripts` then `tsx --version`. A different layout fails closed at the first node step |
| `GITHUB_ENV` versus job-level env precedence (only the three plaintext paths travel through it) | Same secret-free workflow |
| GitHub App permission names (Contents, Pull requests, Actions, Workflows, Metadata) and that an installation token is limited to the installed repository | Read at the App creation page; `--as-app` checks the installation scope and five refusals |

Verified negative (GitHub documentation): a fine-grained personal access token cannot be used by a collaborator on another user's repository, so the bot account cannot have one for this repository. Verified (GitHub documentation): environment branch rules are matched against `GITHUB_REF`, so `pull_request` runs (`refs/pull/N/merge`) can never match `main`; users who initiate a deployment cannot approve it with prevent self-review; re-runs reuse the original SHA and ref.
Verified (read-only `gh api` against GitHub's tags, by the independent reviewer): `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` is v4.4.0 and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` is v4.6.2.

All secret-free verification workflows run only after the owner agrees, and must not reference `d24-stripe-test` (a unit test fails any other workflow that does).

## 7. Evidence key lifecycle

Generate an RSA-4096 keypair **offline** on an engineering machine, keep the private half off the repository and off GitHub, and replace
`scripts/qa/d24-gh-proof/evidence-public-key.pem` with the public half in a code-owner-reviewed PR. The workflow refuses anything that is
not an RSA public key of at least 4096 bits. Decrypt with:

```bash
node --import tsx scripts/qa/d24-gh-proof/decrypt-cli.ts --in d24-proof-evidence.enc.json --private-key <offline private key> --out <new empty dir> --expect-ciphertext-sha256 <hash from the job summary>
```

If the private key is lost or exposed, the evidence for runs under it is lost or readable respectively; rotate by committing a new public key (reviewed) before the next run.
