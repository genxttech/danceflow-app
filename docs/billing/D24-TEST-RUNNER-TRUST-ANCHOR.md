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
**The installer creates the root itself** (an existing root is adopted only if it already passes that whole gate, so an agent-pre-created or agent-owned root is refused), applies owner+DACL to **that one directory** (no `icacls /T` anywhere: children inherit from the locked parent when they are created, so no tree is ever walked by `icacls`), then re-reads the root recursively and **requires that it contains nothing but itself** before any content is written (a child or junction planted between `mkdir` and the apply is detected there, and `icacls` without `/T` cannot be redirected by it). Content is staged in `staging-<random>` inside the locked root, hashed and ACL-checked there, then swapped in with renames; the whole root is read back; any failure restores the previous install.

**What is pinned and re-hashed on every run (review P1-1).** Runner folder, proof folder, `package.json`, `package-lock.json`, `tsconfig.json` (installer-written constant, so tsx never walks up to a user-creatable `C:\ProgramData\tsconfig.json`) and **raw-byte `node_modules`** (installed by the elevated `npm ci --ignore-scripts` with `npm_config_userconfig`/`globalconfig` pointing at non-existent files, which npm treats as empty, a fixed registry and a scrubbed environment). The runner re-verifies this tree again immediately before the approval counter is recorded.

**Who runs, on what (review P1-2).** The run-as account is identified by **SID**; `process.execPath` must be the fixed `C:\Program Files\nodejs\node.exe` and itself administrator-owned; `os.tmpdir()` must be `<root>\state\tmp`, `TSX_DISABLE_CACHE=1` must be set, and the proof child gets `TEMP`/`TMP` set to `state\tmp`. **These two gates run after tsx has already loaded the task's own modules, so they are consistency checks, not the control:** the control is the scheduled task's action, which must set both variables before tsx starts (12.3 step 1); with the cache disabled there is no compile cache to poison.

**Provenance (review P2-4).** The installer requires the commit to be on `main` with the runner, proof, `package.json` and lockfile blobs equal to the pinned hashes (SHA-1-verified objects, existing code) **and** the GitHub API to say the PR is merged into `main` of the pinned repository, merged by the owner's login, with `merge_commit_sha` equal to the release commit. Releases are ordered by **git history**: the new commit must be the installed commit or a descendant of it (`git merge-base --is-ancestor` in the administrator-owned clone); the PR number is not used for ordering (a higher-numbered PR merged earlier carries an older runner). The anonymous API read assumes the repository is readable without credentials (the existing `commit-on-main` gate has the same assumption); if it is private, this needs an owner decision.

**The first anchor (review P1-3).** The anchor file must come from an **owner-present enrollment output placed on an administrator-owned path** (the installer checks owner and DACL of that file; being inside the source clone no longer counts as verified: the pins cover only the runner and proof folders). The owner must type **64 bits** (the first 16 hex characters, `XXXX-XXXX-XXXX-XXXX`) of the anchor fingerprint **from the record made at enrollment**; the installer deliberately does **not** print the fingerprint (nor the new one on rotation), so the typed value is compared with an out-of-band record rather than copied from the screen. A 16-bit group (the previous check) can be ground by an attacker holding a software key. **The enrollment tap inside the elevated session described in sections 5 and 9 is not built**; the enrollment itself is the OWNER-AUTH section 7 work, and until it exists there is no honest source for the first anchor.

**Inbox (review P2-3).** Files are read from the opened handle with an lstat/fstat identity check, size-capped, and the run directory must be a real directory; the private work copy is removed on every failure path. The inbox ACL gives the owner add-file/add-subdirectory plus read at the directory level and no object-inherit; but a file the owner creates is **owned** by the owner, so the owner can rewrite that file afterwards. The inbox is therefore **not tamper-proof**; it is untrusted by design (copy, recompute the canonical hash, verify the assertion against the installed anchor). The earlier phrase "create-only" overstated it.

**The brand (review P2-2).** `runEnvelope` refuses the real executor unless the `installed` object was minted by `execinbox`. The brand is an in-process invariant; what actually keeps the key from the owner's user is key custody under `d24run` (12.3). Code in the same process could still mint it, so it is not a security boundary by itself.

