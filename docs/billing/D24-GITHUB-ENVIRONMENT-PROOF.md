# D24 Stripe TEST proof: GitHub environment option

Status: **built, inactive.** Nothing in this change runs, configures GitHub, or touches Stripe. The workflow
(`.github/workflows/d24-stripe-test-proof.yml`) does nothing until the owner creates the `d24-stripe-test` environment and its secret,
and it fails closed while the account ids or the evidence key are placeholders.

Owner-approved intent: engineering operates the Stripe TEST-mode proof; the owner only approves each run, and the restricted TEST key
never needs to sit on a developer machine or in this conversation.

Facts this design rests on: `genxttech/danceflow-app` is a **public** repository owned by a **personal** user account (not an organization), on the free plan.
Engineering will act as a dedicated GitHub account, `danceflow-engineering-bot` (2FA by authenticator app), never as the owner.
**Everything below that says "engineering cannot" is true only after section 3 is completed and verified.** Until then nothing here is a control.

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
   Every node/npm step runs from the tool-cache binary by absolute path in a scrubbed environment (`env -i`, explicit `PATH`), so nothing an earlier step put in `GITHUB_ENV` / `GITHUB_PATH` reaches the process that holds the key.
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
| Node | exact version in `actions/setup-node`, and the same version in the tool-cache path | unit test |

The unit tests make the pins equal to the repository content at the same commit, so changing any pinned input forces a reviewed update of the workflow file **only if the tests run and are required** (3.E).

**Placeholders currently in the PR:** the two account ids (`acct_PLACEHOLDER...`) and the evidence public key. Real values arrive in a
later, code-owner-reviewed PR after a **new production-equivalent Express connected account** exists (section 5) and the keypair has been generated offline.

## 3. Owner setup sequence (one sequence, in this order)

Owner-only actions are marked **[OWNER]**. Engineering does the rest locally and never touches GitHub settings. Run section 3.H after each stage that changes something.

### 3.A [OWNER] Invite the bot as a collaborator

1. github.com -> `genxttech/danceflow-app` -> **Settings** -> **Collaborators** (left menu: *Access* -> *Collaborators*) -> **Add people**.
2. Type `danceflow-engineering-bot`, choose it, **Add**. (On a personal repository there is normally **no role dropdown**: a collaborator gets read/write access. UNVERIFIED, see section 6; if a dropdown does appear, choose **Write**, never Maintain or Admin.)

What a collaborator on a personal repository **can** do (expected, UNVERIFIED): clone, fetch, push branches, open and update pull requests, comment, merge a pull request **when the ruleset allows it**, dispatch and re-run workflows, read Actions logs.
What a collaborator **cannot** do (expected, UNVERIFIED): open **Settings**, read or write secrets or variables, create or edit environments or rulesets, change Actions settings, change collaborators, delete the repository.
Two things a collaborator can still do and that matter here: **dispatch the workflow** (a reference to a missing environment would auto-create it unprotected, hence the merge-order rule below) and **edit any workflow in a PR branch** (hence CODEOWNERS on all of `/.github/`).
`danceflow-engineering-bot` must **not** be a required reviewer on the environment, must **not** be a code owner, and must **not** be in any ruleset bypass list.

### 3.B [OWNER] Bot accepts, and the bot's credential

A token created by `genxttech` **always acts as the user who created it**, so it can never be the agent's credential: it would be the repository owner, the only admin, the code owner and the environment's reviewer. The agent needs a **separate identity**; this is it.

1. Sign in as `danceflow-engineering-bot` (authenticator app) in a private browser window -> github.com notifications or the invitation e-mail -> **Accept invitation**.
2. As the bot: avatar -> **Settings** -> **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens** -> **Generate new token**.
   - **Resource owner:** the bot is a collaborator on a repository **owned by another user**. Fine-grained tokens are created for a resource owner that is the user or an organization; whether a collaborator on someone else's *personal* repository can select it is **UNVERIFIED and may not be possible** (GitHub has documented limits here). If `danceflow-app` does not appear under *Only select repositories* for any resource owner, **do not widen anything**; use the fallback below.
   - **Expiration:** 90 days (put the date in the calendar; rotate before it).
   - **Repository access:** *Only select repositories* -> `genxttech/danceflow-app` only.
   - **Permissions:** Contents **Read and write**; Pull requests **Read and write**; Metadata **Read** (automatic); Actions **Read and write** (needed to dispatch the proof workflow and re-run CI); Workflows **Read and write** (see the trade-off below).
     **No** Administration, Environments, Secrets, Deployments, Variables, Webhooks, or anything else.
   - Workflows permission trade-off: **without** it the bot cannot push any change under `.github/workflows/` (GitHub refuses), which makes workflow edits impossible for the bot, a useful extra barrier but it blocks legitimate CI maintenance; **with** it the bot can push a workflow change to a branch and open a PR, but it still **cannot merge it to `main`** because `/.github/` is code-owned and the ruleset (3.E) requires owner approval. Recommended: **grant it**, because the real control is the ruleset and an unusable bot invites weakening the ruleset; revisit if the owner prefers the extra barrier.
