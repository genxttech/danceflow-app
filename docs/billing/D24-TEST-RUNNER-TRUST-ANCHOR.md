# D24 TEST runner: an execution-path trust anchor the same-user agent cannot rewrite

Status: **design (sections 1-11, with the overclaims the PR 423 review found marked in place) plus an as-built record (section 12) and an honest statement of the administrator-account problem (section 13).** The build is local code only, inactive, offline-tested: no elevated install, no enrollment, no Stripe call, no SQL, no deploy. Written against PR #417 (`claude/d24-test-runner`, head `5d28e341`) and PR #419 (`claude/d24-owner-auth`, head `5199f3f7`, stacked). Related: `D24-TEST-RUNNER-DESIGN.md`, `D24-TEST-RUNNER-OWNER-AUTH.md`.

> **Read section 13 first.** The owner's Windows account is a local administrator with a UAC split token; UAC is not a security boundary, so none of the "prevented" claims below hold against an agent that can elevate. Rows and sentences marked **[corrected]** were overstated in the first version of this document.

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

**Recommendation: A + the credential-custody half of D + C, with B reduced to an installer check.** Concretely, one admin-owned install root that contains the release tree, the policy and the anchor; the Stripe key stored under, and the runner executed as, a dedicated unprivileged local account; the per-run authorization is the hardware tap already implemented in #419, now verified *inside* the protected path. B is not a separate mechanism: the elevated installer refuses a tree whose commit is not proven to be on `main` with the pinned blobs **and** the merge commit of a merged PR (merged by the owner's login) according to the GitHub API **[corrected: the first build checked only that the commit was reachable from `main`; section 12.2 describes the current check]** (and, as a later hardening, a GitHub-"Verified" signed tag), and **shows the owner the commit, PR number and tree hash before the click**. That puts GitHub's protection where it can matter: at the one moment code crosses into the protected directory.

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
  inbox\                              owner-user: add-file/add-subdirectory + read at the directory; files the owner creates are OWNED by the owner and stay rewritable by it [corrected: not "create-only"]; untrusted by design: <runId>\envelope.json, <runId>\assertion.hw.json
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