**The key.** It reaches the proof child as an **environment variable** (`childenv.ts`), not over stdin as section 6 first said. The child runs as `d24run`, which the owner's user cannot inspect without administrator rights.

### 12.3 Manual administrator/owner steps (code does not do these; all unverified until run)

Do these only after section 14 (the agent is a standard user) **and** from a **fresh administrator account** (14.6): the owner's current profile is writable by the agent today, and everything below runs elevated.

0. **Bootstrap (the part code cannot self-attest).** In an elevated `powershell.exe -NoProfile` of the fresh administrator account. The clone and the script copies live **inside that account's own profile** (`C:\Users` is not creatable by standard users and the profile is unreadable to them), never under `C:\ProgramData`, where any user can pre-create or race a folder. Every command uses fixed System32/Program Files paths; `$ErrorActionPreference = 'Stop'` turns any failed step into an abort; no user git or npm configuration may apply:

   ```powershell
   $env:PSModulePath = "$PSHOME\Modules"
   $ErrorActionPreference = 'Stop'
   $icacls = 'C:\Windows\System32\icacls.exe'; $git = 'C:\Program Files\Git\cmd\git.exe'; $node = 'C:\Program Files\nodejs\node.exe'
   function Run($exe, [string[]]$a) { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" } }
   function Assert-AdminOnlyEmpty($p) {   # owner Administrators, protected DACL with only Administrators/SYSTEM, and EMPTY
     $acl = (Get-Item -LiteralPath $p -Force).GetAccessControl()
     if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw "$p is not owned by Administrators" }
     $bad = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { @('S-1-5-32-544', 'S-1-5-18') -notcontains $_.IdentityReference.Value })
     if ($bad.Count -gt 0) { throw "$p grants access to $($bad[0].IdentityReference.Value)" }
     if (@(Get-ChildItem -LiteralPath $p -Force).Count -ne 0) { throw "$p is not empty" }
   }
   $src = Join-Path $env:USERPROFILE 'd24-src'
   if (Test-Path -LiteralPath $src) { throw "$src already exists: remove it as an administrator or pick a new name" }
   New-Item -ItemType Directory -Path $src | Out-Null
   Run $icacls @($src, '/setowner', '*S-1-5-32-544')
   Run $icacls @($src, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')   # this folder only, while it is empty; children inherit
   Assert-AdminOnlyEmpty $src
   New-Item -ItemType Directory -Path "$src\tmp" | Out-Null
   $env:TEMP = "$src\tmp"; $env:TMP = "$src\tmp"
   # git: no system or global config, no hooks, no templates, HTTPS only (these GIT_* variables are removed again below: the installer refuses to run with them)
   $env:GIT_CONFIG_NOSYSTEM = '1'; $env:GIT_CONFIG_GLOBAL = 'NUL'
   if (Test-Path -LiteralPath "$src\repo") { throw 'repo already exists' }
   Run $git @('-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--template=', '--no-checkout', 'https://github.com/genxttech/danceflow-app.git', "$src\repo")
   Run $git @('-C', "$src\repo", '-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', 'checkout', '--detach', '<MERGE_COMMIT>')
   Run $git @('-C', "$src\repo", 'rev-parse', 'HEAD')        # must equal <MERGE_COMMIT> from the chat proposal; compare by eye
   Remove-Item Env:GIT_CONFIG_NOSYSTEM, Env:GIT_CONFIG_GLOBAL
   # re-verify AFTER the clone: nothing under $src is a link, and everything is still owned by Administrators
   $links = @(Get-ChildItem -LiteralPath $src -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
   if ($links.Count -gt 0) { throw "reparse point(s) under $src : $($links[0].FullName)" }
   $odd = @(Get-ChildItem -LiteralPath $src -Recurse -Force | Where-Object { $_.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' } | Select-Object -First 3)
   if ($odd.Count -gt 0) { throw "not owned by Administrators: $($odd[0].FullName)" }
   # dependencies of the installer itself (tsx): scrubbed npm, no scripts
   $env:npm_config_userconfig = "$src\.npmrc-none"; $env:npm_config_globalconfig = "$src\.npmrc-none"; $env:npm_config_cache = "$src\.npm-cache"
   $env:npm_config_registry = 'https://registry.npmjs.org/'; $env:npm_config_ignore_scripts = 'true'
   Push-Location "$src\repo"; Run $node @('C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js', 'ci', '--ignore-scripts'); Pop-Location
   Remove-Item Env:npm_config_userconfig, Env:npm_config_globalconfig, Env:npm_config_cache, Env:npm_config_registry, Env:npm_config_ignore_scripts
   ```

   Compare the commit printed by `rev-parse` with the commit and tree fingerprint in the chat proposal **before running anything from the clone**. The installer then re-verifies (it refuses unless the clone, node, npm's **tree**, git's **trees** (`mingw64\bin` and `libexec\git-core`) are administrator-only by owner and DACL, the environment is clean and the code runs from the clone). That is an ACL/owner check of those trees, **not a content hash**: the integrity of Program Files content is otherwise trusted. The `<MERGE_COMMIT>` comes from the owner's own look at the merged PR on GitHub, not from a file in an agent-writable folder. The same procedure (a new, empty, administrator-only folder in this profile, `Assert-AdminOnlyEmpty` before use) is used to obtain the two PowerShell scripts (14.6).
