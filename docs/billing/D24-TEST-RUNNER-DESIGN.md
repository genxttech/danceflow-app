# D24 engineering-operated Stripe TEST runner: design

Status: **implemented locally, never executed against Stripe.** Code: `scripts/qa/d24-test-runner/` (outside the hashed proof folder `scripts/qa/d24-m3d-proof/`, which this change does not touch). No `src/` change, no migration, no Stripe API call, no credential used while building it.

## 1. Purpose and non-goals

The owner no longer runs test scripts or handles credentials. The coordinator (engineering) must operate TEST runs of the merged proof harness (main b1a91b58, manifest `b94706f4...`, 30 files) safely. The runner wraps `run.ts --live` with gates the proof cannot enforce on itself: which code runs, under whose written authority, how many times, with which credential, and what is checked afterwards.

Non-goals: it does not widen the proof's allow-list or call cap (the proof enforces both; the runner re-verifies them), it does not create Stripe resources itself, it cannot mint an owner approval, and it does not make the credential safe against other processes of the same Windows user (see section 5).

## 2. Run pipeline (order is deliberate)

`cli.ts run --envelope E [--repo DIR] [--dry]` ->  `runner.ts runEnvelope`. Any failed gate = **BLOCKED**, exit 2, nothing sent, no run consumed.

| # | Gate | Source of truth |
|---|---|---|
| 1 | envelope readable, schema + policy valid, approval terms, canonical hash | `envelope.ts` |
| 2 | envelope window (not expired, not future, key not past its expiry) | clock |
| 3 | ledger: runs consumed < `maxRuns`, no unfinished run, no lock | `ledger.ts` |
| 4 | evidence dir `<evidenceRoot>/<envelopeId>/run-N` outside every git checkout (real paths) | proof `evidenceDirProblem` |
| 5 | clean clone: `HEAD == code.commitSha`, toplevel == repo dir, `status --porcelain --untracked-files=all` empty, `diff-index HEAD` clean, no assume-unchanged / skip-worktree files, `package-lock.json` sha256 (pinned if the envelope pins it), then `npm ci --ignore-scripts` and the tree still clean | `gitverify.ts` |
| 6 | proof manifest: runner recomputation == proof `--print-hash` == envelope (hash and file count) | `manifest.ts` + proof CLI |
| 7 | allow-list: proof `--allow-list` rule-id set == envelope `permittedRuleIds`, and every id is a known rule | proof CLI |
| 8 | proof `--dry-run` (fake client) ends `OUTCOME: OK` | proof CLI |
| 9 | **credential store is touched here, not earlier**: stored key is `rk_test_` shaped, sha256 prefix equals the envelope's approved fingerprint | `credstore.ts` |
| 10 | sanitised child environment built and re-validated with the proof's own `checkEnvironment` | `childenv.ts` |
| 11 | proof `--preflight`: no FAIL; every MANUAL id must have an attestation in the envelope (never guessed) | proof CLI + envelope |
| 12 | last tree re-check (TOCTOU) | git |
| 13 | **ledger `run-start` written (run consumed)**, lock taken, then `--live` | `ledger.ts` |
| 14 | post-run: evidence analysis, cleanup verification, hashing, redaction scan, report, ledger `run-end` | `postrun.ts` |

The ledger entry is written before the first live call, so a run that fails, aborts, crashes or is killed still counts. A `run-start` with no `run-end` blocks all further runs until a human `reconcile`s it after checking the Stripe dashboard (reconcile does not give the run back).

## 3. Authorization envelope

A JSON file; `envelope.ts` holds the schema, validator and canonical hash (`sha256` of the key-sorted JSON without `envelopeSha256`). Any post-creation edit fails the hash. Fields: exact `code.commitSha` (and optional `lockfileSha256`), `proof.manifestSha256` + `fileCount`, sandbox and connected account ids, `permittedRuleIds`, `apiCallCeiling` (1..40 including the 8-call cleanup reserve), credential store/label/`keyKind: rk_test`/fingerprint prefix/`keyExpiresUtc`, `cleanup` (required, must verify empty), `forbidden` (fee-bearing, financial mutation, LIVE: all must be `true`), `stopConditions` (must include any-abort, livemode-true, identity-mismatch, cleanup-unverified, secret-in-output, call-ceiling), `maxRuns` (1..5), `evidenceRoot`, `manualAttestations`, `ownerApproval` (verbatim text, its sha256, reference), `expiresUtc`.

Refused: expired or future envelope; lifetime > 30 days (a standing envelope is never unlimited); `maxRuns` outside 1..5; ceiling > 40 or <= 8; unknown rule ids (any name containing finalize/send/pay/refund/payout/charge/live/... is reported as fee-bearing/financial/LIVE); `mode != TEST`; relaxed `forbidden`; a key kind other than `rk_test`; a key that expires before the envelope; unknown or missing fields; hash mismatch.

