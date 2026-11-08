# D24 Stripe TEST proof: GitHub environment option

Status: **built, inactive.** Nothing in this change runs, configures GitHub, or touches Stripe. The workflow
(`.github/workflows/d24-stripe-test-proof.yml`) does nothing until the owner creates the `d24-stripe-test` environment and its secret,
and it fails closed while the account ids or the evidence key are placeholders.

Owner-approved intent: engineering operates the Stripe TEST-mode proof; the owner only approves each run, and the restricted TEST key
never needs to sit on a developer machine or in this conversation.

**Read section 3 first.** Every control below depends on the engineering agent acting as a *different GitHub identity with write access only*.
If the agent acts as the owner's account (for example through a fine-grained token created by the owner), there is no separation and none of the approvals mean anything.

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
| Harness manifest SHA-256 | `D24_PROOF_PINNED_SHA256` | the job (`--print-hash` must equal it; note this is computed by the harness itself, so it is a consistency check, the tree id is the independent one) and a unit test |
| `package.json`, `package-lock.json`, `tsconfig.json` SHA-256 | `D24_PIN_*_SHA256` | the job (`sha256sum`, before `npm ci`); unit tests. A changed lockfile breaks the run until the pin is updated under code-owner review |
| Workflow identity | `D24_WORKFLOW_REF_EXPECTED` vs `github.workflow_ref` | the job's guard step. This protects only the real file; the control against a *rogue* file is CODEOWNERS on all of `/.github/` |
| Platform and connected account ids | `D24_PROOF_EXPECT_PLATFORM_ACCT` / `_CONNECTED_ACCT` | the harness identity gate; the guard step refuses `PLACEHOLDER` (substring check; the owner must compare real ids to the sandbox dashboard during code-owner review) |
| Authorization sentence | `D24_PROOF_AUTHORIZATION` | The harness was designed around an owner-typed approval sentence. In this option that sentence is **a constant supplied by this reviewed file** (test-checked equal to the harness constant). The owner's approval click on the environment *is* the authorization; the sentence control is retired as a human gate |
| Evidence public key | `scripts/qa/d24-gh-proof/evidence-public-key.pem` | `encrypt-cli.ts --check-key` runs **before** any Stripe request and refuses a placeholder, a private key, a non-RSA or sub-4096-bit key |
| Actions | two official actions, each pinned to a full commit SHA | unit test (no tag, no short SHA, nothing else) |
| Node | exact version in `actions/setup-node`, and the same version in the tool-cache path | unit test |

The unit tests make the pins equal to the repository content at the same commit, so changing any pinned input forces a reviewed update of the workflow file **only if the tests run and are required** (section 3, step 3).

**Placeholders currently in the PR:** the two account ids (`acct_PLACEHOLDER...`) and the evidence public key. Real values arrive in a
later, code-owner-reviewed PR after the corrected test sandbox exists and the keypair has been generated offline.

## 3. Owner steps (browser; the agent identity does none of these)

About five browser actions. They only work if step 1 is done properly.

1. **Give the agent its own identity with WRITE only.** A fine-grained personal access token **always acts as the user who created it.** A token the owner (`genxttech`) creates is still `genxttech`:
   the repository owner, the sole admin, the code owner and the environment's required reviewer. It would let the agent approve its own run, use the admin ruleset bypass, and author PRs that the
   code owner cannot approve (an author cannot approve their own PR). So:
   - Create a **separate identity**: a second GitHub account / machine user added as a collaborator, or a GitHub App installation. In a personal-account repository a collaborator has a fixed role; give it **Write** only (not Maintain, not Admin).
   - The agent identity must **not** be a required reviewer on the environment, must **not** be a code owner, and must **not** be in any ruleset bypass list.
   - The agent uses that identity's own fine-grained token (repository contents / pull requests / issues / workflows as needed for normal PRs; **no** Administration, Environments, Secrets, Deployments).
   - **Remove the owner's `genxttech` token / `gh` login from this machine** (sign the CLI out, revoke the OAuth grant and any PATs) before the agent is relied on. Until that is done, nothing in this document is a control.
   - **What the owner verifies in the browser:** Settings -> Collaborators shows the agent identity with **Write**; Settings -> Environments -> `d24-stripe-test` lists only the owner as reviewer; the ruleset bypass list does not contain the agent identity;
     Settings -> Developer settings / Applications shows no live token for `genxttech` on the agent's machine; and, as a negative test the owner can run, that the agent identity gets 403/404 on the environment settings and secrets pages.
     Collaborator powers in a personal repository are UNVERIFIED (section 6): check that a Write collaborator cannot edit environments, rulesets or secrets.