3. **Fallbacks if the fine-grained token cannot target this repository** (decide with the owner; each is weaker or heavier): (i) a **classic** personal access token for the bot with scopes `repo` and `workflow` only. Classic tokens cannot be limited to one repository, but the bot can reach only the repositories it was invited to (one), and a Write-level account cannot use admin endpoints; the verifier (3.H) proves this. (ii) A **GitHub App** installed on this repository only (permissions as above), with installation tokens minted from a private key held by engineering; most precise, most work. (iii) An SSH key for push only (no PR creation).
4. The bot's token is stored only where the agent's tooling reads it (3.G). It is never put in chat, in the repository or in a workflow.

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

Today's ruleset has admin bypass `always`, 0 required approvals, code-owner review off, last-push approval off and no required status check. Replace it with the values below.
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
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "Typecheck, build, lint, unit/integration tests" }]
      }
    }
  ]
}
```
<!-- RULESET-JSON-END -->

What each value does and why:
- **Squash only**, **pull request required**, **at least 1 approval**, **Require review from Code Owners ON**, **require approval of the most recent reviewable push** ON, stale approvals dismissed on push.
  *Why the count is 1 and not 0:* with the bot authoring every pull request, the owner can approve them (an author cannot approve their own PR, so while the owner authored the PRs this setting would have been unusable). One required approval means **no change reaches `main` without the owner**, code-owned or not, which matches the standing rule that merges need the owner's authorization. With a count of 0, code-owner review would still apply to code-owned paths but the bot could merge any non-code-owned change (all of `src/`) alone once checks pass. The cost of 1 is one browser click per PR; if that is too heavy, 0 is the fallback, and the owner accepts that the bot can merge non-code-owned changes unilaterally. (Whether code-owner review is enforced when the count is 0 is UNVERIFIED.)
- **Bypass**: only the repository **admin role** (id 5, the owner), and only in **pull-request** mode. The bot has no bypass actor, so there is **no bypass for the agent identity**. (Role id 5 = Admin is what the current ruleset uses.)
- **Block force pushes and deletions** (`non_fast_forward`, `deletion`).
- **Required status check** `Typecheck, build, lint, unit/integration tests`, the CI job that runs these workflow tests. **Prerequisite:** that job lives in a workflow with a `pull_request.paths` filter, so a PR outside the filter never reports the check and could never merge (the owner's admin bypass would be the only way). Engineering opens a separate PR to remove the filter (or add a trivial always-running job under the same name) **before** this ruleset is imported.
- **Restrict updates** (`update`) is deliberately **not** in the JSON: the pull-request rule already blocks direct pushes, and `update` is reported by GitHub as blocking everyone without bypass, possibly including pull-request merges (UNVERIFIED). The owner may add it as extra hardening after the harmless test in section 6.

CODEOWNERS (`.github/CODEOWNERS`, in this PR) lists the owner for **all of `/.github/`** (any workflow file could reference the environment or the secret), `package.json`, `package-lock.json`, `tsconfig.json`,
`scripts/qa/d24-m3d-proof/`, `scripts/qa/d24-gh-proof/` (tooling, verifier and the evidence public key), this document and `vitest.config.mts`. It only bites because of the code-owner setting above.

### 3.F Merge ordering (one rule)

**Do not merge this PR until the environment (3.D), its protection rules and the ruleset (3.E) exist and the owner has checked them in the browser** (and `--as-owner-readonly`, 3.H, is clean except the secret name, which is added last).
Reason: a workflow that references an environment that does not exist makes GitHub **create it automatically, unprotected**, on first use, and after merge anyone with write access can dispatch the workflow on `main` (the job's `if:` is true on `main`).
The run would fail at the guard step (placeholders), but the unprotected environment would then exist, and a secret added later in the UI would be released without approval.
Order: 3.A -> 3.B -> 3.C -> 3.D (without the secret) -> 3.E -> 3.G token transition -> 3.H verification -> owner approves and merges this PR -> new Express sandbox and real ids/key in a follow-up PR (section 5) -> add the secret (3.D last bullet) -> dispatch.

### 3.G Token transition on the engineering machine

Facts: the GitHub CLI keeps the owner's token in the OS keyring (`gh auth status` shows account `genxttech`, scopes repo, workflow, gist, read:org); `git push` goes through Git Credential Manager (`credential.helper=manager`) whose stored GitHub login must **also** be identified and replaced; no `GH_*` / `GITHUB_*` environment variables are set; no repository script calls `gh`.
The agent and the owner share one OS user, so separation is achieved by **removing** the owner's credentials, not by hiding them.

1. **Inventory (read-only).** `gh auth status`; Windows Credential Manager -> Windows Credentials -> entries starting `git:https://github.com` (and `gh:github.com`); `git config --show-origin --get-all credential.helper`; any IDE, extension or scheduled task signed in to GitHub. **Also: the Chrome/browser sessions the agent can drive are the owner's signed-in sessions.** Do not give the agent a browser that is signed in as `genxttech`; use a separate profile.
2. **Add the bot (owner types the token; it never passes through chat).** In a terminal: `gh auth login --hostname github.com --git-protocol https --with-token` then paste the bot token. `gh auth status` now lists both accounts. Run `gh auth switch --user danceflow-engineering-bot`, then `gh auth setup-git` so `git` uses `gh` for credentials.
3. **Verify ordinary development works as the bot:** `gh api user --jq .login` prints the bot; clone/fetch; push a throwaway branch `bot-verify/<date>`; open a **draft** PR; close it; delete the branch. All must work.
4. **Verify admin operations are refused:** run the read-only verifier (3.H, `--as-bot`). Every settings, secrets, environment and webhook endpoint must be refused.
5. **Remove the owner's `genxttech` token / `gh` login and every other owner credential from agent-accessible stores:** `gh auth logout --hostname github.com --user genxttech`; delete the `git:https://github.com` Credential Manager entry that holds the owner's login (`git credential-manager github logout genxttech`, or delete it in the Credential Manager UI); re-run step 1 to confirm nothing for `genxttech` remains. From here the machine can no longer act as the owner.
6. **Then, after dependencies have been found, recommend revoking or rotating** the owner's old `gho_` token (GitHub -> Settings -> Applications) and any owner PATs. This is a **separate approval**: other tools may depend on that grant, and revoking it too early breaks them.
7. Owner actions from now on happen **in the owner's own browser**: approving and merging PRs, approving proof runs, changing settings.

