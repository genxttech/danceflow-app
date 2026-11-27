# NSI I3-2 (M16b) implementation notes: two-party guardian invitation and recipient-bound email challenge

Status: **authored locally, dark. Not applied to any hosted database. Local lifecycle, replay and code review results are recorded in `NSI_Resume_Status.md`.** Spec: `NSI_I3_2_M16b_DB_Spec.md` (revision 6, section 13, governs); owner decision: address Option B (2026-11-26). Activation needs I3-4 (session-bound guardian save and submit with the typed-address check and its bucket) and email delivery (T1 to T4, M-0 close-out); neither is started.

## Files
- Migration `20261118106000_nsi_i3_m16b_guardian_challenge.sql` and rollback (generated from the exact M12, M14 and M16a bodies).
- Suite `sql-tests/test_T_nsi_i3_2_m16b_local.sql` (B01 to B14), DEV-safe level-13 suite `sql-tests/test_T_nsi_i3_2_m16b_devsafe.sql` (not run on DEV: no apply is authorized), lifecycle `sql-tests/nsi_i3_2_m16b_lifecycle_local.sh`, race harness `sql-tests/concurrency/nsi_m16b_race_local.sh`.
- Version-aware updates to older suites (table counts 25, function inventory 122, body-marker patterns); replay script and `scripts/qa/scenarios.json` extended with M16b.

## What it adds (level 13, function inventory 113 to 122)
Two tables (`intake_guardian_invitation_requests`, `intake_email_challenges`); recipient hash columns and guardian audience on invitations, guardian audience on sessions; one current guardian respondent per request (unique index, with a forward preflight that refuses and changes nothing). Functions: `intake_guardian_request_invitation` (authenticated, `send`), `intake_guardian_finalize_invitation`, `intake_guardian_challenge_target`, `intake_issue_email_challenge`, `intake_verify_email_challenge` (service role) and four guards. Replaced: `respondents_guard`, `link_valid`, `invitations_update_guard`, `intake_issue_invitation`, `intake_revoke_invitations`, `erase_client_impl`, `purge_expired_impl`, the audit event-type CHECK, `assert_catalog`.

## Implementation choices not fixed by the specification (open to change)
1. `intake_issue_email_challenge` applies 30 per hour to the app-supplied network bucket and 10 per hour to the app-supplied address bucket (both domain-separated in the database, spec revision 6), in addition to the database-computed per-respondent bucket (5 per hour, 20 per day) and the row caps (5 per hour, 10 per day, 50 per invitation).
2. The student-invitation CHECK also forbids `issued_by = 'two_party'`.
3. A partial unique index allows one open challenge per respondent.
4. Outcome words: request `requested:<pending id>:<generation>`, `gate_closed`, `erasure_barrier`, `not_open`, `no_live_target`, `already_submitted`, `recipient_link_set`, `not_minor`; finalize `issued:<generation>`, `invalid`, `already_finalized`, `superseded`, `expired` and the same refusals (a generation mismatch raises 22023, as M12 does); issue `ok`, `invalid`, `limited`, `already_done`, `gate_closed`, `erasure_barrier`; verify adds `superseded`, `expired`, `locked`.
5. Audit actors: staff for the request, system for finalize, guardian for issue and verify. The `count` key is the number of current guardian respondents superseded.

## Stated limits
The database cannot see which address is mailed; the app must send only to the address returned by `intake_guardian_challenge_target` and compute the send-to hash from that exact string. Until I3-4 exists, `intake_save_draft` can write any hash; M16b only guarantees that nothing is issued or verified unless the respondent hash, the send-to hash and the bound recipient are equal. With 8-digit codes the worst case per invitation is 250 guesses. Consumed challenges, and the invitations and finalized requests they reference, are retained until erase (retention period is an I6 item).