**Replacing it requires the elevated installer** (a new UAC consent) **and, in the design, a hardware tap at enrollment [corrected: that tap is not built; today the owner types the new fingerprint's first group]** performed by the owner in that elevated session. The installer shows the old and new fingerprints, requires the owner to type the new fingerprint's first group, writes the anchor, and prompts the owner to record the fingerprint out of band (write it down or photograph it). An agent cannot do this silently: without admin it cannot write the root; with a rogue UAC prompt it needs the owner to consent on the secure desktop and to tap a physical key during enrollment, which a software authenticator driven by the agent cannot provide into the owner's elevated session [unverified: behaviour of virtual authenticators against the elevated enrollment page].

The #419 `owner-anchor-pin` rule stays: the envelope carries `hardwareAnchorFingerprintSha256`, inside the hash the tap covers, and must equal the installed anchor's fingerprint.

## 6. Credential handling and its same-user limit

* **Where the Stripe restricted key lives:** `cred\` in the install root, readable only by `d24run` (DPAPI under `d24run`'s profile, or an ACL-only file; whichever the test plan shows works non-interactively [unverified]). The owner's user and therefore the agent cannot read it. The key is **not** in Credential Manager or DPAPI of the owner's user any more.
* **Entering the key:** at install, in the elevated session, through the existing hidden-input prompt (`secretprompt.ts` [code]); it goes to `cred\` through stdin of a helper running as `d24run`, never argv, env, log or clear file **(no such helper exists yet; it must run from `<root>\release`)**.
* **At run time:** `d24run` reads it and passes it to the proof child as an **environment variable**, as #417 does [code] **[corrected: not stdin]**. The agent's user cannot open another account's process memory without administrator rights.
* **Same-user limit that remains:** (a) anything that runs as `d24run` can use the key, so `d24run` has no interactive logon, no shell, a random password the installer does not keep (held by Task Scheduler) [unverified mechanics], and the only code it executes is the verified tree; (b) the key is a restricted `rk_test_` key with three permissions, expired by the owner after the work, so a leak is bounded by Stripe-side limits too; (c) a hostile process that gets administrator rights bypasses everything (out of scope); (d) the *proof output* the owner's user can read (evidence) never contains the key [code].
* **Rotation:** elevated install again, enter the new key, expire the old key in the Stripe dashboard.

## 7. Threat table

| Threat (non-elevated agent as the owner's user) | Prevented? | By what | Independently enforceable? |
|---|---|---|---|
| Edit runner code or `REQUIRE_HARDWARE_FOR_LIVE` and run it | **Only for an agent without administrator rights, and only if object OWNERSHIP of every file is Administrators [corrected: the first build never set or checked owners; see 12.2]** | Execution only from the admin-owned root; tree hash (runner, proof, lockfile, package.json, tsconfig, node_modules) vs `release.json`; owner+DACL of every file by SID | ACL/ownership: yes if correct on the real machine (U1/U2); **no against an agent that can elevate (section 13)** |
| Replace `anchor.json` / enrolled fingerprint with a software authenticator's key | As the row above **[corrected]**; the enrollment tap in the elevated session is **not built**, the anchor is confirmed by typing its fingerprint group | Anchor in the admin root; rotation only through the installer with an explicit request and a typed group | As above |
| Change policy ceilings (calls, amounts, accounts, TEST-only) | As the first row **[corrected]** | `policy.json` admin-owned and owner-checked; envelope may only equal or narrow (a wider one is refused) | As above |
| Rewrite the verifier or counter/ledger to accept replay | As the first row **[corrected]**; `state\` files must be owned by Administrators/`d24run` | Admin root + `state\` owner/DACL | As above |
| Read the Stripe key and call Stripe directly | Only if the key was never in the owner's profile and the agent cannot elevate **[corrected]** | Key under `d24run`, not the owner's profile | Account/ACL isolation, [unverified]; **not against an agent that can elevate** |
| Forge a hardware approval | Yes | Device-bound credential, UV, challenge = envelope hash (#419) | Yes (cryptographic) given the anchor is unforgeable |
| Swap the envelope after the tap | Yes | Copy-then-verify in a private directory; assertion covers the hash | Yes |
| Install a malicious tree by "updating" | **Only with the bootstrap in 12.3 step 0 [corrected: the first build ran the elevated installer from agent-writable code, toolchain and environment, which handed the agent administrator rights]** | The installer refuses to run unless its code, node, git, source clone and environment are administrator-only; commit proven on `main` with pinned blobs and as a merged PR's merge commit; no downgrade | The checks run in code the bootstrap must already have made trustworthy: **the owner's typed comparison with the chat proposal is the independent step (U10)** |
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

1. **One elevated install** (see 12.3: a bootstrap, then the installer) that: creates the root with owner and ACL first, stages, verifies and swaps the verified tree, writes `policy.json` and `release.json`. **[corrected: it does not create `d24run` or the task, take the key, or run the hardware enrollment; those are separate manual steps in 12.3]** The installer shows commit, PR number, tree hash and the new anchor fingerprint first and asks the owner to confirm by typing the first group of the fingerprint.
2. **One hardware enrollment tap** (inside that same install).
3. **One tap per run**, after comparing the three fingerprint groups with the chat proposal.

Unavoidable extras, named honestly: creating the Stripe restricted key in the dashboard and expiring it afterwards (existing owner steps), and recording the anchor fingerprint out of band. Updates to the runner or policy repeat action 1.

## 10. Minimal implementation delta against #417/#419 (as planned; section 12 records what was built)

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

1. **ANSWERED by the review: it is a local administrator with a UAC split token (the weaker configuration); see section 13 for what that means and the options.** (Original question: is the owner's everyday Windows user a local administrator (UAC split token) or a standard user? A standard user is stronger; with an administrator account the boundary depends on the agent not being able to elevate [unverified].)
2. DPAPI-under-`d24run` versus an ACL-only file for the key (decided by T14).
3. Whether to require a GitHub-"Verified" signed tag in the installer now or later.
4. Who may run the installer's clean-clone step (the owner at a keyboard; the agent never elevates).

## 12. As built (owner-authorized build, local code only; revised after the independent review of PR 423)

Status of this section: the code below exists in `scripts/qa/d24-test-runner/` and is covered by offline tests on throwaway temp directories with fake security descriptors, a software authenticator and a simulated executor. **Nothing has been run on a real machine: no elevated install, no `C:\ProgramData\d24-runner`, no `d24run` account, no scheduled task, no enrollment, no Credential Manager, no Stripe call.** The runner stays inactive. **It is not a boundary until section 13's conditions hold on the real machine.**

### 12.1 What was built, versus section 10

| Planned (section 10) | Built | Note |
|---|---|---|
| `trustroot.ts` (install root) | **`installroot.ts`** | `trustroot.ts` already exists on main (pinned repo/branch constants). Holds `INSTALL_ROOT`, `ADMIN_NODE`, the release-record parser, the **SDDL** parser and per-role rules (owner SID + DACL by trustee SID and access mask, fail closed), the whole-tree ACL gate, the root-path gate, the installed-tree hashes. |
| `policy.ts` | `policy.ts` | Strict parse; ceilings bounded by the proof's `HARD_CALL_CAP`; run-as and owner **SIDs**; `clampEnvelopeToPolicy` refuses (never narrows) a widening envelope. |
| `fingerprint.ts`, `launcher.ts` | built | Fingerprint, typed first group, exactly one pending envelope, assertion written `wx`. The authenticator call is **injected**: the real ceremony is not built. |
| `execinbox.ts` | built | See 12.2. |
| `install/Install-D24Runner.ps1` | **`installer.ts` + `installedcli.ts` + `provenance.ts`** | TypeScript with injected providers; `installedcli.ts` holds the real providers and is never run by tests. The `d24run` account and the scheduled task remain documented manual administrator steps (12.3). |
| runner edits | `runner.ts` only | `installed-root` gate; installed-mode tree gates (12.2). Everything else unchanged. |
| `installmint.ts`, `safefs.ts` | added | The brand is mintable only from `execinbox.ts` (a static import scan enforces it); reads of inbox files do not follow links. |

### 12.2 What the code does, precisely

**Ownership and ACLs (review P0-1, P0-1b, P2-1).** The ACL gate reads, in one PowerShell call, `GetSecurityDescriptorSddlForm('Owner,Access')` for the root and **every directory and file below it** and decides by SID: the owner must be Administrators or SYSTEM (for `state`/`evidence`/`cred` also the run-as account; for `inbox` also the owner's user), write-class access masks are allowed only to Administrators/SYSTEM (plus run-as on `state`/`evidence`), `cred` admits no other trustee at all, and the inbox owner is limited to read plus add-file/add-subdirectory. Any link, any token, ACE type or descriptor it does not understand, and a missing DACL fail closed. Names are never compared.
**The installer creates the root itself** (an existing root is adopted only if it already passes that whole gate, so an agent-pre-created or agent-owned root is refused), applies owner+DACL while the root is still empty, and checks it, **before** any content is written. Content is staged in `staging-<random>` inside the locked root, hashed and ACL-checked there, then swapped in with renames; the whole root is read back; any failure restores the previous install.

**What is pinned and re-hashed on every run (review P1-1).** Runner folder, proof folder, `package.json`, `package-lock.json`, `tsconfig.json` (installer-written constant, so tsx never walks up to a user-creatable `C:\ProgramData\tsconfig.json`) and **raw-byte `node_modules`** (installed by the elevated `npm ci --ignore-scripts` with empty administrator-owned npm configs, a fixed registry and no inherited environment). The runner re-verifies this tree again immediately before the approval counter is recorded.

**Who runs, on what (review P1-2).** The run-as account is identified by **SID**; `process.execPath` must be the fixed `C:\Program Files\nodejs\node.exe` and itself administrator-owned; `os.tmpdir()` must be `<root>\state\tmp`, and the proof child gets `TEMP`/`TMP` set there (tsx's compile cache cannot sit in a shared, user-writable directory).

**Provenance (review P2-4).** The installer requires the commit to be on `main` with the runner, proof, `package.json` and lockfile blobs equal to the pinned hashes (SHA-1-verified objects, existing code) **and** the GitHub API to say the PR is merged into `main` of the pinned repository, merged by the owner's login, with `merge_commit_sha` equal to the release commit. A release whose PR number is older than the installed one, or another commit of the same PR, is refused (no downgrade). The anonymous API read assumes the repository is readable without credentials (the existing `commit-on-main` gate has the same assumption); if it is private, this needs an owner decision.

**The first anchor (review P1-3).** On a first install and on any replacement the owner must type the first group of the anchor's fingerprint; the anchor file must be pinned inside the verified source tree or itself be administrator-owned and not writable by anyone else. **The enrollment tap inside the elevated session described in sections 5 and 9 is not built**; the anchor comes from the enrollment work (OWNER-AUTH section 7).

**Inbox (review P2-3).** Files are read from the opened handle with an lstat/fstat identity check, size-capped, and the run directory must be a real directory; the private work copy is removed on every failure path. The inbox ACL gives the owner add-file/add-subdirectory plus read at the directory level and no object-inherit; but a file the owner creates is **owned** by the owner, so the owner can rewrite that file afterwards. The inbox is therefore **not tamper-proof**; it is untrusted by design (copy, recompute the canonical hash, verify the assertion against the installed anchor). The earlier phrase "create-only" overstated it.

**The brand (review P2-2).** `runEnvelope` refuses the real executor unless the `installed` object was minted by `execinbox`. The brand is an in-process invariant; what actually keeps the key from the owner's user is key custody under `d24run` (12.3). Code in the same process could still mint it, so it is not a security boundary by itself.

**The key.** It reaches the proof child as an **environment variable** (`childenv.ts`), not over stdin as section 6 first said. The child runs as `d24run`, which the owner's user cannot inspect without administrator rights.

### 12.3 Manual administrator/owner steps (code does not do these; all unverified until run)

0. **Bootstrap (the part code cannot self-attest).** In an **elevated PowerShell started with `-NoProfile`** (an elevated PowerShell's profile lives under the owner's profile, which the agent can write): create an administrator-only working directory (for example `C:\ProgramData\d24-src` with `icacls <dir> /inheritance:r /setowner *S-1-5-32-544 /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F`), then `git clone` the repository **from GitHub into it** with `C:\Program Files\Git\cmd\git.exe`, `git checkout <merge commit>`, using a clean environment. Compare the commit printed there with the commit and tree fingerprint in the chat proposal **before** running anything from the clone.
1. Create the local account `d24run` (no interactive logon) and the scheduled task whose action is `cmd.exe /d /c "set TEMP=<root>\state\tmp&& set TMP=<root>\state\tmp&& "C:\Program Files\nodejs\node.exe" <root>\release\node_modules\tsx\dist\cli.mjs <root>\release\scripts\qa\d24-test-runner\installedcli.ts exec <runId>"`, run as `d24run`, with a security descriptor that lets the owner user start but not edit it.
2. Run `install` **from that administrator-owned clone, with `C:\Program Files\nodejs\node.exe`**, in the same elevated, clean session. The installer refuses to start otherwise (environment variables such as `NODE_OPTIONS`, `npm_config_*`, `GIT_*`, `NODE_PATH`, proxies; node not at the fixed path or not administrator-owned; the installer code not inside the clone being verified; the clone or git not administrator-only).
3. Enter the restricted key into `<root>\cred` **as `d24run`, from `<root>\release`** (never from a checkout the agent can edit). No helper for this exists yet.
4. Hardware enrollment of the anchor and the launcher's tap ceremony (OWNER-AUTH section 7) are separate, unbuilt work.

### 12.4 What the offline tests prove

Each threat-table row that code can prove has a test that fails when the guarding line is removed (mutation evidence in the PR description). Among them: the review's own scenarios as tests (an object **owned** by the owner's user with a perfect DACL; a consistent rewrite of anchor+policy+release by an owning agent; an agent-owned file under `node_modules` or `state`; numeric masks, odd tokens, imposter-named accounts; an existing agent-created root); tree/lockfile/`package.json`/`tsconfig.json`/`node_modules` tampering; identity by SID, node path and ACL, and TEMP isolation; each envelope-vs-policy widening and the daily cap; swapping the envelope after the copy, an assertion for another envelope or by another key (the #419 verifier against the **installed** anchor, before any key read); failure-path cleanup of the work copy; the real-executor refusal and forged-brand cases; a tree change between the first check and the second; installer refusals (not elevated, toolchain, unverified release, unmerged or older PR, anchor source, wrong typed confirmation), swaps of source files during the confirmation prompt, rollback after a failed read-back, no downgrade, and anchor rotation rules.

### 12.5 What cannot be proven offline (Windows test plan, owner or administrator involvement)

* **U1** the OS enforces the real descriptors against a non-admin process; **U2** the real SDDL of a real install (inherited-ACE flags, the owner an elevated process actually gets, whether `icacls /setowner` and `/inheritance:r` leave exactly the intended descriptor, performance of reading thousands of files);
* **U3** `d24run` isolation, non-interactive DPAPI unseal, the task's profile and `TEMP`, and that tsx honours the redirected temp directory; **U4** the task: start-by-owner-only, fixed action, working directory, `node` resolution;
* **U5** a real authenticator (enrollment, UV/UP flags, cancel/timeout, counter) and the launcher-to-authenticator ceremony; **U6** UAC and elevated-session behaviour (`fltmc` as the elevation probe);
* **U7** the real `npm ci` result is hashed and ACL-checked, but its **contents are not reviewed**: the lockfile integrity hashes bind the registry packages, nothing more;
* **U8** the GitHub API read of the PR (public/private repository, rate limits) and the real git object verification against GitHub;
* **U9** time-of-check/time-of-use gaps between a directory read and later file access are narrowed by the repeated tree hash, not closed;
* **U10** **the bootstrap in 12.3 step 0 is unverifiable by code**: the clone, the elevated shell and the typed commands are the owner's.

## 13. The owner is a local administrator: what that does to the boundary (do not claim more than this)

Facts established by the review: the owner's Windows account is a member of the local Administrators group with a UAC split token ("group used for deny only" in the filtered token).

* **Microsoft does not treat UAC as a security boundary.** Software running as the same user in the owner's interactive administrator session can potentially obtain an elevated token without a consent prompt (known auto-elevation and token-handling techniques), or can prompt the owner for consent at a moment they expect a prompt.
* Consequently an **agent that runs as that user is, for this threat model, potentially administrator**, and an administrator defeats every control in this design (it can edit the install root, read `d24run`'s data with a debugger privilege, or replace the task). Residual R2 (a rogue UAC prompt) is **closer to "likely" than "residual"** in this configuration. The installed root protects against a **standard-user** agent, not against this one.
* What the code still gives, honestly stated: the controls are correct **if** the agent cannot elevate. They detect (at run time, by owner SID, DACL, hashes) many tampering attempts made without administrator rights, and they bound a mistaken or hostile run by policy ceilings. They do not stop an agent that can elevate silently.

Options to make the boundary real, with the disruption of each:

| Option | What changes | Strength | Disruption |
|---|---|---|---|
| **1. Run the agent as a standard (non-admin) Windows user** | The agent's tools run under a separate standard account (for example `agentdev`) with its own profile and checkout; the owner keeps the administrator account for approvals and installs. | Closes silent elevation for the agent: UAC consent for the **other** account needs that account's administrator credentials, which the agent does not have. The install root, `d24run` and the sections above then mean what they say. | Medium-high: a second profile, repository access and tool setup under the new account; file sharing between the two users; the owner approves from the administrator account. |
| **2. Demote the owner's everyday account to a standard user** and keep a separate administrator account for installs | One account for everything, administrator only on demand through credentials (secure-desktop prompt asks for the admin account's password). | Same effect as option 1 for a process in the daily session. | High: the owner's daily workflow changes; installs ask for another account's password. |
| **3. Move the runner and the key to another host or a VM the agent cannot administer** | The scheduled task, the install root, `d24run` (or equivalent), the key and the ledger live on a different machine/VM; the owner's tap and the envelope inbox reach it over a narrow channel. | Strongest: the agent's session does not share an operating system with the key. | Highest: a second machine, a transport for envelopes and evidence, and its own patching. |
| **4. Accept the current configuration** | Nothing changes. | The runner remains defense in depth against mistakes and unprivileged tampering; **not** a boundary against an agent that can elevate. Any claim of independence must be withheld. | None. |

Owner decision (recorded): the agent will run as a standard user; section 14 is the setup. Recommendation: do not describe the installed runner as independent of the agent until option 1, 2 or 3 is in place and the Windows test plan items U1 to U6 have been run on the real machine. Until then treat each run as supervised and the Dashboard check (D24-REQUEST-RECONCILIATION.md) as the control.

## 14. Standard-user agent setup (owner decision: the engineering agent runs as a non-administrator)

Status: **nothing here has been executed.** The two scripts in `scripts/qa/d24-agent-setup/` are reviewed text; the setup script is a dry run unless the administrator adds `-Apply`. Both parse cleanly under the PowerShell 5.1 parser (parse only, not run), and a static test (`scripts.test.ts`) pins their safety properties. This section replaces option 1 of section 13 with concrete steps; it does not change what section 13 says about the current configuration.

### 14.1 The three accounts

| Account | Kind | Rights | Used for |
|---|---|---|---|
| **Owner** (existing, `genx01\mcurt`) | local **Administrator** (UAC split token) | full | the one-time elevated install and enrollment (sections 12.3, 14.3), reviewing and merging, the hardware tap, approvals; **not** used to run the agent |
| **Agent** (new, for example `agentdev`) | local **standard user** (Users group only; no Administrators, Backup Operators, Power Users, Remote Management Users, Event Log Readers) | modify on its own profile and `C:\Dev\agent-work` only | Claude Code/Desktop, git, node, the repository clones the agent edits and tests |
| **d24run** (new) | local standard service user, **no interactive or remote logon**, random password nobody keeps, batch-logon right | owns nothing but `state\`, `evidence\`, and the DPAPI blob in `cred\` | the scheduled task that runs `installedcli.ts exec` and holds the Stripe test key |

Three different accounts are required (the setup script refuses otherwise). The owner's account must not be the agent's account, and `d24run` must not be usable to sign in by anyone.

### 14.2 What moves to the agent's profile, and what must NOT be reachable from it

**Moves to the agent account** (done by the owner at the keyboard; engineering prepares no automation for it):
* repository clones: create fresh clones under `C:\Dev\agent-work\...` (ACL set by the setup script: Administrators and SYSTEM full, the agent modify, nobody else). The owner's existing `C:\Dev\studioapp` and its worktrees stay where they are and must become **unreadable** to the agent (14.4 checks it; the setup script only reports, it never rewrites the owner's ACLs);
* Claude Code / Claude Desktop sign-in: the agent signs in as itself; the owner's session and its token store (`%APPDATA%`, `%LOCALAPPDATA%` of the owner) stay in the owner's profile;
* git and `gh` credentials: new credentials created **for the agent account** with the narrowest scope that works (a fine-grained token limited to this repository with no admin, no merge-bypass, no environment/secrets access, no workflow permission unless needed); the owner's `gh` login and any personal access token with wider scope must not be copied;
* node toolchain: the agent needs its own user-level installs (nvm/volta/portable node or the machine-wide `C:\Program Files\nodejs`, which the installer's pinned `ADMIN_NODE` already uses read-only), and its own `npm`/`tsx` caches in its profile.

**Must NOT be reachable from the agent account:**
* the owner's profile (`C:\Users\<owner>`), including `AppData\Local\DanceFlow\d24-owner` (owner trust files, hardware anchor state) and `d24-runner`, `.ssh`, `.config\gh`, browser profiles and password stores, Windows Credential Manager of the owner;
* the owner's repository checkouts (`.env` files, local secrets);
* write access to `C:\ProgramData\d24-runner` (all of it) and **any** access to `cred\`;
* the hardware key and the owner's session (the agent cannot tap; only the owner can);
* a path to administrator rights: no saved administrator credentials, no `runas /savecred`, no membership in a group that can start the installer, and no administrator password in any file or environment the agent can read.

### 14.3 Engineering-prepared artifacts (nothing executed)

* `scripts/qa/d24-agent-setup/Setup-D24StandardUserAgent.ps1` — the owner copies it to an **administrator-owned folder**, starts an elevated `powershell -NoProfile`, and runs it **first without `-Apply`** (a dry run that checks and prints `WOULD ...`; it exits with code 10, never 0), then with `-Apply`. It fails closed (any precondition it cannot evaluate stops it with exit 2 and nothing further changes), is idempotent (it acts only on what differs), puts every change on a visible `Do-Change` line, and refuses to run unless elevated, started with `-NoProfile`, and the script file itself is administrator-owned and not writable by anyone else. It: checks or creates the agent and `d24run` accounts (`-CreateAccounts`; it reads the agent's password as a prompt and generates a random discarded one for `d24run`; it never prints or stores a password), checks that neither is an administrator or a member of the privileged groups and removes an unexpected administrator membership, sets the UAC values of 14.4, creates `C:\Dev\agent-work` with the ACL above, and **reports** (does not change) whether the agent's groups can read the owner's profile, the owner's checkout and `cred\`. It lists as **MANUAL** what it deliberately does not do: the user-rights assignments (deny interactive and remote logon for `d24run`, allow batch logon), the scheduled task, a restart for `EnableLUA`, and moving the agent's work.
* `scripts/qa/d24-agent-setup/Verify-D24StandardUserAgent.ps1` — run **by the agent account, not elevated**. It exits 0 only if every check ran and passed, 1 on any failure, **3 if it could not evaluate something** (so a missing install root is never reported as a pass).
* Minimal owner-only steps, in order: (1) read the two scripts (and run `scripts.test.ts`); (2) log in as the owner and run the dry run, read the output; (3) run with `-Apply -CreateAccounts`, enter the agent's password when prompted; (4) apply the MANUAL items; (5) restart if told to; (6) sign in as the agent, set up the clones and credentials of 14.2, run the verification script and send its output; (7) only then follow section 12.3 (bootstrap, install, key entry, enrollment).

### 14.4 UAC setting and the negative tests the verification script runs

Required policy values (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`):

