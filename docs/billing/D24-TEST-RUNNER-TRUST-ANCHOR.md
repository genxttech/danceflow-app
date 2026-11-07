# D24 TEST runner: an execution-path trust anchor the same-user agent cannot rewrite

Status: **design only.** No code, no enrollment, no Stripe call, no SQL, no deploy. Written against PR #417 (`claude/d24-test-runner`, head `5d28e341`) and PR #419 (`claude/d24-owner-auth`, head `5199f3f7`, stacked). Related: `D24-TEST-RUNNER-DESIGN.md`, `D24-TEST-RUNNER-OWNER-AUTH.md`.

Evidence legend: **[code]** read from those branches; **[design]** proposed here; **[unverified]** depends on Windows or GitHub behaviour not checked in this work and to be observed in the test plan (section 8), never assumed.

## 1. The problem, stated narrowly

The runner (#417/#419) runs as the owner's Windows user, the same user the engineering agent runs as. Everything that decides whether a live run is allowed is therefore writable by the agent: the runner code, `REQUIRE_HARDWARE_FOR_LIVE`, `owner-hw-anchor.json`, the enrolled-credential fingerprint, the verification logic, the envelope, the ledger and counter state, and the credential store (Credential Manager and DPAPI CurrentUser are readable by every process of that user) [code: OWNER-AUTH sections 1, 3, 5].

So today the hardware approval is **defense in depth, not an independent boundary**. A hard-coded constant and a repo-stored anchor are checked by code the agent can edit, using files the agent can replace; `commit-on-main` runs on the agent's machine; GitHub branch protection protects `main`, not the process that executes. Branch protection becomes relevant only if the **execution path itself verifies that the code and policy it is running equal an owner-approved, protected release**, and that verification lives somewhere the agent cannot write.

Goal: the narrowest practical mechanism (small, auditable, no authorization platform) such that, for a **non-elevated** agent running as the owner's user:

1. it cannot change the code, policy ceilings, trust anchor or enrolled fingerprint that gate a live run;
2. it cannot make a Stripe call with the restricted key outside a run the owner tapped for;
3. whatever it can still do is bounded by ceilings it cannot raise.

Out of scope and stated plainly: an agent that obtains **administrator** rights (it can do anything), a compromised owner device, and a Windows or Stripe vulnerability. The mechanism assumes the owner's day-to-day Windows user is not silently elevatable (UAC at its default, secure-desktop consent) and that the owner refuses unexpected UAC prompts (section 7, residual R2).

## 2. Options evaluated

| | A. Admin-only install | B. GitHub release provenance / signed tag | C. Hardware approval identity (WebAuthn UV) | D. Separate Windows account (or VM) |
|---|---|---|---|---|
| What it is | Release tree copied to an ACL-protected path (`C:\ProgramData\d24-runner`, write = Administrators and SYSTEM only). Launcher verifies the tree hash against an owner-approved release record; the anchor, policy ceilings and release record live in that admin-owned directory. | Owner-approved release = signed tag or PR merge SHA; runner fetches and checks signature/merge state. | Per-run approval = one assertion by a device-bound credential over the envelope hash (already built in #419). | Runner and the Stripe key run as another principal (local low-privilege account, or a VM) the agent's user cannot read or signal. |
| Threats prevented | Edit of runner code, constant, anchor, fingerprint, verifier, ceilings **after install**; stale or forked tree; anchor swap | Unreviewed code reaching a release; tampered tag | Forged per-run approval; reuse across envelopes; approval of changed terms | Reading the key; running the proof outside the runner; tampering with a run in progress |
| Assumptions remaining | Agent not admin; owner reviews what the installer shows; ACL applied correctly [unverified until tested] | GitHub settings enforce review; the *verifying* code is itself unmodified (circular unless run from A or D) | Verifier and anchor are somewhere the agent cannot edit (needs A); owner reads the fingerprint | Account exists, ACLs hold; the tap still needs the owner's interactive session |
| Independently enforceable? | **Yes** for code/policy integrity, by NTFS ACLs the OS enforces against a non-admin | **No by itself**: enforcement runs in agent-writable code; **yes as an install-time check** inside A | **Only with A or D**: signature checking is policy if the verifier is agent-writable | **Yes** for key custody and process isolation, if the account/ACLs are right |
| Owner disruption | One UAC click per install/update | none at run time; a signed tag needs the owner to sign (extra step) | one tap per run (already planned) | a one-time account setup (folded into the install), no per-run cost; a VM is heavy and rejected |

**Recommendation: A + the credential-custody half of D + C, with B reduced to an installer check.** Concretely, one admin-owned install root that contains the release tree, the policy and the anchor; the Stripe key stored under, and the runner executed as, a dedicated unprivileged local account; the per-run authorization is the hardware tap already implemented in #419, now verified *inside* the protected path. B is not a separate mechanism: the elevated installer refuses a tree whose commit is not the merge commit of an owner-approved PR on `main` (and, as a later hardening, a GitHub-"Verified" signed tag), and **shows the owner the commit, PR number and tree hash before the click**. That puts GitHub's protection where it can matter: at the one moment code crosses into the protected directory.

Why not C alone: with an agent-writable verifier it is the current state. Why not D (VM): the narrowest sufficient piece of D is the account split; a VM adds cost with no extra property for this threat.

## 3. The mechanism (small and auditable)

### 3.1 Layout [design]

```
C:\ProgramData\d24-runner\            ACL: Administrators + SYSTEM full; d24run read+execute; owner user read+execute only
  release\                            the installed runner tree (copy of scripts/qa/d24-test-runner at the approved commit, plus the d24-m3d-proof folder it pins)
  release.json                        { commit, prNumber, treeSha256 (runnerManifest), proofManifestSha256, installedAtUtc, installerVersion }
  policy.json                         admin-owned ceilings (section 3.3)
  anchor.json                         hardware credential public key + rpId + origins + UV=true + fingerprint (the #419 anchor, relocated)
  state\                              d24run-only write: counter state, ledger, consumed-run records
  cred\                               d24run-only read/write: the sealed Stripe restricted key (DPAPI under d24run, or ACL-only file)
  inbox\                              owner-user create-only (and read own): <runId>\envelope.json, <runId>\assertion.hw.json
  evidence\                           d24run write; everyone read-only (no secrets)
```

The path is a **constant** in the code that runs from it (not an environment variable, argument or config). Nothing outside it is trusted at run time.

### 3.2 The execution path [design]

1. The agent (or owner) prepares an envelope and drops it in `inbox\<runId>\`. The launcher (an owner-user tool, shipped in `release\`) prints the **envelope fingerprint** and terms and raises the tap (section 4). The assertion is written beside the envelope.
2. The owner (or the agent, after the tap exists) triggers the run by starting a **scheduled task** that runs as `d24run`. The task's definition is created at install; the task security descriptor lets the owner's user *start* it but not edit it. The task has a fixed action: `node release\...\exec-inbox.js` from the install root, with the run id as its only argument.
3. The task first **copies** `inbox\<runId>\*` into a private `d24run`-only directory (kills time-of-check/time-of-use swapping), then checks, in order, all as `d24run`:
   * `install-root`: the running code's real path is inside the install root, and the root's ACL has no write access for anything but Administrators/SYSTEM/`d24run` (parsed from `icacls`, fail closed);
   * `tree-hash`: `runnerManifest(release\)` equals `release.json.treeSha256`, and the proof folder equals `proofManifestSha256`;
   * `policy`: `policy.json` parses, its own hash is recorded in `release.json`;
   * `anchor`: `anchor.json` fingerprint is recomputed and equals the one in the policy;
   * the existing #417/#419 pipeline on the copied envelope, **with every limit clamped to policy** (section 3.3), the hardware assertion verified against `anchor.json`, the counter and ledger kept in `state\` that only `d24run` writes, the key read from `cred\` by `d24run`, the proof executed as `d24run`.
4. Evidence is written to `evidence\`.

What changes versus today is *who owns the files and who executes*, not the checks themselves; the checks in #417/#419 are reused.

### 3.3 Admin-owned policy ceilings [design]

`policy.json` is written only by the elevated installer and can only be **narrowed** by an envelope, never widened:

* `stripeMode: "test"` only; key shape `rk_test_` only (`checkKeyShape`).
* `platformAccount` and `connectedAccount` pins (the owner's TEST ids), so an envelope cannot retarget.
* `maxCallsPerRun` (equal to the proof's `HARD_CALL_CAP`, currently 40), `maxRunsPerEnvelope`, `maxEnvelopeValidityDays`, `maxRunsPerDay`.
* `allowListSha256`: the proof's manifest (the request allow-list is the proof's code); an envelope cannot name different rules.
* `amountCeilingMinor`: highest amount any scenario may create (draft invoices are never finalized, but the ceiling is stated and checked).
* `anchorFingerprint`.

These bound what a *tricked tap* can do (section 4.3).

## 4. What the owner approves, and the honest residual

### 4.1 The tap shows nothing

A WebAuthn prompt shows the relying-party id and asks for presence/PIN. It does **not** show the envelope. The challenge is the envelope hash, but the owner cannot read a hash in that dialog.

### 4.2 Envelope fingerprint [design]

Define `envelopeFingerprint = first 12 hex of the envelope's canonical SHA-256`, displayed as `7F3A-91C2-0B5D` (three groups of four), uppercase. It is computed by the trusted launcher from the file it is about to have signed (not taken from the file's contents) and shown together with the human-readable terms (mode, scenarios, call ceiling, expiry, key fingerprint, account pins, runner tree hash prefix). The coordinator posts the **same fingerprint and terms in the chat proposal** before asking for the tap. The owner's check is: *the three groups on the launcher screen equal the three groups in the chat message.* To make the check active rather than passive, the launcher requires the owner to **type the first group** (`7F3A`) before it raises the tap.

### 4.3 The residual that remains (R1: rogue prompt / race)

A hostile same-user process can start its **own** launcher-lookalike, show the owner a benign fingerprint and raise a tap for a different envelope, or race a tap the owner expects. The WebAuthn prompt cannot tell the owner which. This is not closed by this design. It is **bounded**:

* the verifier (in the protected path) accepts only an envelope whose hash the assertion covers, so the attacker needs a tap *for that exact envelope*;
* that envelope must satisfy the admin-owned `policy.json`: TEST mode only, the pinned accounts, the proof's own allow-list (so no payouts, transfers, finalization or deletes outside the run's own drafts), at most 40 calls, a validity window, a run cap, a daily cap;
* each approval is single-use per the counter/ledger in `state\`;
* the worst case is therefore **a bounded, TEST-only, proof-shaped run the owner did not intend**, with a ledger entry and evidence that the owner can inspect.

Mitigations that are cheap: the launcher refuses to raise a tap while more than one envelope is pending in `inbox\`; the chat proposal states how many runs are expected; the owner should treat a tap they did not just initiate as a security event. These are policy, not enforcement.

## 5. Anchor rotation and the trusted approval identity

The approval identity (credential public key, rpId, origins, UV requirement, fingerprint) lives in `anchor.json` **inside the admin-owned root**, and the fingerprint is also in `policy.json` and `release.json`. The agent cannot write either.

**Replacing it requires the elevated installer** (a new UAC consent) **and a hardware tap at enrollment** performed by the owner in that elevated session. The installer shows the old and new fingerprints, requires the owner to type the new fingerprint's first group, writes the anchor, and prompts the owner to record the fingerprint out of band (write it down or photograph it). An agent cannot do this silently: without admin it cannot write the root; with a rogue UAC prompt it needs the owner to consent on the secure desktop and to tap a physical key during enrollment, which a software authenticator driven by the agent cannot provide into the owner's elevated session [unverified: behaviour of virtual authenticators against the elevated enrollment page].

The #419 `owner-anchor-pin` rule stays: the envelope carries `hardwareAnchorFingerprintSha256`, inside the hash the tap covers, and must equal the installed anchor's fingerprint.

## 6. Credential handling and its same-user limit

* **Where the Stripe restricted key lives:** `cred\` in the install root, readable only by `d24run` (DPAPI under `d24run`'s profile, or an ACL-only file; whichever the test plan shows works non-interactively [unverified]). The owner's user and therefore the agent cannot read it. The key is **not** in Credential Manager or DPAPI of the owner's user any more.
* **Entering the key:** at install, in the elevated session, through the existing hidden-input prompt (`secretprompt.ts` [code]); it goes to `cred\` through stdin of a helper running as `d24run`, never argv, env, log or clear file.
* **At run time:** `d24run` reads it and passes it to the proof child over stdin only, as #417 does [code]. The agent's user cannot open another account's process memory without administrator rights.
* **Same-user limit that remains:** (a) anything that runs as `d24run` can use the key, so `d24run` has no interactive logon, no shell, a random password the installer does not keep (held by Task Scheduler) [unverified mechanics], and the only code it executes is the verified tree; (b) the key is a restricted `rk_test_` key with three permissions, expired by the owner after the work, so a leak is bounded by Stripe-side limits too; (c) a hostile process that gets administrator rights bypasses everything (out of scope); (d) the *proof output* the owner's user can read (evidence) never contains the key [code].
* **Rotation:** elevated install again, enter the new key, expire the old key in the Stripe dashboard.

## 7. Threat table

| Threat (non-elevated agent as the owner's user) | Prevented? | By what | Independently enforceable? |
|---|---|---|---|
| Edit runner code or `REQUIRE_HARDWARE_FOR_LIVE` and run it | Yes | Execution only from the admin-owned root; tree hash vs `release.json` checked by code in that root | Yes: NTFS ACL, enforced by the OS |
| Replace `anchor.json` / enrolled fingerprint with a software authenticator's key | Yes | Anchor in the admin root; rotation needs elevation plus a physical tap at enrollment | Yes (ACL); the enrollment tap is a physical act |
| Change policy ceilings (calls, amounts, accounts, TEST-only) | Yes | `policy.json` admin-owned; envelope may only narrow | Yes |
| Rewrite the verifier or counter/ledger to accept replay | Yes for verifier (tree hash); counter/ledger are `d24run`-only | Admin root + `state\` ACL | Yes |
| Read the Stripe key and call Stripe directly | Yes | Key under `d24run`, not the owner's profile | Yes (account/ACL isolation), subject to ACLs being right [unverified] |
| Forge a hardware approval | Yes | Device-bound credential, UV, challenge = envelope hash (#419) | Yes (cryptographic) given the anchor is unforgeable |
| Swap the envelope after the tap | Yes | Copy-then-verify in a private directory; assertion covers the hash | Yes |
| Install a malicious tree by "updating" | Yes without owner action | Install is elevated and shows commit/PR/tree hash | Yes for the write; the *content review* is the owner's/GitHub's |
| Trick the owner into tapping a different envelope (R1) | **No** | Bounded only: admin ceilings, single-use, TEST-only, evidence | Ceilings yes; the trick itself not preventable |
| Rogue UAC prompt to obtain admin (R2) | **No** | Owner discipline; secure-desktop consent shows publisher/path only | No |
| Agent with administrator rights | **No** | Out of scope | No |
| Owner device or authenticator compromised | **No** | Out of scope | No |
| Stripe-side effect of a bounded rogue run | Bounded | `rk_test_` three-permission key, the proof's allow-list and call cap | Partly (Stripe key scope) |

## 8. Real-authenticator and installation test plan (Windows)

Legend: **E** = engineering can do alone (offline/software authenticator, throwaway local account, no real Stripe); **O** = genuinely owner-only (physical key, elevation, real key, real account).

| # | Test | Who | Notes |
|---|---|---|---|
| T1 | Installer dry-run into a temporary directory with an injected ACL provider: tree copy, hash, `release.json`, refusal paths | E | Pure code, no elevation |
| T2 | ACL gate: a root with `Users:(W)` or `Authenticated Users:(M)` is refused; correct ACL accepted (parse real `icacls` output captured from a test directory) | E | Uses a temp dir ACL set by the engineer's own user |
| T3 | Tree-hash tamper: change one byte in the installed copy (in a test copy) -> `tree-hash` gate fails; change `release.json` -> fails | E | |
| T4 | Software-authenticator vectors: valid assertion, wrong challenge, wrong origin/rpId, UP/UV clear, bad DER, wrong key, replayed counter, counter regression, second different assertion for the same envelope | E | Already covered by `webauthn.test.ts`/`softauth.ts` [code]; re-run against the relocated anchor |
| T5 | Envelope swap after assertion; swap between copy and verify (race harness) | E | |
| T6 | Fingerprint: launcher shows the value the verifier recomputes; typed-first-group confirmation; a mismatch refuses the tap | E | |
| T7 | Agent cannot replace the anchor/policy/tree: as the engineer's non-elevated user, try to write `anchor.json`, `policy.json`, `release\` in an installed root | **O to install, then E to attack** | Needs the elevated install once (owner click); the attack attempts are then engineering's |
| T8 | `d24run` isolation: the non-elevated user cannot read `cred\`, cannot read the task's process memory, cannot edit the task | **O to install, then E** | Same install |
| T9 | Real enrollment: create the credential on the owner's key; flags UP+UV, BE/BS clear, ES256 key extracted; fingerprint recorded out of band | **O** | Owner present; physical key and PIN |
| T10 | UV with PIN; UP without UV (must fail); cancel the dialog; timeout; wrong key presented; second key | **O** | Physical key |
| T11 | Invalid assertion from the real device after tampering the file; replay of a used assertion; offline re-verification of a real assertion through `verifyAssertion` | E after O provides one assertion | Owner taps once, engineering analyses the file |
| T12 | No fallback: delete/rename `anchor.json` or break its fingerprint -> live run blocked, never downgraded | E (in a test root) | |
| T13 | Task start by the non-elevated user works; editing/deleting the task fails | **O to install**, then E | |
| T14 | Non-interactive `d24run` can unseal `cred\` (DPAPI vs ACL-file decision) | **O to install** | If DPAPI fails non-interactively, fall back to the ACL file |
| T15 | One real TEST run end to end with a throwaway key | **O** | Separate go-ahead; not part of this design |

## 9. Owner-only actions (minimised)

1. **One elevated install click** (UAC consent) that: creates the root and ACLs, creates `d24run` and the scheduled task, copies the verified tree, writes `policy.json` and `release.json`, takes the restricted key through the hidden prompt, and runs the hardware enrollment. The installer shows commit, PR number, tree hash and the new anchor fingerprint first and asks the owner to confirm by typing the first group of the fingerprint.
2. **One hardware enrollment tap** (inside that same install).
3. **One tap per run**, after comparing the three fingerprint groups with the chat proposal.

Unavoidable extras, named honestly: creating the Stripe restricted key in the dashboard and expiring it afterwards (existing owner steps), and recording the anchor fingerprint out of band. Updates to the runner or policy repeat action 1.

## 10. Minimal implementation delta against #417/#419 (not implemented here)

Paths are under `scripts/qa/d24-test-runner/` unless stated. Files are hash-pinned by `runnerpin.ts`, so any change after the owner's approval changes the tree hash by design.

**New**
* `trustroot.ts`: constant install root; `checkInstallRoot()` (running path inside the root; parse `icacls` and refuse write access for anything but Administrators/SYSTEM/`d24run`); `loadRelease()` / `verifyInstalledTree()` using `runnerManifest` and the proof manifest; `loadPolicy()` (strict parse, hash recorded in `release.json`).
* `policy.ts`: policy schema, `clampEnvelopeToPolicy(env, policy)` (reject any value above a ceiling), `policyFingerprint`.
* `fingerprint.ts` (or in `canon.ts`): `envelopeFingerprint(hash)` grouped format used by launcher, verifier output and the chat proposal.
* `execinbox.ts`: the scheduled-task entry point: copy inbox to a private dir, run the gates in order, call `runEnvelope`.
* `launcher.ts` (owner-user tool): list inbox, show fingerprint and terms, require typed first group, raise the tap (page or `webauthn.dll`, per OWNER-AUTH section 7), write `assertion.hw.json`; refuses when more than one envelope is pending.
* `install/Install-D24Runner.ps1` (elevated): verify clean clone at the merge commit of an owner-approved PR on `main`, show commit/PR/tree hash, create root + ACLs + `d24run` + task, copy tree, write `release.json`/`policy.json`, enroll the anchor, take the key. Outside the pinned tree on purpose (it is the thing that creates the root); its own hash is printed for the owner.
* `__tests__/trustroot.test.ts`, `policy.test.ts`, `execinbox.test.ts`, `installer.test.ts` (injected ACL provider and file system).

**Changed**
* `runner.ts`: remove reliance on `REQUIRE_HARDWARE_FOR_LIVE` alone; add gates `install-root`, `tree-hash`, `policy` before the existing ones; take limits from `clampEnvelopeToPolicy`; load the anchor from the install root; keep `commit-on-main` as audit evidence only (the release record replaces it for enforcement).
* `envelope.ts`: remove envelope-chosen ceilings above policy; keep `hardwareAnchorFingerprintSha256` and require it equals the installed anchor's fingerprint and `policy.anchorFingerprint`.
* `cli.ts`: `run` becomes `request` (drop envelope into the inbox, print the fingerprint) in installed mode; live execution only via `execinbox`.
* `ownercli.ts`, `ownersig.ts`, `ownerverify.ts`: the passphrase-sealed kind is not accepted when running from the install root.
* `credstore.ts`: add the `d24run`-only back end; the user-profile back ends (Credential Manager, DPAPI CurrentUser) are refused for live runs.
* `webauthn.ts`: counter state and ledger paths move to `state\` (write by `d24run`).
* `gitverify.ts`: used by the installer; the runtime clean-clone requirement is replaced by the tree-hash gate for installed runs.
* `runnerpin.ts`: export a `verifyInstalledTree(root, release)` helper; unchanged hash algorithm.
* `vitest.config.mts` include list (the new tests); `docs/billing/D24-TEST-RUNNER-OWNER-AUTH.md` section 3 updated to reference this document.

**Not changed**: the proof folder (`d24-m3d-proof`, hashed), the WebAuthn verifier logic, the envelope canonicalisation.

## 11. Open decisions for the owner

1. Is the owner's everyday Windows user a local administrator (UAC split token) or a standard user? A standard user is stronger; with an administrator account the boundary depends on the agent not being able to elevate [unverified].
2. DPAPI-under-`d24run` versus an ACL-only file for the key (decided by T14).
3. Whether to require a GitHub-"Verified" signed tag in the installer now or later.
4. Who may run the installer's clean-clone step (the owner at a keyboard; the agent never elevates).