1. Create the local account `d24run` (no interactive logon; setup script, 14.3) and the scheduled task whose action is `C:\Windows\System32\cmd.exe /d /c "set TEMP=<root>\state\tmp&& set TMP=<root>\state\tmp&& set TSX_DISABLE_CACHE=1&& "C:\Program Files\nodejs\node.exe" <root>\release\node_modules\tsx\dist\cli.mjs <root>\release\scripts\qa\d24-test-runner\installedcli.ts exec <runId>"`, run as `d24run`, with a start-in directory of `<root>\release`, and a security descriptor that lets the owner user start but not edit it. **The cache and TEMP variables must be set here, before tsx starts**: `execinbox` can only confirm afterwards that they were.
2. Run `install` from that clone with the fixed node, in the same elevated, clean session: `$env:TSX_DISABLE_CACHE = '1'; & $node "$src\repo\node_modules\tsx\dist\cli.mjs" "$src\repo\scripts\qa\d24-test-runner\installedcli.ts" install --source "$src\repo" --commit <MERGE_COMMIT> --pr <N> --github-login <owner login> --platform acct_... --connected acct_... --anchor <enrollment output on an administrator-owned path> --owner-account <owner>`. The installer refuses otherwise (`NODE_OPTIONS`, `npm_config_*`, `GIT_*`, `NODE_PATH`, other `TSX_*`, proxies; node, the npm tree, the git trees, the clone or the anchor file **and its folder** not administrator-only; installer code not inside the clone being verified).
3. Enter the restricted key into `<root>\cred` **as `d24run`, from `<root>\release`** (never from a checkout the agent can edit). No helper for this exists yet.
4. Hardware enrollment of the anchor and the launcher's tap ceremony (OWNER-AUTH section 7) are separate, unbuilt work, and enrollment must happen **before** step 2.

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