| Value | Required | Meaning |
|---|---|---|
| `EnableLUA` | `1` | UAC on |
| `ConsentPromptBehaviorUser` | **`1`** (or `0`) | standard users are asked for **administrator credentials on the secure desktop** (`1`); `0` automatically denies every elevation request and is stricter. `3` prompts for credentials but **not** on the secure desktop and is not acceptable |
| `PromptOnSecureDesktop` | `1` | the prompt runs on the secure desktop, where the agent's processes cannot synthesize input into it |
| `ConsentPromptBehaviorAdmin` | `2` (or `1`) | an administrator session is asked on the secure desktop; `0` (silent) and `5` (non-Windows binaries without prompt on some builds) are not acceptable |
| `FilterAdministratorToken` | `1` | the built-in Administrator account is also filtered |

Negative tests (the verification script performs the ones marked ●; the others are owner/administrator checks, because they need a second session or administrator rights):
* ● the token has no Administrators SID **even as deny-only**, runs at Medium integrity or lower, and lacks `SeDebug`, `SeTakeOwnership`, `SeLoadDriver`, `SeBackup`, `SeRestore`, `SeImpersonate`, `SeTcb`;
* ● the UAC values above;
* ● create a file in `<root>`, `release\`, `state\`, `evidence\`: refused; open `anchor.json`, `policy.json`, `release.json` for writing: refused;
* ● list `cred\` and open a file in it: refused;
* ● list the owner's profile, `AppData\Local\DanceFlow\d24-owner`, `d24-runner`, `.ssh`, `.config\gh`, and the owner's repository checkout: refused;
* ● no D24 credential in the agent's own Credential Manager; no `NODE_OPTIONS`, CA, or Stripe variables in its session;
* ○ (owner, as the agent) trigger any UAC prompt and confirm it asks for **administrator credentials on the secure desktop**, then cancel; confirm `runas /user:<owner>` cannot be completed without the password;
* ○ (administrator) `d24run` cannot log on interactively or over Remote Desktop; its profile is unreadable by the agent;
* ○ (administrator) the scheduled task's security descriptor lets the owner **start** but not edit/delete it, and the agent neither;
* ○ (owner) the inbox accepts a new run directory from the owner's account but the agent account cannot create in it;
* ○ (owner) a deliberate attempt to start the installer as the agent fails at the UAC credential prompt.

### 14.5 Honest list of remaining residuals

1. **The owner's tap and the owner's session are still the trust anchor.** Anything that persuades the owner to type a fingerprint group, tap, or enter administrator credentials (a rogue prompt, a look-alike launcher in the agent's session) is the R1/R2 residual and is only **bounded** by the policy ceilings, TEST-only keys and the Dashboard check.
2. **The agent can still harm what it legitimately owns:** its clones, branches and PRs on GitHub (with the narrow token), and anything the owner later copies from the agent's folders into an elevated context. The bootstrap rule (12.3 step 0) exists so the elevated installer never runs agent-written code.
3. **Windows privilege-escalation vulnerabilities.** A standard-user-to-SYSTEM bug defeats everything; the mitigation is patching, which this design does not provide.
4. **Same-machine side channels** that standard users share: the clipboard, the `Public` profile, `%TEMP%` shared locations, world-writable folders on `C:\`, named pipes and COM objects of the owner's session if the owner is **also logged in** at the same time (fast user switching leaves the owner's processes running; the agent could target them). Log the owner out, or keep the owner's session locked and idle, while the agent works.
5. **GitHub and Anthropic accounts are separate trust domains:** a token the agent holds is only as safe as its scope; the repository's branch protection (and not this design) stops an unreviewed merge to `main`.
6. **Untested on the real machine:** every ACL, policy and account behaviour above. The verification script is the first real evidence and its result belongs in the PR before anything depends on the boundary. Items it cannot test are listed in 14.4.
7. **A domain, Microsoft-account, or Azure AD-joined owner** changes how accounts and SIDs resolve; the setup script stops (fail closed) rather than guessing.
8. **The owner's convenience cost** is real (two sign-ins, separate credentials, file hand-offs); if it is judged too high, option 3 of section 13 (a separate host) is the next-strongest alternative, and option 4 (accept the current configuration) must be recorded explicitly with its weaker claim.
