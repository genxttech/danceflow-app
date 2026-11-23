# NSI I3-2 (M16) database specification: guardian challenge, attestation, decline, respondent guard (draft revision 1, for review before any migration)

Status: **specification only.** No SQL, code, flag, env or email is authorized. Gate A stays closed; no billing gating (pilot grants, staff roles and Gate A only). Written against the final M14 bytes (migration sha256 `ae6bbf0b0d05bd46aed96eb284d0eb8ca53bf917f08af39692fa9415b7cef2d2`, fingerprint `be5a715adedad4197649593d23c6ce09|770`) and the M15 specification (`NSI_I3_3_DB_Spec.md` revision 3). Sequence: M14 (DEV after review), M15, **M16 = this slice**. Owner-decision labels: **[recommended, pending owner decision]** is a draft default, silence is not approval. Inputs: `NSI_I3_2_I3_3_Design.md` section 3, `NSI_P1A_Staff_Minted_Links.md`.

## 1. Scope
1. **Guardian email challenge** (A3): issue and verify a 6-digit code bound to a challenge row; the only path that may set `email_code_verified`.
2. **Staff guardian attestation** (L0): immutable, role-gated, labelled staff-attested.
3. **Two-party guardian invitation issue** (P1-A Option C): staff request without a hash, app-server finalize with the hash.
4. **Guardian decline** (A6, moved from I3-3): terminal request state `declined`.
5. **Respondent guard** (A3): `email_code_verified`, `staff_attested`, `link_verified` assurance values can only be set by the functions above, each requiring its evidence row.
6. **N1 outcome alignment** (A9): one vocabulary for student and guardian outcomes.
Out of scope: any email send (T1 to T4, M-0 close-out), UI, outbox, collection.

## 2. Principles (inherited, none weakened)
1. A link session is never authenticated evidence; assurance stays `declared_unverified` through a link. A copy of a link never counts as guardian consent.
2. Wording: "email verified", "declared relationship (self-attested)"; never "verified guardian". Nothing writes `client_account_links`, `appointments` or `can_sign_documents`.
3. **Lock order** for every writer: read the session without locks, `lock_client` (inherits the M14 READ COMMITTED guard, 55000 otherwise), `request FOR UPDATE`, challenge/designation rows, then **re-check** the session (not revoked, not expired, `link_valid`) after the lock.
4. **M14 interaction:** new tables are keyed so `delete_guard` resolves a client subject (through request id) and fails closed otherwise; no new function consults holds (holds block deletion only); every new audit event carries `client_ref`; challenges and decline evidence are deleted by erase and purge through the existing paths; hold-protected clients keep them. Purge uses the M14 pattern (pre-filter with `client_has_active_hold`, try-locks, ordered deletes).
5. Each new RPC: role matrix, `REVOKE ALL FROM public, anon, authenticated, service_role, intake_destructive` then explicit grants, mutation probes, a DEV-safe level check, a rollback refused once data exists.

## 3. Tables (level 12; all RLS enabled, no direct DML grants)
- `intake_email_challenges`: `id uuid`, `studio_id`, `request_id`, `respondent_id`, `guardian_email_hash` (HMAC, never the address), `guardian_email_masked` (for staff display only, e.g. `a***@d***.com`), `expires_at` (issue + 10 minutes), `attempts int` (max 5), `consumed_at`, `created_by` (`session` or `staff`), `created_at`. The code is derived by the app from the challenge id and the signing secret at send time (TS `deriveEmailCode`) and **never stored**; the database stores only a hash of the correct code supplied by the app at issue time (`code_hash`, HMAC with the same secret) so verification compares hashes. Retention: expired and consumed challenges are purged on the M14 pattern.
- `intake_guardian_invitation_requests` (two-party issue): `id`, `studio_id`, `request_id`, `requested_by` (staff user), `requested_at`, `expires_at` (15 minutes), `finalized_invitation_id`, `finalized_at`. A request with no finalize expires and is purged.
- `intake_guardian_attestations`: immutable (update/delete trigger refuses; deletion only through erase/purge with the M14 guard): `request_id`, `respondent_id`, `method` (`in_person`, `phone_verified`), `guardian_name_hash` or text per the evidence rules, `relationship`, `attested_by`, `reason`, `attested_at`.
- `intake_requests.status` gains `declined` (terminal): the request status check constraint, the evaluator's `already_completed`/reuse rules, and `fulfillment_state` treat `declined` as not complete and not reusable. A new obligation means a new request.
Decline evidence rides the existing consent-evidence store: who (assurance level and how verified), when, text version; nothing is completed.

