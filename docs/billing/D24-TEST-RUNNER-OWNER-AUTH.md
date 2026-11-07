# D24 TEST runner: owner authorization against an agent running as the same Windows user

Status: design plus an **offline, software-tested verifier** (branch `claude/d24-owner-auth`, stacked on PR #417). Nothing here touches a real authenticator, registers a credential, opens a browser, calls Stripe or reads a real key. Related: `D24-TEST-RUNNER-DESIGN.md`, `docs/twilio/TW-4F_Price_Hardware_Authenticator_Protocol.md`, `docs/twilio/TW-4F_Price_Authorization_Threat_Model.md`.

## 1. The requirement and the part that is easy to get wrong

The owner will not run scripts. Approval has to come from a trust boundary independent of the runner and of anything the agent (same Windows user) can modify, by one minimal physical action, and only for runs that touch Stripe.

**Key insight (read this before the options).** Whatever verifies the approval runs inside a process the agent controls, on a machine where the same user can read the Stripe restricted key (Credential Manager / DPAPI are readable by every process of that user). A hostile same-user process does not need to defeat the verifier: it can skip the runner, read the key and call Stripe directly. So:

* A signature or hardware assertion that the runner verifies is **policy** against a hostile same-user process. It stops mistakes, a runner that is honest but wrong, and an agent that works through the supplied tooling.
* A **boundary** needs one of: (1) **custody** of the credential outside the agent's reach, released only by the owner's act; or (2) the Stripe call made by a different principal that checks the approval itself.
* The approval kind and the trust anchor below are still worth building: they make every run attributable to a physical act and make forgery detectable. They become a boundary only together with custody (section 5).

## 2. What each option stops against a same-user agent

| | A. Passphrase-sealed Ed25519 (PR #417) | B. Separate low-privilege Windows account holds the key | C. FIDO2/WebAuthn hardware assertion, challenge = envelope hash | D. Windows Hello `KeyCredential` |
|---|---|---|---|---|
| Where the private key lives | AES-GCM file in the user profile, scrypt N=2^17, passphrase typed by owner | file or Hello key owned by account B, ACL denies account A | inside the authenticator, never exported | TPM-backed, non-exportable, bound to the Windows account and device |
| **Forge an approval** | No, unless it learns the passphrase (typing capture, a pty the owner types into) | No, unless it can run as B (needs B's password or admin) | No: needs a touch (and PIN/biometric for UV) on the owner's device | No for a silent signature: every use prompts (PIN/biometric) |
| **Replace the trusted public key** | **Yes**: the trust file is in a directory the same user writes; an agent can register its own key and sign | Only if A is an administrator or can take ownership of B's files | Depends on where the anchor lives (section 3). If the anchor is a file the agent can edit, **yes**: it can enroll a *software* authenticator and pin that key | Same as C: the verifier's copy of the public key is the question |
| **Silently re-register** | Yes (new key + trust file) | No if ACLs hold | Real registration needs a tap; an attacker with a virtual/software authenticator needs only to change the anchor | Creating a Hello key prompts, but an agent can create its own key for its own use |
| Owner effort per envelope | read terms, type 12-hex confirmation + passphrase, in a terminal | switch to account B (or `runas` with B's password), run the sign command | one touch (+ PIN) on a security key; the owner already owns keys | PIN or biometric |
| Blind signing risk (owner cannot see what is signed) | low: terms are printed before the passphrase | low (terms printed) | **high**: a key shows nothing; the terms must be shown by a page or program the agent may control | **high**: the prompt shows only a message string |
| Feasible on Windows 11 from this non-interactive agent session | yes (tested) | needs an admin to create the account; secondary logon from a non-interactive session needs B's credentials | see below | WinRT needs a UI thread / window handle |
| Not verified here | n/a (works) | whether the user is a local administrator (if so, no boundary at all); `runas` behaviour | everything involving a real device (flags, counter, UV, transports) | Hello availability/TPM on the owner's PC |

**What A does and does not stop, exactly.** It stops: the coordinator tooling minting or self-approving an envelope (no signing code is reachable from the runner path), a modified runner (hash-pinned), an envelope edited after approval, and approval reuse for different terms. It does not stop: a same-user process that writes the owner directory (replace the trust file, then sign with its own key), one that drives `owner-sign` in a pseudo-terminal before the owner does, or one that captures the passphrase.

**Feasibility of the tap itself on Windows 11** (all untested here, from documentation and general knowledge):

* `webauthn.dll` `WebAuthNAuthenticatorGetAssertion(HWND, rpId, clientData, options, &assertion)`: the supported path. Needs a window handle on an **interactive desktop**, shows the Windows Security passkey/security-key dialog. It does **not** enforce an origin: the caller builds `clientDataJSON`, so the origin string in the assertion is whatever the caller chose. The origin pin in the verifier is therefore a convention for this path, not a browser guarantee.
* A **localhost page in a real browser** (the repo's `scripts/qa/tw4f/browser/webauthn-e2e.mjs` does this with Chromium's *virtual* authenticator for tests): `navigator.credentials.get` against `http://localhost:<fixed port>`, rpId `localhost`. The browser enforces origin and rpId and shows the tap prompt; the page can also render the envelope terms.
* CTAP over HID via libfido2: Windows restricts raw FIDO HID access to elevated processes (since Windows 10 1903); recent libfido2 builds can route through `webauthn.dll` instead. Not verified.
* Non-interactive services (Task Scheduler "run whether logged on or not") cannot show the dialog.

## 3. Where the trust anchor lives

The anchor is the pinned credential public key (plus rpId, origins, UV requirement, repository and branch), with a SHA-256 fingerprint over all of it (`owner-hw-anchor.json`, validated by `parseAnchor`; any edit that is not re-fingerprinted is refused).

| Candidate | Who can change it | Verdict |
|---|---|---|
| File in the user profile (option A's trust file) | any process of the user | not independent |
| File in the repo working tree | the agent (it edits the checkout) | not independent by itself |
| **File committed to `main` through an owner-approved PR merge, required to be an ancestor of fetched `main`** | the owner merging; the agent cannot push to `main` if GitHub branch protection requires the owner's review (**not verified**: depends on repository settings and the agent's token) | **recommended anchor** |
| Fingerprint enrolled once with a tap and recorded out of band by the owner | the owner's own record | recommended **in addition**: it lets the owner detect a swapped anchor later |
| Anchor pinned by value inside the owner's signed approval | circular: the thing being approved vouches for its own verifier | rejected |

**How it is wired.** A hard-coded constant, `REQUIRE_HARDWARE_FOR_LIVE = true`, lives in `runner.ts` (it is not read from any file, environment variable or argument, and a test asserts that). A **live** run therefore always needs a valid hardware-key approval:

1. The anchor `owner-hw-anchor.json` must exist in the runner folder and parse (every field validated, `requireUV` exactly `true`, fingerprint recomputed). **A missing, renamed, blanked, unparseable or edited anchor BLOCKS the live run (`owner-approval` gate); it never downgrades to another approval kind.** The CLI says so and points at section 7 of this document (enrollment is design only; no tooling exists yet).
2. `owner-anchor-pin`: the envelope carries `hardwareAnchorFingerprintSha256`. It is inside the canonical hash, so the hardware assertion covers it, and the runner requires it to equal the fingerprint of the anchor it loaded. An anchor swapped after the owner approved an envelope cannot approve that envelope.
3. The assertion must verify (section 6). The sign counter is only **recorded** after every other gate has passed, immediately before the run is consumed; a run blocked by a later gate does not burn the approval, and the same approval works on the retry.
4. `commit-on-main`: the pinned commit must be an ancestor of `refs/heads/<branch>` fetched fresh from the **pinned repository URL** in the anchor (not from `.git/config`).
5. Hardware mode uses fixed ledger, ledger-anchor and counter locations.

The passphrase-sealed Ed25519 kind (PR #417) is **not consulted for live runs at all**; it remains for dry/dev tooling. A dev build that wanted it would have to change the constant, which changes the runner folder hash that every signed envelope pins.

**What an agent that edits both the code and the anchor can still do.** It can run dry. It cannot produce a hardware assertion by the **owner's** key. But if it replaces the anchor with a key it controls (a software authenticator), writes its own envelope pinning that anchor and flips the constant, the runner on its machine will verify its own assertion: the only things in the way are `commit-on-main` (the changed runner/anchor are not on the owner-merged branch) and the owner's out-of-band fingerprint. Both are **policy, not a boundary**: `commit-on-main` runs on the agent's machine (git config, environment and TLS are the agent's), and branch protection is a GitHub setting this work could not verify. Dry runs are unaffected by all of this and never need an approval.

**What the `commit-on-main` gate does not prove.** It catches an unmerged or locally edited runner/anchor in ordinary operation and gives audit evidence; it is not a boundary against a hostile same-user process (section 1).

## 4. Recommendation

1. **Approval kind: C**, WebAuthn ES256 with the challenge equal to the envelope's canonical hash, user presence and verification, device-bound credential (BE/BS clear). It reuses the repository's own hardware-key rules (ES256 only, UP+UV, origin and rpId pins, increasing counter, no attestation) and the owner's existing keys. The verifier is implemented and tested (section 6). D is rejected as primary: it is bound to one Windows account and device, gives no cross-device assurance and has the same blind-signing problem. B is a reasonable cheap interim hardening of A, not a destination.
2. **Anchor:** the credential public key committed through a **separate, owner-merged PR** containing only `owner-hw-anchor.json`, plus the owner recording the printed fingerprint out of band.
3. **Boundary (decision for the owner, required for independence against a hostile same-user process):** custody of the Stripe restricted key must follow the approval. Two ways, in order of preference:
   * **F. Run on an environment the agent does not control.** Store the restricted TEST key as a GitHub *environment secret* on an environment with **required reviewers** (the owner, "prevent self-review" on) and run the runner from a workflow. The owner's act is one click in GitHub, authenticated with their security key; GitHub, not the agent, releases the secret. The agent can start the workflow but cannot read the secret or approve. Not verified: whether the repository's plan supports required reviewers for private repositories, and whether the workflow can run `npm ci` plus the proof within limits. A TEST restricted key in GitHub's secret store is a custody decision the owner must accept.
   * **G. Seal the key to the authenticator** with the WebAuthn PRF / CTAP hmac-secret extension: the stored key is encrypted under a secret the device releases only on a touch, so approval and decryption are one act. Not verified: PRF support in the owner's keys and browser, and a `webauthn.dll` path for it.
4. **Blind signing:** whichever page or program asks for the tap must display the approval text, the recomputed hash and the terms; the owner compares the first 12 hex characters with the hash announced in chat. A mistaken tap is bounded by the validated policy (TEST mode, known rule ids only, ceiling 40, at most 5 runs, 30 days, key fingerprint pinned), but the owner should treat a tap as approving exactly what was read.

A variant for later: verify the assertion in the production app against a credential registry bootstrapped by an owner-level migration, as TW-4F price authorization does. That needs `src/` and migration work and is out of scope here.

## 5. Residual risks (none accepted silently)

* Without section 4.3 a hostile same-user process can bypass the runner and use the key directly. The hardware kind then provides attribution and audit, not prevention.
* The counter state file and the ledger are same-user writable: detection only.
* `commit-on-main` depends on GitHub branch protection and on the machine's git/TLS configuration.
* Real-device behaviour is unverified: flags the owner's keys return, whether a counter increments, UV with PIN, NFC/USB transports, the Windows dialog from this session.

## 6. What is implemented

`webauthn.ts` (pure): `verifyAssertion` checks, in order: document shape and kind; envelope hash match; credential id; **canonical** unpadded base64url (re-encoding must reproduce the string: stray trailing bits, impossible lengths, padding and standard-alphabet characters are refused); size bounds; UTF-8 and a **token-level** parse of the top-level `clientDataJSON` keys (escapes such as `\u0063hallenge` are decoded, so a duplicate hidden behind an escape is caught); `type == webauthn.get`; challenge equals the unpadded base64url of the 32 hash bytes; exact origin from the pinned list; `crossOrigin` false and no `topOrigin`; `rpIdHash`; UP; **UV always** (anchor `requireUV` must be `true`; the only waiver is a test-only code parameter that no file, document or CLI option can set); BE and BS clear; AT clear; reserved bits clear; the **ED flag refused** and exactly 37 bytes of authenticator data; a counter that strictly increases (0 stays 0) and **never wraps** (at the 32-bit maximum the credential must be re-enrolled); strict DER ECDSA; and the ES256 signature over `authData || SHA-256(clientDataJSON)`. EdDSA/RS256 are refused, as in the TW-4F protocol. ECDSA signatures are malleable (the high-S twin of a valid signature also verifies); that is harmless here because the signed content is one envelope hash, and the counter state makes a repeat idempotent; a test documents it.

Counter state (`checkAgainstState` / `commit`): `{ last, byEnvelope }`. The same approval is accepted again for later runs of its envelope, a new envelope needs a strictly higher counter, a different assertion for an already approved envelope is refused, a malformed state file fails closed. Recording takes a short lock and writes a unique temp file then renames; if another run advanced the counter between check and commit the commit refuses. The state file is same-user writable: detection, not prevention. Tests use software-generated P-256 vectors only (`__tests__/softauth.ts`).

## 7. Design only: the tap helper and the owner-present enrollment (NOT built, needs separate authorization)

Do not run any of this without the owner present and a separate go-ahead.

1. **Enrollment page** (served from a pristine checkout at the reviewed commit, fixed port, e.g. `http://localhost:47813`): `navigator.credentials.create({ publicKey: { rp: { id: "localhost" }, user: {...}, challenge: <random 32 bytes>, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { authenticatorAttachment: "cross-platform", residentKey: "discouraged", userVerification: "required" }, attestation: "none" } })`. Parse `attestationObject` (CBOR), read credential id and the COSE EC2 key (`-2` = x, `-3` = y, 32 bytes each), check flags `UP+UV`, `BE/BS` clear, write `owner-hw-anchor.json` (with the fingerprint from `anchorFingerprint`) and show the fingerprint. The owner records the fingerprint out of band (phone photo or notes) and the engineer opens an anchor-only PR for the owner to merge. Every envelope written afterwards carries that fingerprint in `hardwareAnchorFingerprintSha256` (inside the hash the tap approves).
2. **Per-envelope page:** loads the envelope file, recomputes the canonical hash itself, shows the approval text, the hash (first 12 hex in large type) and the terms, then calls `navigator.credentials.get({ publicKey: { challenge: <32 hash bytes>, rpId: "localhost", allowCredentials: [{ type: "public-key", id, transports: ["usb", "nfc"] }], userVerification: "required" } })` and writes `<envelope>.hw.json` with `authenticatorData`, `clientDataJSON`, `signature` as unpadded base64url.
3. **Alternative without a browser:** PowerShell P/Invoke of `WebAuthNAuthenticatorGetAssertion` with a visible owner-created window handle, `dwUserVerificationRequirement = REQUIRED`, `dwAuthenticatorAttachment = CROSS_PLATFORM`, a hand-built `clientDataJSON` (so the origin is chosen by the caller: weaker than the browser path), hash algorithm SHA-256; output `pbAuthenticatorData` and `pbSignature` (DER).
4. **First live verification (owner-present, separately authorized):** enroll, produce one assertion over a throw-away envelope hash, run it through `verifyAssertion` offline, record the flags byte and counter in the report, repeat with a second key if one is owned.
