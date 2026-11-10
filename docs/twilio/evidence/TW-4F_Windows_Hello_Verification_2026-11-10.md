# TW-4F real Windows Hello verification (2026-11-10)

Verification of the single-owner device-bound passkey design with a REAL authenticator, run by the owner at the PC through `scripts/qa/tw4f/hello-check/hello-check.mjs` against a disposable local QA database (production policy: synced and backup-eligible credentials refused). Raw result: `TW-4F_Windows_Hello_Check_2026-11-10.json`.

| Property | Result |
|---|---|
| Authenticator | Windows Hello platform authenticator, attachment `platform`, transport `internal`; PC has TPM 2.0 (ready), fingerprint reader and Windows Hello face device |
| Registration flags | UP true, UV true, BE false, BS false (device-bound, not reported as synced) |
| Signatures accepted by the database verifier (`_tw4price_attest_finish` / `_tw4price_check_assertion`) | 4 of 4 |
| User verification on every signature | yes (UP and UV set each time) |
| Signature counter | 1, 2, 3, 4: it COUNTS, so clone detection by counter is active for this credential; stored counter in the database 4 |
| Enrolment proof recorded | yes |
| Synced-passkey exception (`allow_backup_eligible`) | not needed, stayed false |
| Relying party / origin | validated by the database for `localhost` / `http://localhost:5173`; the production relying party (`www.idanceflow.com`) is exercised for the first time at bootstrap |

Notes and limits:
- The first two attempts did not show Windows Hello because the harness did not request the platform authenticator (fixed: `authenticatorAttachment: "platform"`, hint `client-device`, transport `internal`). The embedded app browser may not present Hello; a standalone browser did.
- A credential registered for `localhost` is useless for the real site; the production key is created on https://www.idanceflow.com with the key-setup page and is a different credential.
- No attestation exists: "device-bound" means NOT REPORTED AS SYNCED plus the TPM check in the runbook.
