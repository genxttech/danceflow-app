# D24 Stripe TEST proof: GitHub environment option

Status: **built, inactive.** Nothing in this change runs, configures GitHub, or touches Stripe. The workflow
(`.github/workflows/d24-stripe-test-proof.yml`) does nothing until the owner creates the `d24-stripe-test` environment and its secret,
and it fails closed while the account ids or the evidence key are placeholders.

Owner-approved intent: engineering operates the Stripe TEST-mode proof; the owner only approves each run, and the restricted TEST key
never sits on a developer machine or in this conversation.

## 1. How a run works

1. Engineering posts, in chat, the commit SHA and the harness manifest SHA-256 it wants run.
2. Engineering (or anyone with write access) dispatches the workflow on `main` (`workflow_dispatch` only).
3. GitHub pauses the job at the `d24-stripe-test` environment. The owner sees the run, its commit SHA (also in the run title) and approves
   **only if the SHA matches the chat message**.
4. After approval the job: refuses unless the repository, event and ref are right and the pinned account ids are real; fetches exactly the dispatched
   commit with plain `git` (no checkout action, no stored credential) and requires that commit to still be the tip of `main`;
   installs with `npm ci --ignore-scripts`; fails unless the harness manifest hash equals the hash pinned in the workflow file;
   runs `--dry-run` and `--preflight`; and only then runs `run.ts --live`.
5. All live output (terminal text and the harness's evidence pack) is written outside the checkout, never to the public log, bundled,
   **encrypted to the engineering evidence public key**, and only the ciphertext is uploaded as an artifact (3-day retention).
   The job summary shows only: outcome, PASS / FAIL / BLOCKED counts, Stripe request count, and two SHA-256 values
   (the ciphertext file and the plaintext bundle). No account id, no object id.
6. Engineering decrypts offline with `scripts/qa/d24-gh-proof/decrypt-cli.ts` (verifies the GCM tag, the plaintext hash and, if given, the hashes the summary showed).

The harness keeps all of its own protections unchanged: default-deny allow-list, 40-call cap (8 reserved for cleanup), identity gate,
pinned `Stripe-Version`, environment hardening, redaction, cleanup, exclusive-create evidence.

## 2. What is pinned in the workflow file (reviewed on `main`)

| Pin | Where | Enforced by |
|---|---|---|
| Harness manifest SHA-256 | `jobs.proof.env.D24_PROOF_PINNED_SHA256` | the job (`--print-hash` must equal it) **and** a unit test (it must equal the manifest at the same commit, so any harness change forces a reviewed workflow update) |
| Platform and connected account ids | `D24_PROOF_EXPECT_PLATFORM_ACCT` / `_CONNECTED_ACCT` | the harness identity gate; the first job step refuses `PLACEHOLDER` |
| Authorization sentence | `D24_PROOF_AUTHORIZATION` | harness constant (test-checked) |
| Evidence public key | `scripts/qa/d24-gh-proof/evidence-public-key.pem` | `encrypt-cli.ts --check-key` runs **before** any Stripe request and refuses a placeholder, a private key, a non-RSA or sub-4096-bit key |
| Actions | two official actions, each pinned to a full commit SHA | unit test (no tag, no short SHA, nothing else) |
| Node | exact version in `actions/setup-node` | unit test |

**Placeholders currently in the PR:** the two account ids (`acct_PLACEHOLDER...`) and the evidence public key. Real values arrive in a
later, code-owner-reviewed PR after the corrected test sandbox exists and the keypair has been generated offline.

## 3. Owner steps (browser; engineering does none of these)

These are about four browser actions. Engineering must not and cannot do them (it will not hold a token with these powers).

1. **Agent token.** Create a fine-grained personal access token for the engineering agent on `genxttech/danceflow-app` with
   *repository contents / pull requests / issues / workflows-read* style permissions needed for normal PRs, and **without**
   Administration, Environments, Secrets, Deployments or Actions-write-to-secrets. (Exact permission names: see section 6, UNVERIFIED.)
   Then **remove the full-power `gho_` token from this machine** (sign the CLI out / revoke that OAuth grant) so the agent only has the fine-grained one.
2. **Create the environment** `d24-stripe-test` (Settings -> Environments): *Required reviewers* = the owner; *Deployment branches and tags* = **Selected branches: `main` only**;
   add the **environment secret** `D24_PROOF_STRIPE_KEY` = the restricted `rk_test_...` key (Invoices=Write, Customers=Write, connected-account Read; everything else None).
   The key is an environment secret, **not** a repository secret.
3. **Code-owner rule.** In a branch ruleset for `main`, enable *Require review from Code Owners*. `.github/CODEOWNERS` (in this PR) already lists the owner for:
   `.github/workflows/d24-*`, `scripts/qa/d24-m3d-proof/`, `scripts/qa/d24-gh-proof/` (tooling and the evidence public key), this document, `vitest.config.mts` and `CODEOWNERS` itself.
   Without this rule CODEOWNERS is advisory only. (This PR changes no ruleset.)
4. **Approve each run** only after comparing the commit SHA on the approval screen with the SHA in the chat message from engineering.

### Merge ordering (important)

A workflow that references an environment that does not exist makes GitHub **create it automatically, unprotected**, on first use.
Therefore: **do not merge this PR, and never dispatch the workflow, until steps 1-3 above are done.** Merging the file alone is harmless
(it only runs on manual dispatch) but dispatching it earlier would create an unprotected environment with no secret (the run would then fail
at the preflight, but the unprotected environment would exist and a later-added secret would be usable without approval). Order: owner steps 2 and 3 -> then merge ->
then engineering supplies real account ids and the real evidence key in a follow-up PR -> then a dispatch.

## 4. What is and is not a security boundary

Is:
- The restricted TEST key lives only in a GitHub environment secret. It is released only to a job on `main` that a required reviewer approved.
- The workflow file and the harness are code-owned; with the code-owner rule on, changing either needs the owner.
- The key never appears in logs (masked by GitHub, never echoed, output redirected to a file), and evidence leaves the runner only encrypted.
- The harness itself bounds blast radius: TEST-mode key only, 40 requests, allow-listed endpoints, pinned accounts.

Is not:
- **The approval is bound to a commit SHA, not to a cryptographic envelope.** The owner compares a SHA by eye; GitHub does not verify the pinned manifest for them.
  The job re-verifies the manifest hash against the pin, and the pin is part of the code-owned file at that SHA, but the human check is what ties the SHA to intent.
- The agent keeps merge power on paths that are not code-owned (for example `package.json` / `package-lock.json`, which feed `npm ci`; `--ignore-scripts` limits but does not remove this).
  Consider adding them to CODEOWNERS if you want that closed.
- The runner is GitHub-hosted: GitHub, the two pinned actions and the npm registry are in the trust path.
- The key is in a GitHub secret and is therefore exposed to a malicious step in an approved run on `main`. That is why changes to the workflow and harness need owner review.
- Anyone with write access can dispatch (then the owner approval gates it). A repository admin can edit environment settings, protection rules and secrets.
- The public repository means workflow logs and artifacts are world-readable. The design assumes that: only ciphertext, counts and hashes are public.

## 5. Dashboard request-log reconciliation (still required)

The harness's own count and cleanup are not an independent record. After every run engineering produces, and the owner (or whoever holds the Stripe
dashboard) confirms, a comparison of: the harness request count and transcript (from the decrypted evidence) against the **Stripe dashboard request log** for the sandbox and
the pinned connected account for the run's time window, plus "no customers or invoices remain on the connected account". Procedure: see `D24-REQUEST-RECONCILIATION.md` and the README of
`scripts/qa/d24-m3d-proof`. Who: engineering prepares the expected list; the dashboard holder compares; discrepancies are a failed run.