**Approval binding.** `ownerApproval.text` must contain the proof's own sentence (`Approved: D24 M3-D Stripe TEST proof as written`) **and** `envelope=<id> code=<sha12> manifest=<hash12> maxRuns=<n> expires=<utc>`, i.e. the owner approves the exact terms (`cli approval-template --spec` prints the line to approve). An approval for one commit, run count or expiry cannot be reused for another. `create-envelope` takes the approval from `--approval-file` plus a human `--approval-ref` and has no code path that generates it.

**Honest limit:** the runner cannot cryptographically distinguish an owner-written approval from text an agent typed into a file. The control is procedural: the coordinator pastes the owner's verbatim message, and anyone can compare `ownerApproval.text` and `.reference` with the chat record. A signature scheme would need an owner-held secret/hardware key, which does not exist today.

## 4. Environment sanitisation

The child receives an **allow-listed** environment (PATH, SystemRoot, TEMP, USERPROFILE, ... nothing else), not a filtered copy of ours, so unknown variables are dropped by default: `NODE_OPTIONS`, `NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, all proxy variables, `NODE_TLS_REJECT_UNAUTHORIZED`, every hosted-DB variable, any variable holding a live key. Only then are `D24_PROOF_STRIPE_KEY`, `..._EXPECT_PLATFORM_ACCT`, `..._EXPECT_CONNECTED_ACCT`, `..._PINNED_SHA256` (from the envelope), `..._AUTHORIZATION` and `D24_PROOF_EVIDENCE_DIR` added; the result must pass the proof's `checkEnvironment` (imported, so the two cannot drift). The key is only in the `--preflight` and `--live` children; git, npm, `--print-hash`, `--allow-list`, `--dry-run` get the base environment. Tests assert this per call.

## 5. Credential storage

Interface `CredentialStore`; implementations in `credstore.ts`, driven through Windows PowerShell 5.1 with `-EncodedCommand` (script text only; the secret goes over **stdin** on write and stdout on read, never argv, never a file in clear, never an env var of the runner).

1. **Windows Credential Manager** (advapi32 `CredReadW/CredWriteW` via P/Invoke, type GENERIC, persistence LOCAL_MACHINE, target `DanceFlow/D24-TEST/<label>`). Preferred.
2. **DPAPI file** (`ProtectedData` scope CurrentUser, label as entropy, base64 file, ACL reduced to the current user with `icacls /inheritance:r`). Fallback.

**What was verified on this machine (2026-11-07, Windows 11, Windows PowerShell 5.1, Node 24).** A write/read/missing-read/delete round trip with a dummy non-Stripe string succeeded for **both** back ends when run from the agent harness's non-interactive Bash tool (no console prompt, stdin piped): Credential Manager about 12 s and DPAPI file about 5 s per full round trip on a loaded machine (each PowerShell call recompiles the P/Invoke type). The dummy entries were deleted. **Not verified:** behaviour under a Task Scheduler task configured "run whether user is logged on or not" or any logon type other than interactive/session-attached. Credential Manager entries with LOCAL_MACHINE persistence are normally readable by the same user in other logon sessions, but CredRead can fail in a non-interactive batch session whose profile/vault is not loaded; DPAPI CurrentUser has the same profile dependency. If a scheduled run is wanted, test with a dummy value in that exact task configuration first. The agent-run path (a logged-in user session) is the one shown to work.

**Threat model (both back ends).** Protects against: the key appearing in git, logs, chat, argv, `ps` listings, shell history, disk images/backups taken without the user's profile, other Windows users. Does **not** protect against: any process running as the same Windows user (Credential Manager has no per-application ACL; DPAPI CurrentUser decrypts for any process of that user, including another agent session), malware in the user session, a user-level admin. Mitigations that actually bound the damage are the key's own properties: `rk_test_`, three permissions (Invoices Write, Customers Write, connected-account Read), a dedicated sandbox with a Stripe-issued test connected account, a short expiry, and expiring it after the run. Keep the key's lifetime to days, not months. `cli provision --check` shows only a fingerprint.

`provision` (`cli.ts`): reads the key from a hidden prompt on a TTY (raw mode, no echo) or from stdin, refuses anything not matching `rk_test_...` (the refusal never echoes the input), refuses positional arguments, writes, reads back, and prints only the fingerprint prefix to put in the envelope. Positional secrets are rejected by the argument parser.

## 6. Post-run

* **Cleanup verification** from the evidence JSON only: `cleanup.verifiedEmpty`, nothing skipped/stopped early, no remaining or unverifiable objects, `outcome OK`, `calls <= ceiling`, nothing refused by the allow-list, manifest in the evidence equals the envelope.
* **Hashing**: SHA-256 of every evidence/transcript file as written by the proof plus the sanitised child output, listed in the report.
* **Redaction scan** over evidence, transcript, child stdout/stderr and the gate log: Stripe key shapes (`sk/rk/pk_test/live`), `whsec_`, bearer/Authorization, emails, and the exact key value held in memory (any form). Findings report kind and count, never the text. A secret finding forces **FAIL** and the report tells the operator to expire the key now. Unmasked account ids are a warning.
* **Decision**: `PASS` (all evidence conditions hold), `FAIL` (abort, failed check, over ceiling, allow-list refusals, remaining objects, secret in output, non-zero exit), `UNVERIFIABLE` (lost create responses, no/unreadable evidence, cleanup not verified), `BLOCKED` (refused before running). The report lists check PASS/FAIL counts, verdict counts, request counts used/ceiling/refused, unverifiable count, cleanup disposition, abort cause with a diagnosis, safety findings, evidence hashes, the key-expiry reminder, and always states that the ledger half of V4/V7 is **NOT TESTED** by this proof revision.

## 7. `--dry` / `dry`

`cli dry` and `run --dry` use `fakeChild.ts` (emulates git, npm and every proof flag, writes fake evidence), a throw-away ledger in a temp dir and a store factory that throws if called. Tests assert the store is never reached in dry mode, and that earlier gate failures never reach the store in real mode.

## 8. Stripe CLI login, restricted keys, owner-only steps (Stripe documentation only; no API call was made)

Sources read: docs.stripe.com `stripe-cli/keys`, `cli/login`, `keys`, `keys/restricted-api-keys`.

**Does `stripe login` yield a key?** The documented flow is browser device pairing: the CLI shows a pairing code, the Dashboard opens, and the user "confirm[s] the code and configure[s] the CLI's access to accounts, sandboxes, and live mode". Credentials are stored in the OS credential store and refreshed automatically; `stripe login list` shows authorized accounts/sandboxes, `stripe reauth` changes permissions, `stripe logout` revokes. For CLI versions newer than 1.50.0 an Administrator or IAM Admin must first enable CLI access (Settings -> Team and security -> MCP and CLI access). `--non-interactive` prints a URL, code and a `--complete` command (it activates automatically when stdin is not a terminal), so a human approval in a browser is still required.

**What the docs do not say (could not verify):** the exact credential type the browser flow stores (a refreshable session, not documented as an `rk_test_` key), its permission scope (only "configure the CLI's access" is stated; whether it can be limited to Invoices+Customers+connected-account read is **not documented**), and its lifetime. `stripe login --interactive` and `STRIPE_API_KEY` / `--api-key` accept a manually supplied key, so the CLI is only a transport for a key that already exists. **Do not assume the CLI grants scoped permissions.** The proof does not use the CLI and requires an `rk_test_` key; a CLI session is not usable for it, and a session with broader scope than the restricted key would be a larger risk, not a smaller one.

**Can a restricted key be created without the Dashboard?** Per the docs, restricted keys are created in the Dashboard ("Create restricted key", set each resource to None/Read/Write, "complete the two-factor verification we send you", copy once). I found no documented API or CLI command to create a restricted key for a sandbox (the Stripe Apps RAK flow generates a key when a user installs an app, which does not fit). **Could not verify** that no such endpoint exists; treat creation as Dashboard-only with 2FA. The docs do not mention an expiry chosen at creation: expiry is manual ("Expire key") or via rotation with an optional scheduled expiry (grace up to 7 days). Plan the key's end date at the envelope level and expire it by hand after the last run. In a sandbox, all keys including restricted ones remain revealable later. Keys can be tagged as an autonomous-agent key, which attaches approval rules; whether that interacts with this proof's calls is **not verified** and would be a decision for the owner (do not enable it unless wanted).

**Owner-only (cannot be delegated):**
1. Create the new sandbox `DanceFlow D24-M3 TEST` and its single Express (or controller-equivalent) test connected account; tell engineering the two `acct_` ids.
2. In that sandbox, create the restricted key (Invoices Write, Customers Write, connected-account Read, everything else None), pass the 2FA prompt, and put it into `provision` via the hidden prompt (or have the coordinator do so at the owner's terminal session; the key must not be typed into chat).
3. Record the key's intended expiry date and, after the last run, expire it in the Dashboard.
4. Write (verbatim) the approval line produced by `approval-template`, and confirm the MANUAL facts (sandbox identity, key permissions, no webhook endpoints, account default API version).
5. Optionally enable CLI access only if a CLI is wanted (not needed).

## 9. Limitations

* Same-user processes can read the credential (section 5). The approval is procedural, not cryptographic (section 3). The ledger lives in the user profile: a process that can write there can rewrite it from scratch (the hash chain detects partial edits, not wholesale replacement or tail truncation).
* `npm ci` needs the npm registry (not Stripe). Dependency integrity is lockfile integrity hashes; the manifest covers only the proof folder (not tsx or `node_modules`) as the proof README states.
* The runner trusts the proof's evidence format; a changed proof means a new manifest and a new envelope.
* Nothing here was run against Stripe; the fake child proves control flow only.