* `scripts/qa/d24-agent-setup/Setup-D24StandardUserAgent.ps1` — obtained from the **administrator-owned bootstrap clone** (14.6) and started from an elevated `powershell.exe -NoProfile` **of the fresh administrator account**. Run it **first without `-Apply`**. Three phases: (1) **check** — read-only; every precondition and the full set of intended changes are evaluated first; (2) **plan** — printed as `WOULD ...`; any failed check **and any unexpected error in phases 1–2** (a `trap`) exits **2 with nothing changed**; a clean dry run exits **10** (never 0); (3) **apply** — only with `-Apply`. A change is planned only when current state differs; the plan order is **accounts → demotions → UAC values → `C:\Dev` tightening (only with `-TightenDevRoot`) → workspace**, so nothing needs something created later. If an action throws, it stops, lists what was done and what was not, and exits 2. **Recovery state:** an interrupted run can leave the workspace folder **empty**; the re-run recognises that, re-checks it is empty and not a link at apply time, and applies the ACL to it. Nothing else is left half-done by design, and every other step is re-planned only if still missing. Properties pinned by a static test:
  * the **first statement after `param`** is the plain assignment `$env:PSModulePath = "$PSHOME\Modules"` — no cmdlet runs before it (`param` must come first in a script, and it contains only literal defaults) — in **both** scripts; the LocalAccounts module is imported by full inbox path; fixed System32 binaries; registry values read defensively;
  * **no recursive ACL change anywhere** (no `icacls /T`); the workspace must be a **new** folder, or empty, or already carry exactly the expected descriptor (**compared by parsed SID and mask, order-independent**); it is created and then verified empty; a junction or symlink at the workspace or **at any ancestor** is refused; 8.3 short-name segments are refused;
  * the script file **and its folder** must be administrator-owned and not writable by anyone else;
  * lockout guard: account names must be letters/digits/`. _ -` (**no wildcards**); the agent may not be the account running the script, resolve to the owner, or be the built-in Administrator; no plan may leave zero enabled administrators; the owner must be an enabled administrator;
  * it never prints or stores a password (agent: SecureString prompt, at least 12 characters; `d24run`: random, discarded);
  * **`C:\Dev`**: if Authenticated Users, Users or Everyone hold read or write there it is **reported as MANUAL**; with **`-TightenDevRoot`** the plan contains the exact non-recursive change (inheritance off, those three removed, the owner granted Modify, Administrators and SYSTEM Full). **Windows propagates that inheritable change to everything below that inherits it, including the owner's checkouts** — read the plan before `-Apply`. Without this step the verification can never exit 0;
  * it **reports** (does not change) whether the agent's SIDs (including `S-1-5-113`) can read the owner's profile, the owner's checkout and `cred\` — on the top-level folder only. It lists as **MANUAL**: the user-rights assignments (deny interactive and remote logon for `d24run`, allow batch logon), the scheduled task and `d24run`'s password handling (an S4U logon may not be able to unseal a DPAPI CurrentUser blob: test U3), a restart for `EnableLUA`, and moving the agent's work.
* `scripts/qa/d24-agent-setup/Verify-D24StandardUserAgent.ps1` — run in the agent's own logon session, not elevated. It is **advisory only, whoever starts it**: it runs inside the agent's session, which controls its own `HKCU\Environment`, Run keys and all same-user processes, so even an owner-started, hash-checked run proves which file was started, not what ran. The **authoritative** evidence is **administrator-side**: the Setup dry run from the fresh administrator account (group membership, UAC values, ACLs, `C:\Dev`) plus the owner's own observation of the items marked ○ in 14.4. Exit codes of Verify: 0 only if every check ran and passed; 1 on any failure (including an error that is not "access denied"); 3 if something could not be evaluated.
* Owner-only steps, in order: (1) 14.6 (fresh administrator account, bootstrap clone, scripts from the clone); (2) the Setup dry run, read in full; (3) `-Apply -CreateAccounts` (and `-TightenDevRoot` after reading what it will do); (4) the MANUAL items; (5) restart; (6) sign in as the agent in **its own logon session**, set up clones and credentials (14.2), run Verify (advisory) and send the output; (7) from the administrator account re-run the Setup **dry run** (it should now plan nothing and exit 10) and perform the ○ observations; (8) only then 12.3.

### 14.4 UAC setting and the negative tests