2. **Create the environment** `d24-stripe-test` (Settings -> Environments): *Required reviewers* = the owner; **Prevent self-review** on; **Allow administrators to bypass configured protection rules = OFF**;
   *Deployment branches and tags* = **Selected branches: `main` only**; add the **environment secret** `D24_PROOF_STRIPE_KEY` = the restricted `rk_test_...` key (Invoices=Write, Customers=Write, connected-account Read; everything else None).
   The key is an environment secret, **not** a repository secret.
3. **Ruleset for `main`** (the current "Protect main" ruleset has: Admin bypass `always`, 0 required approvals, code-owner review off, last-push approval off, no required status checks; that is not enough). Set:
   - *Require a pull request before merging* with **at least 1 approval**, **Require review from Code Owners ON**, **Require approval of the most recent reviewable push ON**, dismiss stale approvals ON;
   - **no bypass for the agent identity**; bypass for the repository admin (the owner) only, and preferably "pull request only" rather than `always`;
   - a **required status check** that includes these workflow tests (the CI job "Typecheck, build, lint, unit/integration tests"; it must run for every PR, see the path-filter note below).
   Without these, CODEOWNERS is advisory only. `.github/CODEOWNERS` (in this PR) lists the owner for **all of `/.github/`** (any workflow file could reference the environment or the secret),
   `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/qa/d24-m3d-proof/`, `scripts/qa/d24-gh-proof/` (tooling and the evidence public key), this document and `vitest.config.mts`. (This PR changes no ruleset.)
   The only existing CI workflow has a path filter; this PR adds the d24 workflow, CODEOWNERS, `docs/billing/D24-*`, `vitest.config.mts` and `tsconfig.json` to it so those PRs run the tests. Making the check *required* means it must be reachable for every PR, or the owner must accept that PRs outside the filter are not gated.
4. **Verify before merge** (see Merge ordering below), then **approve each run** only after comparing the workflow path and commit SHA on the approval screen with the chat message from engineering.

### Merge ordering (one rule)

**Do not merge this PR until the environment (step 2), its secret, and the ruleset (step 3) exist and the owner has checked them in the browser.** Reason: a workflow that references an environment that does not exist makes GitHub
**create it automatically, unprotected**, on first use, and after merge anyone with write access can dispatch the workflow on `main` (the job's `if:` is true on `main`). The run would fail at the guard step (placeholders), but the unprotected environment would
then exist, and a secret added later in the UI would be released without approval. Order: owner steps 1, 2 and 3 -> owner checks the environment shows the required reviewer, the `main`-only policy and administrator bypass OFF -> then merge ->
then engineering supplies real account ids and the real evidence key in a follow-up PR -> then a dispatch.

## 4. What is and is not a security boundary

Is:
- The restricted TEST key lives only in a GitHub environment secret. It is released only to a job on `main` that a required reviewer approved.
- The workflow file, all of `/.github/`, the harness, the tooling and the node inputs (`package*.json`, `tsconfig.json`) are code-owned; **with a separate agent identity and the code-owner rule on**, changing them needs the owner.
- The key never appears in logs (masked by GitHub, never echoed, output redirected to a file), and evidence leaves the runner only encrypted.
- The harness itself bounds blast radius: TEST-mode key only, 40 requests, allow-listed endpoints, pinned accounts.

Is not:
- **Anything, if the agent acts as the owner (section 3, step 1).** This is the precondition for every other claim. Do not read "engineering cannot do X" in this document as true unless the agent runs under a separate Write-only identity.
- **The approval is bound to a commit SHA and a workflow path read by eye, not to a cryptographic envelope.** The owner compares them; GitHub does not verify the pinned manifest for them. The SHA identifies a whole tree, of which the owner has reviewed only the code-owned parts.
- **Agent-modifiable even with the identity split and the code-owner rule:** dispatching (and therefore auto-creating a missing environment), re-runs, and the private evidence key and everything decrypted with it.
- **Engineering holds the evidence private key.** Anything the run puts in its output reaches engineering. The terminal output is bundled in full; if the harness's redaction ever failed, or a compromised dependency wrote the key to stdout, the key would reach the agent's machine.
  This contradicts the aim "the key never sits on a developer machine" in that failure case; the remaining protection is the harness redaction and the pinned inputs. (Dropping `--terminal` from the encrypt step would remove the raw terminal text from the bundle at the cost of diagnostics; the structured evidence pack would remain.)
- **The runner image and egress.** `ubuntu-24.04` is a moving image label, not a pinned image, and there is no egress restriction: code running in the job can send the key anywhere. The harness's api.stripe.com-only transport does not constrain other code in the job.
  The scrubbed environment, tool-cache node, pinned inputs and stray-process check narrow this; they do not remove it. Residual risk accepted only because the key is a restricted TEST-mode key.
- **A stray process under another name.** The stray-process check only covers `node` and `esbuild`.
- The runner is GitHub-hosted: GitHub, the two pinned actions and the npm registry are in the trust path. A re-run with debug logging (`ACTIONS_STEP_DEBUG`) can be enabled by anyone with write access; secrets stay masked, but verbose logs are in the trust path.
- Anyone with write access can dispatch (then the owner approval gates it). A repository admin can edit environment settings, protection rules and secrets.
- The public repository means workflow logs and artifacts are world-readable. The design assumes that: only ciphertext, counts and hashes are public. (The "what was approved" summary is written after approval; before approval only the run title and workflow path are visible.)

## 5. Dashboard request-log reconciliation (still required)

The harness's own count and cleanup are not an independent record. After every run engineering produces, and the owner (or whoever holds the Stripe
dashboard) confirms, a comparison of: the harness request count and transcript (from the decrypted evidence) against the **Stripe dashboard request log** for the sandbox and
the pinned connected account for the run's time window, plus "no customers or invoices remain on the connected account". Procedure: see `D24-REQUEST-RECONCILIATION.md` and the README of
`scripts/qa/d24-m3d-proof`. Who: engineering prepares the expected list; the dashboard holder compares; discrepancies are a failed run.