### 3.H Read-only verification (`scripts/qa/d24-gh-proof/verify-github-config.ts`)

Sends only `GET` requests, through a default-deny allow-list of exact paths; reads its token from `D24_GH_VERIFY_TOKEN`; prints fixed ids and enumerated values only (never the token, never a secret value).
- `--as-bot` (token = the bot's): the token is the bot; the bot is `write`, not `admin`/`maintain`; repository secrets, Actions permissions, workflow permissions, environment secrets and webhooks are **refused** (403/404).
- `--as-owner-readonly` (a token able to read settings; the owner's, used from the owner's own machine or session, never stored on the agent machine): compares the ruleset (above JSON), the environment (reviewer = owner only, prevent self-review, admin bypass off, branch policy `main` only, no wait timer, secret **name** present), the repository Actions settings and the list of direct collaborators.
Any deviation or any inconclusive answer exits 1 (fail closed). Example: `D24_GH_VERIFY_TOKEN=<token> node --import tsx scripts/qa/d24-gh-proof/verify-github-config.ts --as-bot`.

## 4. What is and is not a security boundary

Is (after 3.A-3.H):
- The restricted TEST key lives only in a GitHub environment secret. It is released only to a job on `main` that a required reviewer (the owner) approved.
- The workflow file, all of `/.github/`, the harness, the tooling and the node inputs (`package*.json`, `tsconfig.json`) are code-owned and the ruleset requires owner approval for every merge, so changing them needs the owner.
- The key never appears in logs (masked by GitHub, never echoed, output redirected to a file), and evidence leaves the runner only encrypted.
- The harness itself bounds blast radius: TEST-mode key only, 40 requests, allow-listed endpoints, pinned accounts.

Is not:
- **Anything, if the agent can still act as the owner (3.G).** This is the precondition for every other claim.
- **The approval is bound to a commit SHA and a workflow path read by eye, not to a cryptographic envelope.** The owner compares them; GitHub does not verify the pinned manifest for them. The SHA identifies a whole tree, of which the owner has reviewed only the code-owned parts.
- **Agent-modifiable even with the identity split and the code-owner rule:** dispatching (and therefore auto-creating a missing environment), re-runs, and the private evidence key and everything decrypted with it.
- **Engineering holds the evidence private key.** Anything the run puts in its output reaches engineering. The terminal output is bundled in full; if the harness's redaction ever failed, or a compromised dependency wrote the key to stdout, the key would reach the agent's machine.
  This contradicts the aim "the key never sits on a developer machine" in that failure case; the remaining protection is the harness redaction and the pinned inputs. (Dropping `--terminal` from the encrypt step would remove the raw terminal text from the bundle at the cost of diagnostics.)
- **The runner image and egress.** `ubuntu-24.04` is a moving image label, not a pinned image, and there is no egress restriction: code running in the job can send the key anywhere. The scrubbed environment, tool-cache node, pinned inputs and stray-process check narrow this; they do not remove it. Accepted only because the key is a restricted TEST-mode key.
- **A stray process under another name.** The stray-process check only covers `node` and `esbuild`.
- The runner is GitHub-hosted: GitHub, the two pinned actions and the npm registry are in the trust path. A re-run with debug logging (`ACTIONS_STEP_DEBUG`) can be enabled by anyone with write access; secrets stay masked, but verbose logs are in the trust path.
- Anyone with write access can dispatch (then the owner approval gates it). A repository admin (the owner) can edit environment settings, protection rules and secrets.
- The public repository means workflow logs and artifacts are world-readable. The design assumes that: only ciphertext, counts and hashes are public. (The "what was approved" summary is written after approval; before approval only the run title and workflow path are visible.)

### Residual P2: repository-level secrets are readable by a write-role bot (outside Stripe scope)

`.github/workflows/e2e-public-event-registration.yml` uses **repository-level** secrets (`E2E_SUPABASE_*`) and runs on same-repository `pull_request`. A write-role collaborator can edit that workflow in its PR branch and the run receives those secrets (the file is code-owned, but a `pull_request` run uses the branch's version before any review). This does not touch Stripe, but it is a real exposure of test-environment credentials.
**Recommended owner action (not done here; that workflow's secret usage is deliberately not edited in this change):** move the `E2E_*` secrets into a protected environment (for example `e2e-test`, required reviewer = owner, deployment branches limited), reference that environment in a reviewed change, then delete the repository-level copies. Until then, treat those credentials as readable by the bot and rotate them if ever abused. The verifier (`--as-owner-readonly`) counts repository-level secrets and fails if any `D24*` secret exists at repository level.

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
| Personal repositories have only owner and collaborator levels; a collaborator cannot open Settings, secrets, rulesets or environments | As the bot, open `https://github.com/genxttech/danceflow-app/settings` (expect 404) and run `--as-bot` |
| Whether a collaborator on another user's personal repo can make a fine-grained token that targets it | At the bot's token-creation page, look for `danceflow-app` under *Only select repositories*; if absent, use the fallback in 3.B |
| What the **approval screen** shows (SHA, workflow path, run name), including for a different workflow that uses the same environment | Create a throwaway environment `d24-verify-throwaway` with a required reviewer and no secret, dispatch a no-op workflow on a branch that references it, look at the approval screen, then delete the environment. Never reference `d24-stripe-test` |
| **Prevent self-review**, and whether a re-run needs re-approval | In the same throwaway environment, dispatch as the owner and as the bot and observe who can approve; re-run and observe |
| **Allow administrators to bypass = OFF** and what the admin can still do | Read it back with `--as-owner-readonly` (`environment-admin-bypass-off`) |
| `sha_pinning_required` field and the *fork-pr-contributor-approval* endpoint names | `--as-owner-readonly` reports INCONCLUSIVE if a field or endpoint is absent |
| Whether code-owner review is enforced when `required_approving_review_count` is 0 | Open a draft PR that touches only `CODEOWNERS`-listed files with a count of 0 in a throwaway ruleset on a throwaway branch pattern (not `main`); observe the merge box |
| Whether *Restrict updates* blocks pull-request merges | Same throwaway branch pattern with an `update` rule; observe the merge box |
| Free-plan availability of rulesets, environment required reviewers and secrets on a public personal repo | Observed while doing 3.D and 3.E (the options simply exist or do not); the verifier then confirms the stored values |
| Artifact and log visibility on a public repo; artifact retention behaviour with `retention-days: 3` | Secret-free workflow on a branch uploading a dummy artifact; read it logged out |
| `ubuntu-24.04` Docker availability for the runner user; the setup-node tool-cache layout `$RUNNER_TOOL_CACHE/node/24.14.1/x64/{bin/node,lib/node_modules/npm/bin/npm-cli.js}`; `npm ci --ignore-scripts` leaving `tsx` runnable | Same secret-free workflow: `docker ps`, `ls` of the cache path, `npm ci --ignore-scripts` then `tsx --version`. A different layout fails closed at the first node step |
| `GITHUB_ENV` versus job-level env precedence (only the three plaintext paths travel through it) | Same secret-free workflow |
| Fine-grained token permission names (Contents, Pull requests, Actions, Workflows, Metadata) | Read at the token-creation page; the verifier proves what the token cannot do |

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
