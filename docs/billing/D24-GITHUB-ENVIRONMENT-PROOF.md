# D24 Stripe TEST proof: GitHub environment runner

Status: **draft, nothing configured, nothing executed.** This document, `.github/workflows/d24-stripe-test-proof.yml`, `.github/CODEOWNERS` and `scripts/qa/d24-github-proof/` were written without any Stripe call, credential use or GitHub settings change.

## STOP: merge-ordering hazard (read first)

**A workflow that names an environment which does not exist makes GitHub create that environment, UNPROTECTED, the first time the workflow references it.** An unprotected `d24-stripe-test` would have no reviewer and no branch policy.

Therefore the workflow file **must not be merged to `main`, and must never be dispatched, until all of these exist:**

1. environment `d24-stripe-test` with required reviewer = the owner, deployment branches = `main` only, and the ENVIRONMENT secret `D24_PROOF_STRIPE_KEY`;
2. code-owner review enforced on `main` (owner step 4);
3. the real evidence public key committed (engineering), and the two account-id pins filled in (owner values, reviewed change).

The job also fails closed while the account ids or the evidence key are still placeholders, but that is a second line of defence, not a substitute for the ordering above.

## What the workflow does

`workflow_dispatch` only. One job bound to `environment: d24-stripe-test`, `permissions: contents: read`, one concurrent run, 25 minute timeout, GitHub-hosted `ubuntu-24.04`.

1. Writes the dispatched commit SHA and the pinned harness manifest hash into the job summary (compare them with the chat message when you approve).
2. Refuses unless: event is `workflow_dispatch`, repository is `genxttech/danceflow-app`, ref is `refs/heads/main`, both account-id pins are real `acct_` ids (not `PLACEHOLDER`) and differ.
3. Checks out `github.sha` (no persisted credentials), fixes Node at 24.14.1, refuses unless `HEAD == github.sha`, the tree is clean and the evidence public key is not the placeholder.
4. `npm ci --ignore-scripts`, validates the evidence public key (RSA, at least 4096 bits).
5. `run.ts --print-hash` must equal the hash pinned in the workflow (`1454d3984babf1f47fd7d8fc23bb27f2739922ad3a5cbd135df7f4e32c2b316c`, 31 files). Then `--dry-run`, `--preflight`, `--live`. The harness's own hardening (default-deny allow-list, 40-call cap, identity gate, environment refusal) is untouched; no file in `scripts/qa/d24-m3d-proof` was changed.
6. Evidence: the harness writes its pack to `$RUNNER_TEMP/d24-evidence` (outside the checkout). All harness output goes to files, never the log. The pack, the live stdout, the preflight and dry-run output are bundled and **encrypted** (RSA-OAEP-4096 wrapping an AES-256-GCM key, node built-in crypto) to `scripts/qa/d24-github-proof/evidence-public-key.pem`; only the ciphertext is uploaded (retention 3 days). The job summary shows only: outcome, request count, refused-before-network count, verdict and check counts, and SHA-256 of the ciphertext and of each plaintext file. No account or object ids.

The Stripe key exists only in the `Preflight` and `Live` steps' environment and is masked.

Decrypting (engineering, offline, private key never in GitHub):

```bash
npx tsx scripts/qa/d24-github-proof/cli.ts decrypt --in d24-evidence.enc.json --private-key <private.pem> --out <new dir>
```

It verifies the GCM tag and every file hash and refuses to overwrite files.

## Owner steps (about four browser actions)