## 6. UNVERIFIED GitHub behaviours (none has been tested)

Everything below is from memory of GitHub's documentation, not observed on this repository. None of it is relied on silently:

- What the **approval screen** shows (commit SHA? workflow file? run name?), including what it shows for a *different* workflow that uses the same environment. The workflow puts the SHA in `run-name`; verify what is visible before approving.
- **Collaborator powers in a personal-account repository**: that a Write collaborator cannot edit environments, rulesets, secrets or CODEOWNERS enforcement.
- The **fine-grained token permission names** and whether a token without Administration / Environments / Secrets / Deployments can still open PRs and push branches as needed.
- **Prevent self-review** semantics, and whether re-running a job requires re-approval.
- The environment setting **"Allow administrators to bypass configured protection rules"** (and what the repository admin can still do).
- **`GITHUB_ENV` versus job-level env precedence.** The key steps no longer depend on either (scrubbed `env -i`), but the three plaintext path variables still travel through `GITHUB_ENV`.
- **Artifact and log visibility** for a public repository (assumed world-readable) and artifact retention behaviour with `retention-days: 3`.
- **Free-plan limits**: whether required reviewers and environment secrets with deployment-branch restrictions are available for this repository's plan and visibility.
- That `ubuntu-24.04` has Docker usable by the runner user (the preflight treats "docker not reachable" as MANUAL), that none of the runner's default variables trips the harness's environment hardening (the scrubbed environment makes this less likely), and that the setup-node tool-cache layout is `$RUNNER_TOOL_CACHE/node/24.14.1/x64/{bin/node,lib/node_modules/npm/bin/npm-cli.js}` (a different layout fails closed at the first node step).
- That `npm ci --ignore-scripts` leaves `tsx` runnable on the runner.

Verified (read-only `gh api` against GitHub's tags, by the independent reviewer): `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` is v4.4.0 and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` is v4.6.2.

**Plan to verify the rest later (do not run now):** a harmless, secret-free test workflow, dispatched manually on a branch, in a *separate* test environment
with no secret, that (a) prints the contexts the approval screen would show, (b) lists the token permissions available to a job, (c) uploads a dummy artifact and a dummy log line to
observe visibility and retention, (d) checks `docker ps`, `node -v`, the tool-cache layout and the harness `--print-hash`, `--dry-run` and `--preflight` (the last with no key, so it reports only local failures).
Run only after the owner agrees; it must not reference `d24-stripe-test`, and a unit test fails any other workflow that does.

## 7. Evidence key lifecycle

Generate an RSA-4096 keypair **offline** on an engineering machine, keep the private half off the repository and off GitHub, and replace
`scripts/qa/d24-gh-proof/evidence-public-key.pem` with the public half in a code-owner-reviewed PR. The workflow refuses anything that is
not an RSA public key of at least 4096 bits. Decrypt with:

```bash
node --import tsx scripts/qa/d24-gh-proof/decrypt-cli.ts --in d24-proof-evidence.enc.json --private-key <offline private key> --out <new empty dir> --expect-ciphertext-sha256 <hash from the job summary>
```

If the private key is lost or exposed, the evidence for runs under it is lost or readable respectively; rotate by committing a new public key (reviewed) before the next run.
