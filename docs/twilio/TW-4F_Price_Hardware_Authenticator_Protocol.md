# TW-4F price authorization: hardware authenticator compatibility protocol

Status 2026-11. Written for the owner's LATER real-token pass. **Nothing in this repository claims that a real YubiKey, Titan or other hardware token works.** Every automated test uses a software authenticator (P-256 test keys, `webauthnFixture.ts`) or Chromium's virtual authenticator; they prove the database rules, not the devices. Do this protocol on a disposable/non-production database first, with test tokens that are NOT the production keys, and again for each production key during enrolment (the production attest step below).

## What the database requires of every credential (primary, spare and recovery)
| Property | Required value | Where it is checked |
| --- | --- | --- |
| Algorithm | ES256 (COSE -7, ECDSA P-256 with SHA-256). Other algorithms (RS256, EdDSA) are refused because the public key must be a point on P-256 and the signature must verify. | enrolment: key on curve; every assertion: `_tw4price_p256_verify` |
| Flags: user presence (UP, bit 0) | set | every assertion |
| Flags: user verification (UV, bit 2) | set (PIN or biometric on the token) | every assertion |
| Flags: backup eligible (BE, bit 3) and backed up (BS, bit 4) | both clear (a device-bound key). A synced passkey sets BE; it is refused unless the owner's migration sets `allow_backup_eligible = true` (default `false` for every role, including recovery). | every assertion |
| Relying party id hash | SHA-256 of the configured `rp_id` | every assertion |
| Origin | exactly one of the configured `rp_origins`; `crossOrigin` false | every assertion |
| Client data type / challenge | `webauthn.get`; challenge = `sha256(transaction hash || single-use nonce)` | every assertion |
| Sign counter | strictly increasing when the token counts (a counter of 0 stays 0 for tokens that do not count). A decrease or repeat is an integrity failure (possible clone). | every assertion |
| Attestation | **absent by design** (`attestation: "none"`); the flags and the origin are the only evidence of the device class. | documented limit |
| Discoverable credential (resident key) | **not required** (`residentKey: "discouraged"`; the ceremony names the allowed credential ids) | UI / registration options |

## Per-token protocol (repeat for each token model: YubiKey 5 series, Security Key series, Titan, and any other model the owner may buy)
Record the token model, firmware, transport (USB-A, USB-C, NFC) and browser/OS for every row. Use a test database with the ceremony UI, not production.
1. **Registration options.** Register the token through the enrolment dialog (`PriceCredentials.tsx`). Expect: the browser asks for the token and a PIN/biometric. Confirm the public key is P-256 (the dialog sends x and y; a 32-byte x and y).
2. **Possession proof at enrolment.** Submit the enrolment. Expect `status: pending` (never an error mentioning flags). If it is refused, copy the `reason` text exactly; the reasons are the table above (for example "a backup-eligible (synced) credential is not accepted", "user presence and user verification are required").
3. **Flags observed.** From the audit or by reading one assertion's `authenticatorData` byte 32, record the flags value. Expected for a hardware token with PIN/biometric: `0x05` (UP + UV). `0x45` or `0x85` (with AT/ED extension bits) are fine because only bits 0, 2, 3 and 4 are checked. **`0x0d`, `0x1d`, `0x15` mean BE/BS set: the token or the browser is acting as a synced passkey: do not use it.**
4. **Counter behavior.** Sign two ceremonies in a row and record the counter: it must increase (or stay 0 for tokens that never count; some keys do count, some do not). If a token's counter ever repeats or decreases the database refuses and records an `integrity_failure`.
5. **User verification enforced.** Sign with the PIN cleared/refused or biometric declined: the assertion must fail at the token; if a token returns UV unset, the database refuses it. Confirm a token with no PIN set is refused at registration (the browser asks to set one).
6. **Origin and relying party.** Sign from the production origin only. Confirm the same token signing from a different origin or rp id is refused (the wrong-origin case is covered by software tests, but confirm no browser setting rewrites the origin).
7. **Discoverable credentials.** Confirm the ceremony works when the token holds NO resident credential (the allow-list names the credential id) and that no resident key is created (check the token's credential list afterwards). Not required for any role.
8. **Transports.** Test each transport the owner will use. NFC on phones may route through a platform authenticator that syncs: recheck step 3 (flags) on every route.
9. **Production attest step (owner-level, per key, before activation).** For a bootstrap primary and the installed recovery key, run `_tw4price_attest_begin(credential id)`, sign the returned challenge with that exact key, then `_tw4price_attest_finish(...)`. Expect `attested`. The hosted preflight (`scripts/hosted/tw4f/preflight_price_authorization.sql`) FAILS while any active credential has no proof.
10. **Eviction drill (disposable database only).** With the primary, spare and recovery tokens enrolled: confirm the primary cannot revoke the spare, the recovery token can evict the spare (and not the last ordinary key), and each token can retire only itself. Then freeze and thaw with each ordinary token.

## Expected results summary
- PASS requires: every row of the table above satisfied for primary, spare and recovery, flags `0x05` (plus optional extension bits), registration `pending`, attest `attested`, the eviction drill as stated.
- Anything else is a FINDING to report, not a reason to change `allow_backup_eligible`. Changing that setting is an owner decision with its own risk statement (a synced key leaves the device boundary).
- Record the results in the run report with the token models; do not generalize one model's result to others.