Required policy values (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`):

| Value | Required | Meaning |
|---|---|---|
| `EnableLUA` | `1` | UAC on (a change needs a restart) |
| `ConsentPromptBehaviorUser` | **`0`** | standard users' elevation requests are **automatically denied**. The agent never needs to elevate, so no prompt should exist at all: with `1` or `3` the agent can raise credential prompts whenever it likes, and a prompt that appears while the owner is busy or expecting another one is the rogue-prompt residual (R2) moved to the agent account. (`1` asks for credentials on the secure desktop, `3` asks for credentials and `PromptOnSecureDesktop` decides the desktop; neither is wanted here) |
| `PromptOnSecureDesktop` | `1` | prompts run on the secure desktop |
| `ConsentPromptBehaviorAdmin` | `2` | an administrator session asks for consent on the secure desktop (`0` is silent elevation; `5` still elevates some Windows binaries without a prompt) |
| `FilterAdministratorToken` | `1` | the built-in Administrator also runs filtered (the value may be absent: the scripts read it defensively and set it) |

Negative tests. The verification script performs the ones marked ● (advisory, see 14.3); ○ need a second session or administrator rights:
* ● `whoami /groups` lists **no** Administrators SID (S-1-5-32-544), no **S-1-5-114** ("local account and member of Administrators") and none of Backup/Account/Server/Print Operators or Replicator, with **any** attribute — a split administrator token shows S-1-5-32-544 as "Group used for deny only" and is invisible to `IsInRole` and `WindowsIdentity.Groups`, which is exactly the owner's current account; also Medium integrity or lower and none of `SeDebug`, `SeTakeOwnership`, `SeLoadDriver`, `SeBackup`, `SeRestore`, `SeImpersonate`, `SeTcb`, `SeCreateToken`, `SeAssignPrimaryToken`;
* ● the UAC values above;
* ● create a file in `<root>`, `release\`, `release\node_modules`, the runner and proof folders, `state\`, `state\tmp`, `evidence\`, `inbox\` (a standard user must not create in the inbox either: only the owner does), and a **sub-folder** in the root: each must be refused with Windows' access-denied (any other error is a failure, not a pass); **open the root, `release\`, `release\node_modules` and `state\` for WRITE_DAC, WRITE_OWNER, DELETE and FILE_DELETE_CHILD** (handle-based, nothing modified): only `ERROR_ACCESS_DENIED` passes; open `anchor.json`, `policy.json`, `release.json` for writing: refused, and a missing file is a failure;
* ● create a file in `C:\Program Files\nodejs`, `...\npm`, `C:\Program Files\Git`, `...\mingw64\bin`, the administrator clone (`-AdminClone`), and a folder in `C:\Dev` (where an agent could plant a junction): refused;
* ● list `cred\` and open a file in it: refused, and only access-denied passes (no content is read);
* ● list the owner's profile and, below it, `AppData\Local\DanceFlow\d24-owner`, `d24-runner`, `.ssh`, `.config\gh`, and the owner's repository checkout: refused (a path below a refused folder counts only if the nearest visible ancestor refuses);
* ● no D24 credential in the agent's Credential Manager; no `NODE_OPTIONS`, CA or Stripe variables;
* ○ (owner, in the agent's session) trigger one UAC request and confirm it is **automatically denied**, then try `runas /user:<owner>` and confirm it cannot complete without the owner's password (and then do not enter it);
* ○ (administrator) `d24run` cannot log on interactively or over Remote Desktop and its profile is unreadable by the agent;
* ○ (administrator) the scheduled task's descriptor lets the owner **start** but not edit/delete it, and the agent neither;
* ○ (owner) the inbox accepts a new run directory from the owner's account.

### 14.5 Honest list of remaining residuals

1. **The owner's tap and the owner's session are still the trust anchor.** Anything that persuades the owner to type a fingerprint code, tap, or enter administrator credentials is the R1/R2 residual, only **bounded** by the policy ceilings, TEST-only keys and the Dashboard check.
2. **The first elevation from the owner's current session trusts that session.** Until the owner's profile is audited or a fresh administrator account is used (14.6), anything the agent planted while running as the owner (modules, environment, git/npm configuration, Run keys, scheduled tasks) can run in the elevated steps.
3. **The in-session Verify is advisory.** The agent's session is not trustworthy evidence about itself (14.3); the authoritative checks are administrator-side and the ○ observations.
4. **`C:\Dev` is writable by Authenticated Users on this machine** (inherited from `C:\`). Until it is tightened (Setup `-TightenDevRoot`, or by hand), the agent can plant a junction or folder at the workspace path and can read the owner's checkouts. Tightening it propagates to everything below that inherits, including the owner's repositories, and is the owner's decision.
5. **`C:\ProgramData` lets any standard user create folders**, so a folder or junction can pre-exist at `d24-runner`: the installer refuses an existing root that is not already a valid install and detects anything planted during creation, but it cannot prevent the race, only fail closed (an administrator must delete a refused root). The bootstrap deliberately no longer uses `C:\ProgramData`.
6. **The agent account's own session** is a full desktop session of a standard user: it can run anything a standard user can, read what standard users can read (including the `Public` profile and world-readable folders), and use the network. Nothing in this design contains it beyond Windows' standard-user separation.
7. **Never start the agent with `runas /user:<agent>` or any tool that puts its windows on the owner's desktop:** windows of equal integrity can drive each other (UIPI does not separate them). The agent needs its **own logon session and desktop** (sign out of the owner's session, or use fast user switching and keep the owner's session locked and idle).
8. **The agent can still harm what it legitimately owns:** its clones, branches and PRs (with the narrow token), and anything the owner later copies from its folders into an elevated context.
9. **Windows privilege-escalation vulnerabilities** defeat everything; the mitigation is patching.
10. **Unproven offline:** every ACL, policy and account behaviour; the scripts are parse-checked and statically tested only.
11. **The setup script cannot set user-rights assignments** (deny interactive logon for `d24run`) or create the task; those are manual and unverified (U3/U4).
12. **A domain or Azure AD owner** is not handled (the script stops). A **Microsoft-account owner** (a local user of source MicrosoftAccount, as `mcurt` is) is accepted; only domain/Azure AD owners are refused.
13. **The owner's convenience cost** is real; if it is judged too high, option 3 of section 13 (a separate host) is the next-strongest alternative, and option 4 (accept the current configuration) must be recorded explicitly with its weaker claim.

### 14.6 Clean bootstrap: a fresh administrator account, an administrator-owned clone, and cleaning the owner's profile

The agent has run as the owner's account (`mcurt`) until now, so that profile and everything the agent could write is untrusted input to anything elevated.

**Recommended: a fresh local administrator account** (for example `d24admin`) created by the owner, signed into **only** for these steps, never used for browsing, e-mail or the agent. Run the bootstrap (12.3 step 0), the setup script (14.3) and the install (12.3 step 2) from its elevated `powershell.exe -NoProfile`. Its profile, `PSModulePath`, git and npm configuration, `TEMP` and registry hive were never touched by the agent, and the clone and script copies live **inside that profile**. Creating that account is itself done from the owner's current session, which is the one unavoidable trust step (residual 2).

**If a fresh account is not used, audit and reset the owner's profile first** (each item is something an agent running as the owner can write and an elevated shell would honour): `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and `RunOnce`, `HKCU\Environment` (`PSModulePath`, `TEMP`, `NODE_OPTIONS`, `PATH`), the Startup folder, the owner's scheduled tasks, PowerShell profiles and user modules (including the OneDrive-synced `Documents\WindowsPowerShell\Modules`), `%USERPROFILE%\.gitconfig`, `.npmrc`, `%APPDATA%\npm`, the TEMP folder and any tsx cache under it, the GitHub CLI configuration, and any enrollment-output file. The audit does not make the profile trustworthy against an agent that stays running as the owner.

**Where the scripts come from — exact commands** (continuing the elevated session of 12.3 step 0, after the clone is verified). `>` in Windows PowerShell 5.1 writes UTF-16 and would corrupt the file, so the redirection is done by `cmd.exe`, which writes the blob byte for byte:

```powershell
$tools = Join-Path $env:USERPROFILE 'd24-tools'
New-Item -ItemType Directory -Path $tools | Out-Null
Run $icacls @($tools, '/setowner', '*S-1-5-32-544')
Run $icacls @($tools, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')
Assert-AdminOnlyEmpty $tools
foreach ($n in 'Setup-D24StandardUserAgent.ps1', 'Verify-D24StandardUserAgent.ps1') {
  & 'C:\Windows\System32\cmd.exe' /d /c "`"$git`" -C `"$src\repo`" show <MERGE_COMMIT>:scripts/qa/d24-agent-setup/$n > `"$tools\$n`""
  if ($LASTEXITCODE -ne 0) { throw "git show failed for $n" }
  $blob = (& $git -C "$src\repo" rev-parse "<MERGE_COMMIT>:scripts/qa/d24-agent-setup/$n").Trim()
  $mine = (& $git hash-object "$tools\$n").Trim()
  if ($blob -ne $mine) { throw "$n does not match its git blob ($blob vs $mine)" }
  "$n  blob $blob  sha256 " + (Get-FileHash -Algorithm SHA256 -LiteralPath "$tools\$n").Hash.ToLower()
}
```

The expected value is the **git blob id**: compare the printed blob id with the blob link GitHub shows for that file at the merged commit (open it in a browser on a trusted device), not with anything in chat or in an agent-writable folder. The Setup script prints its own sha256 as well; it refuses to run if its file or folder is not administrator-owned. The copies in the agent's checkout are never run elevated.
