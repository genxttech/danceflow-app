# NSI I3-2 and I3-3 design: guardian verification, minor determination, decline (planning only, 2026-11-23)

Status: **design only.** No SQL, code, flag, env or email is authorized by this document. Gate A stays closed; no billing gating (pilot grants, staff roles and Gate A only). It builds on M12 (invitations, sessions, rate limits; unapplied pending its final replay) and on the I3 Part A design items A3 to A9. Owner decisions O2 to O5 in `NSI_Resume_Status.md` §8 are inputs; each section says where a decision is still needed.

## 1. Rules inherited from M12 that these slices must not weaken
1. **A link session is never student-authenticated evidence.** Respondent assurance stays `declared_unverified` for anything reached only through a link. Provenance (session id, invitation id, generation, minting staff member) is carried into every response and consent record (P1-A rule).
2. **The guardian path needs more than the link:** the L2 email code (or L3 verified link, or L0 staff attestation). A copy-link never counts as guardian consent.
3. Nothing writes to `client_account_links`, `appointments` or `can_sign_documents`. Wording: "email verified", "declared relationship (self-attested)"; never "verified guardian" or "legal guardian confirmed".
4. Lock order: client lock first, then request, then the new rows. Every new function gets a deterministic lock-order check like C5.
5. Every new RPC gets: role matrix, EXECUTE denied to `anon`/`authenticated` where service-only, mutation probes, DEV-safe level check, rollback refused once data exists.

## 2. I3-3 first (it unblocks everything minor-related): minor determination and decline

Today (M5) an owner or admin records a minor determination by hand, and `fulfillment_state` treats "no determination" as an adult only after a P2-4 guard refuses student submission without one. A3 and A5 replace that with a service path.

**I3-3 scope (one migration, now M15; M14 is the hold-semantics fix, see `NSI_M14_Hold_Semantics_Spec.md`; decline moved to I3-2, see `NSI_I3_3_DB_Spec.md`):**
- **Determination service path (A5).** `intake_record_minor_determination_service(request, basis, ...)` for `service_role` (called by the app after it reads the client's birthday through an existing server path) and the staff path stays for corrections. Bases: `birthday`, `declared`, `staff`. A determination is append-only; the latest wins; the student session cannot submit before one exists (already enforced).
- **Minor threshold.** The studio setting (default 18) is read inside the function; the "pending legal review" note stays attached in the staff UI until cleared (owner decision O5).
- **Guardian decline (A6).** New terminal request state `declined`, reachable only from `invited` or `in_progress` through a guardian-session RPC after L2/L3 verification; excluded from completion reuse and from the evaluator's `already_completed`; the decline evidence (who, how verified, when, text version) is recorded without completing anything; a new invitation means a new request (owner decision O4, recommendation terminal).
- **N1 outcome alignment (A9).** Student and guardian paths use the same event and outcome vocabulary.
- Tests: determination bases and precedence, threshold edge (the day before and the day of the 18th birthday), decline from each allowed state and refused from each other, decline is not completion, evaluator and `fulfillment_state` treat `declined` as not complete, N1 vocabulary, rollback refused once a declined request exists.

## 3. I3-2: guardian email challenge, attestation, role matrix

**Tables (M13 or M15, level 11):**
- `intake_email_challenges` (id, studio, request, respondent, guardian email hash and masked form, code derivation reference = the challenge id only, `expires_at` (10 minutes), `attempts` (max 5), `consumed_at`, `created_by` (`session` or `staff`)). The code is derived from the challenge id and the signing secret at send time (TS `deriveEmailCode`), never stored. Retention: expired challenges purged with the M12 purge pattern (non-waiting lock; M13 hardening first).
- Staff attestation event rows in the existing consent-evidence table (no new store): reason, method (`in_person`, `phone_verified`), guardian name and relationship, immutable, role-gated.

**Functions:**
- `intake_issue_email_challenge(session_hash, guardian_email)` (service): the guardian email must differ from the student's; rate limits per request, email and IP (M12 buckets); returns the challenge id for the outbox row (I4). No email is sent in I3.
- `intake_verify_email_challenge(session_hash, challenge_id, code_hash)` (service): constant-attempt accounting, 5 attempts, 10 minutes; on success writes `email_code_verified` assurance on the guardian respondent through the **only** path allowed to (the respondent guard is changed so `email_code_verified` and `staff_attested` require a matching verification record: A3).
- `intake_attest_guardian(studio, request, ...)` (authenticated, `assert_staff` capability `attest`, owner/admin/front desk per spec 4.1): audited, immutable, labelled staff-attested.
- Role matrix (owner decision O2): who may create guardian invitations and choose recipients; recommendation owner, admin, front desk; instructors none.

**Respondent guard (A3, reverses §9.8 item 1).** Today assurance values are trusted from the caller inside the definer functions; after this slice `email_code_verified`, `staff_attested` and `link_verified` can only be set by the functions above, and each requires its evidence row.

**Verified identity vs guardianship (A4).** Assurance records how an email or a presence was verified, never legal guardianship; designation stays in `intake_guardian_designations` referencing a verified link; the UI says "declared relationship". Stale assurance after a link disconnect is revalidated at read time.

## 4. Sequence and dependencies
| Order | Slice | Needs | Blocks |
|---|---|---|---|
| 1 | M13 purge hardening (carry-forward H1-H5) | M12 on DEV | any purge cron, I4 |
| 2 | M14 hold semantics and purge liveness (safety item, P2-A..D) | M13 on DEV | purge cron, I4, Gate A, I3-3 implementation |
| 3 | I3-3 (M15) minor determination service path (decline and N1 moved to I3-2) | O5 | I3-2 guardian path, I3-4 minor flow |
| 4 | I3-2 (M16) challenges, attestation, decline, respondent guard, role matrix | O2, O4, I3-3, M12 | I3-4 guardian UI, I4 email codes |
| 5 | I3-4 app: session-hash forms of draft save and submit (revoking the old signatures), provenance in evidence, the `/intake` pages | P1-A rule, M12 to M15 | I4 |
Each SQL slice follows the M10 to M12 pattern: generator-built migration and exact-fingerprint rollback, local lifecycle with mutation probes, independent review, DEV apply by `sb.sh` with the standing conditions, then the full-chain replay.

## 5. Not decided here
- Whether staff-assisted entry through a staff-minted link is stored as a distinct response source (recommended: `staff_minted` marker on the response so it can never count as student evidence).
- Guardian invitation expiry and reminder timing (spec 22.3 defaults apply: omit the student's name, reminders only for incomplete guardian obligations).
- Everything about email delivery, which stays behind T1 to T4 and the M-0 close-out.