## 6. UNVERIFIED GitHub behaviours (none has been tested)

Everything below is from memory of GitHub's documentation, not observed on this repository. None of it is relied on silently:

- What the **approval screen** shows (commit SHA? workflow file? run name?). The workflow puts the SHA in `run-name` for that reason; verify what is visible before approving.
- The **fine-grained token permission names** and whether a token without Administration / Environments / Secrets / Deployments can still open PRs and push branches as needed.
- **Prevent self-review** semantics: whether a required reviewer who is also the person who dispatched can approve (not relevant while the owner is the only reviewer and engineering dispatches).
- **Artifact and log visibility** for a public repository (assumed world-readable) and artifact retention behaviour with `retention-days: 3`.
- **Free-plan limits**: whether required reviewers and environment secrets with deployment-branch restrictions are available for this repository's plan and visibility.
- That `ubuntu-24.04` has Docker usable by the runner user (the preflight treats "docker not reachable" as MANUAL, not as failure), and that none of the runner's default environment variables trips the harness's environment hardening (the preflight fails closed before the key is spent if one does).
- That the two pinned action SHAs below resolve to the intended releases: they were written from memory and have **not** been checked against GitHub. A wrong SHA fails the job at start (fail closed), but verify before relying on them:
  `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (expected v4.4.0) and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (expected v4.6.2).
- That `npm ci --ignore-scripts` leaves `tsx` runnable on the runner.

**Plan to verify them later (do not run now):** a harmless, secret-free test workflow, dispatched manually on a branch, in a *separate* test environment
with no secret, that (a) prints the contexts the approval screen would show, (b) lists the token permissions available to a job, (c) uploads a dummy artifact and a dummy log line to
observe visibility and retention, (d) checks `docker ps`, `node -v` and the harness `--print-hash`, `--dry-run` and `--preflight` (the last with no key, so it reports only local failures),
and (e) resolves the two action SHAs. Run only after the owner agrees; it must not reference `d24-stripe-test`.

## 7. Evidence key lifecycle

Generate an RSA-4096 keypair **offline** on an engineering machine, keep the private half off the repository and off GitHub, and replace
`scripts/qa/d24-gh-proof/evidence-public-key.pem` with the public half in a code-owner-reviewed PR. The workflow refuses anything that is
not an RSA public key of at least 4096 bits. Decrypt with:

```bash
node --import tsx scripts/qa/d24-gh-proof/decrypt-cli.ts --in d24-proof-evidence.enc.json --private-key <offline private key> --out <new empty dir> --expect-ciphertext-sha256 <hash from the job summary>
```

If the private key is lost or exposed, the evidence for runs under it is lost or readable respectively; rotate by committing a new public key (reviewed) before the next run.
