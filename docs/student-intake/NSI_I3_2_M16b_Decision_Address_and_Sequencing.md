# Decision note: guardian address storage and M16b sequencing (P1 of the revision 2 re-review)

Status: **DECIDED: Option B** (owner, 2026-11-26, relayed by the Apps coordinator from the owner's reply "Yes, Option B"). The Option B amendment below is applied to parent section 10.3 item 10 and the Option B follow-on text changes are made in the M16b specification. The decision authorizes local, dark authoring of M16b only: no DEV or PROD SQL apply, no activation, no I3-4 implementation. The separate draft P1-A wording item (M16b spec 10.6) is still pending. The text below is kept as it was put to the owner.

## The question
Parent `NSI_I3_2_DB_Spec.md` section 10.3 item 10 says: "**Dependence on I3-4** (session-bound save and submit, `NSI_I3_1_DB_Spec.md` line 77) is stated, and nothing in M16b is built before it is decided." The M16b spec says I3-4 blocks only **activation**, and its revision 2 introduced an app-encrypted copy of the staff-recorded guardian address (keyed by the pending row) with no stated location, so erase, purge and legal holds did not cover it. Both must be settled: where the address lives, and whether M16b SQL may be authored before I3-4 is implemented.

What the address is needed for: staff record it when they request a guardian invitation; the database holds only its keyed hash (HMAC) and compares it; the code must be sent to exactly the address behind that hash.

## Option A: keep a ciphertext copy on the pending row
| Aspect | Design |
|---|---|
| Storage | `intake_guardian_invitation_requests.recipient_email_ciphertext text` (nullable), token format `<key id>.<iv>.<tag>.<ciphertext>`, AES-256-GCM with the studio, request and pending-row ids as additional authenticated data (the pattern of `src/lib/sms/onboarding/ein.ts`). Written by the staff request RPC; the database never sees plaintext |
| Use | I3-4's session-bound guardian save decrypts it server-side and sets the respondent's `email` and `email_hmac` from it; the guardian never types the address |
| Erase | Covered: erase deletes pending rows (before invitations) |
| Purge | Covered by the pending-row purge. In addition the definer functions clear the column to NULL once the guardian respondent exists, or on supersede or expiry (the restricted purge role has no UPDATE) |
| Legal hold | Covered by `delete_guard` on the row. A held client's cleared ciphertext is not restorable; if the hold must preserve it, clearing has to be skipped while a hold exists (an extra rule to test) |
| Retention | Target: minutes (until the respondent is created, at most the 15-minute request life for unfinalized rows, otherwise the invitation life, 30 days maximum) |
| Keys | A new HKDF subkey of `INTAKE_ROOT_SECRET` (info `intake/recipient-address/v1`), key id stored in the token, previous keys retained until no ciphertext under them remains. `INTAKE_ROOT_SECRET` is not provisioned anywhere |
| For | The guardian does not retype the address; no guessing surface on the address |
| Against | A second store of personal data with its own key, rotation, clearing and hold rules and tests; whoever holds the app secret can read addresses; more code in I3-4 |

## Option B: store no second copy; the guardian types the address and the server verifies it (recommended)
| Aspect | Design |
|---|---|
| Storage | None beyond what already exists: the bound hash on the pending row and invitation, and `intake_respondents.email` plus `email_hmac` once the guardian saves |
| Use | I3-4's session-bound guardian save takes the typed address, normalizes it server-side, computes the HMAC with the key id recorded on the invitation, and **refuses unless it equals the bound hash**; only then is the respondent created with that email and hash. The code is sent to the stored `email` (M16b spec 10.1) |
| Why the P0 stays closed | HMAC equality means the stored address is the string staff recorded; a different address cannot create the respondent, and issue and verify still require equality in the database |
| Erase, purge, hold | Inherited from respondents (erase deletes them; holds protect them); nothing new to cover |
| Retention | The respondent's retention (I6), unchanged |
| Keys | Only the email-HMAC subkey, needed by both options. On rotation the previous key is retained for at least the maximum invitation life (30 days) so a recorded hash can still be matched; otherwise staff re-request |
| For | No new personal-data store, no encryption key, no clearing rules; smaller I3-4 |
| Against | The guardian must type the exact address (a typo gives a generic refusal and a retry); the link holder can test guesses, so refused saves must be rate limited with a database-computed bucket (same mechanism as M16b spec 10.3: 5 per hour, 20 per 24 hours); if staff recorded a wrong address the guardian cannot proceed until staff re-request |

## Recommendation: Option B
It closes the same attack with less stored personal data and no new key or deletion rules, and it removes the open question instead of answering it with new machinery. This **changes my earlier suggestion** (a ciphertext column): that was a fix for coverage, and not storing the copy covers it completely. Choose A only if the guardian typing their own address is unacceptable for the studio experience.

## Exact amendment to parent spec section 10.3 item 10 (apply only the chosen one, after the owner decides)

**If Option A is chosen**, replace item 10 with:
> 10. **Dependence on I3-4** (session-bound guardian save and submit, `NSI_I3_1_DB_Spec.md` line 77). M16b may be authored, reviewed and applied **dark** before I3-4 is implemented, on this recorded interface: the staff-recorded address is kept only as `recipient_email_ciphertext` on the pending request row (AES-256-GCM, HKDF subkey `intake/recipient-address/v1`, studio, request and pending ids as authenticated data), deleted by erase and purge with the row, protected by legal holds, and cleared once the guardian respondent exists or the request is superseded or expired; I3-4 sets the respondent's `email` and `email_hmac` from that value, re-checks the session under the client lock in save and submit, and accepts guardian-audience save and submit only from a guardian session. M16b is **not activated** before I3-4 and email delivery exist and are reviewed.

**If Option B is chosen**, replace item 10 with:
> 10. **Dependence on I3-4** (session-bound guardian save and submit, `NSI_I3_1_DB_Spec.md` line 77). M16b may be authored, reviewed and applied **dark** before I3-4 is implemented, on this recorded interface: no copy of the staff-recorded address is stored beyond its keyed hash; I3-4's guardian save computes the HMAC server-side from the typed address with the invitation's recorded key id, creates the respondent only when it equals the bound hash (refusals are generic and rate limited), re-checks the session under the client lock in save and submit, and accepts guardian-audience save and submit only from a guardian session; the email-HMAC key used by an unexpired invitation is retained for its life. M16b is **not activated** before I3-4 and email delivery exist and are reviewed.

**Keeping the current text** (no authoring until I3-4 is decided) remains possible by deciding nothing; M16b then waits.

## If a choice is made, the follow-on text changes
Under A: M16b spec section 2 gains the column, its update-guard rule and the clearing points; section 4 and 10.4/10.5 gain them in erase, purge and rollback; section 6 gains ciphertext coverage and clearing tests. Under B: remove the "app-encrypted copy" wording from section 9.1, and add the refused-save bucket to the I3-4 requirements. Either way the draft P1-A wording change in M16b spec 10.6 is a separate owner item.