## 4. Functions (service_role unless stated; SECURITY DEFINER, pinned search path)
| Function | Role | Behavior |
|---|---|---|
| `intake_guardian_request_invitation(p_studio_id, p_request_id, p_respondent_id)` | authenticated, `assert_staff` capability `guardian_invite` (owner/admin/front desk **[recommended, pending owner decision O2]**; instructors none) | Creates a pending request row, no token, returns the request id. One open request per request id |
| `intake_guardian_finalize_invitation(p_request_id, p_token_hash, p_expected_generation)` | service_role only | Re-checks the pending row not expired and the minor determination says `minor`; issues the invitation through the existing M12 issuer (audience `guardian`); marks the row finalized; audit `guardian_invitation_issued` with the staff user, `staff_minted` true by construction |
| `intake_issue_email_challenge(p_session_hash, p_guardian_email_hash, p_masked, p_code_hash)` | service_role | Audience must be `guardian`. The guardian email must differ from the student's (compared by hash). Rate limits per request, per email hash and per IP bucket (M12 buckets). Returns the challenge id for the outbox row (I4). No email is sent here |
| `intake_verify_email_challenge(p_session_hash, p_challenge_id, p_code_hash)` | service_role | Locked read-modify-write: attempts incremented first (constant-attempt accounting), refused after 5 or after expiry; on a match writes `email_code_verified` to the respondent through the only permitted path and consumes the challenge; audit `guardian_email_verified` (no email, no code) |
| `intake_attest_guardian(p_studio_id, p_request_id, p_respondent_id, p_method, p_relationship, p_reason)` | authenticated, `assert_staff('guardian_attest')` (owner/admin/front desk) | Writes the immutable attestation and sets `staff_attested`; mandatory reason; audit with the actor |
| `intake_guardian_decline(p_session_hash, p_reason_code)` | service_role | Requires a guardian session with `email_code_verified` or `link_verified` or a prior attestation; allowed from `invited` or `in_progress` only; moves the request to `declined`, revokes its sessions and invitations, records decline evidence, audit `guardian_declined`. Terminal **[recommended, pending owner decision O4]** |
| `intake_set_respondent_assurance(...)` | none (internal) | The single internal setter used by verify and attest; the table trigger refuses any direct change of the three protected values |

## 5. Outcome vocabulary (N1 / A9)
Student and guardian functions return the same small word set: `ok`, `invalid`, `expired`, `revoked`, `locked`, `limited`, `not_open`, `gate_closed`, `erasure_barrier`, `already_done`, `declined`. Error classes keep SQLSTATEs (22023 invalid arguments, 42501 privileges, 55P03 lock refused, 55000 isolation). No outcome reveals whether an email, a challenge or a person exists beyond what the caller supplied.

## 6. Privileges and catalog
Level 12; markers `nsi-body:m16`; expected fingerprint computed by the generator run. `anon` and `authenticated` get no table privileges; staff functions are the only authenticated entry points. Rollback restores the M15 `assert_catalog`, is **refused once any challenge, attestation, finalize request or `declined` request exists**, and checks the M15 fingerprint. Replay guard as in the M15 spec section 9.6.

## 7. Tests (new suite, lifecycle, DEV-safe, concurrency)
- **Challenge:** code correct, wrong, expired, fifth wrong attempt locks, attempts counted before the comparison, a consumed challenge cannot be reused, the student email is refused as the guardian email, rate limits per request/email/IP, nothing personal in any return, audit row or error.
- **Respondent guard:** direct update of the three assurance values by every role is refused; only verify and attest produce them; each requires its evidence row; assurance after a link disconnect is revalidated at read time (A4).
- **Attestation:** role matrix (owner/admin/front desk yes; instructor, other studio, anon no), reason mandatory, immutability, erase and purge remove it, a hold keeps it.
- **Two-party issue:** staff request yields no usable link; finalize by a non-service role refused; finalize after expiry refused; finalize when the determination is not `minor` refused; the hash never appears in a staff-readable row; one open request per request.
- **Decline:** allowed from `invited` and `in_progress`, refused from every other state, requires verification or attestation, terminal, not completion, excluded from reuse and `already_completed`, sessions and invitations revoked, `fulfillment_state` correct, rollback refused once one exists.
- **Lock order and races:** verify vs decline, finalize vs revoke, attest vs decline, decline vs erase (erase first: `erasure_barrier`; decline first: the evidence is erased with the client), each with a deterministic lock-order check and a probe removing `lock_client`; isolation guard under REPEATABLE READ (55000).
- **M14 interaction:** hold-protected client keeps challenges/attestations through an erase attempt (refused) and a purge (skipped); `delete_guard` resolves each new table's subject (a probe that breaks resolution fails closed 42501); audit rows carry `client_ref`.
- **Mutation probes:** drop the attempt limit, drop attempts-before-compare, drop the expiry check, drop the student-email rule, drop the respondent trigger, drop the finalize role check, drop the one-open-request rule, drop `lock_client` in each writer, drop `client_ref` on audit.
- DEV-safe level-12 suite, rollback and replay-guard checks, full-chain replay on the final bytes.

## 8. Owner decisions touched (all pending; defaults above are drafts)
O2 (who may invite and attest guardians: owner, admin, front desk), O4 (decline terminal). The P1-A rules in `NSI_P1A_Staff_Minted_Links.md` are engineering rules, not owner decisions; only O11 and O5b remain open on the minor/evidence path. Everything about email delivery stays behind T1 to T4 and the M-0 close-out.

## 9. What the reviewer is asked to check
That two-party issue is only required for guardians and that the finalize-time re-check of the determination is enough; that storing a code hash (not the code) is acceptable; that `declined` as a terminal state interacts correctly with the evaluator and `fulfillment_state`; and that the M14 interactions in section 2.4 cover erase, purge and holds for every new table.