1. **Agent PAT.** Create a fine-grained personal access token for the agent limited to this repository with the permissions the agent needs for branches and PRs (contents, pull requests, metadata, checks/actions read) and **without** Administration, Environments, Secrets, Deployments or Actions write. (Exact names UNVERIFIED, see below.)
2. **Remove the full-power token** (`gho_…`) from this machine (sign out of `gh` / delete the stored credential) and give the agent only the PAT from step 1. Until this is done the agent could in principle edit environments and secrets, and everything below is advisory.
3. **Create the environment** `d24-stripe-test`: required reviewer = you; deployment branches and tags = selected branches, `main` only; add the environment secret `D24_PROOF_STRIPE_KEY` (a restricted `rk_test_…` key made for this proof only: Invoices write, Customers write, connected-account read, everything else none). Do not add repository-level or organisation-level copies of that secret.
4. **Enable the code-owner rule:** a ruleset (or branch protection) on `main` requiring pull-request review from code owners. `.github/CODEOWNERS` already assigns `@genxttech` to the workflow, the harness, the decrypt tool, the evidence public key and CODEOWNERS itself. Only after steps 3 and 4: merge this PR (code-owner review by you), then engineering supplies the evidence public key and you supply the two account ids in reviewed changes.
5. **Each run:** dispatch the workflow from `main`; when the approval request arrives compare the commit SHA and manifest hash in the summary with the message engineering sent you; approve only if they match. Afterwards expire the Stripe key.

## What is and is not a boundary

* The Stripe key sits in a GitHub secret. Anyone who can change the workflow on `main`, edit the environment, or has repository admin can in principle obtain it. The code-owner rule and the environment's main-only policy are what stand in the way; both are settings the owner controls.
* Approval is bound to a commit SHA the reviewer compares by eye, not to a cryptographic envelope. The workflow re-checks `HEAD == github.sha` and the harness hash pin, but a reviewer who does not compare the SHA approves whatever is at that SHA.
* The agent keeps merge power on paths that are not code-owned. It cannot merge changes to the protected paths without the owner, and cannot touch environment settings once step 2 is done.
* The runner is GitHub-hosted: the key is in the memory of a machine GitHub operates, and the repository is public so logs and artifacts are world-readable. That is why nothing is logged and the only artifact is encrypted.
* The harness's own protections (allow-list, 40 calls, identity gate, `rk_test_` only, refuse live keys and proxy variables) still apply and are not weakened.

## Independent reconciliation still required

The harness's own evidence is its own account of what it sent. An **independent Stripe dashboard request-log reconciliation** of the sandbox (request count at or below 40, only allow-listed endpoints, nothing on the platform account beyond the two identity reads, no objects left in the connected account) is still required after the run. **Owner or engineering with dashboard access** performs it; the agent that built the harness must not be the only reader of its own evidence.

## GitHub behaviours that are UNVERIFIED

Everything in this design relies on GitHub features that were not tested here:

* what the environment approval screen shows the reviewer (does it show the SHA, the summary, the branch?), and whether a job-summary written *before* approval is visible at that moment (the first step runs after approval, so the summary may only appear afterwards: the SHA to compare may have to come from the run page);
* the exact fine-grained PAT permission names, and whether any combination can still modify environments or secrets;
* "prevent self-review" semantics for a sole reviewer who is also the dispatcher;
* whether artifacts and job summaries of a public repository are readable by anyone without login (assumed yes);
* limits of the free plan for required reviewers and environment protection on this repository's visibility/plan;
* that `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` commit SHAs recorded in the workflow (v4.2.2, v4.4.0, v4.6.2) are correct: they were written from memory and **must be verified against the upstream tags by the reviewer**; also that setup-node's `package-manager-cache` input exists in the pinned version;
* that the GitHub-hosted runner sets none of the environment variables the harness refuses (`NODE_OPTIONS`, proxy variables and so on); if it does, the run refuses (fails closed) rather than proceeding.

**Plan to verify later:** a harmless, secret-free test workflow (also `workflow_dispatch`, a dummy environment, a dummy non-secret value, no Stripe) run only after the owner has created settings, to observe the approval screen, summary visibility timing, self-review behaviour and artifact visibility. Not written to run now and not run.

## Out of scope / unresolved

* No Windows-account boundary (PRs 417/419/423) is replaced or removed by this PR.
* Real evidence public key, account ids, environment, secret and rulesets: not part of this change.
