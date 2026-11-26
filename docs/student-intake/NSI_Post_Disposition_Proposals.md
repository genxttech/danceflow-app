# NSI follow-ups from the owner dispositions of 2026-11-26

Status: **proposals and questions only.** Nothing here is applied, built or approved beyond what `NSI_Resume_Status.md` section 23 records. No hosted SQL, setting, flag or email was changed. Order set by the coordinator: finish M16b first, then I3-4.

## 1. P1A and N1: what is now fixed, and one design question
Fixed by the answers: a submission through a staff-issued student link is **staff-assisted** data entry (`staff_minted = (issued_by = 'staff')`, N1 wording); guardian consent needs **independent guardian participation or verification**, and a staff-created link alone proves nothing. I3-4 stores the provenance on every session write (P1-A rules 1 to 3 and 6).

**Open design question (D-1).** M16b stops the link holder from choosing the address and requires a code, but the address is the one **staff recorded**. A staff member who records an address they control receives both the link (copy-link delivery) and the code (M16b spec section 0, stated residual risk: attributable, not prevented). M16a staff attestation is likewise staff vouching, including `phone_verified` with the guardian not present.

| Option | What it requires | Cost / residual risk |
|---|---|---|
| A | Accept the code to a staff-recorded address as guardian verification, with controls: the recorded address may not equal any staff address of the studio (app check), the staff member who recorded it is shown in the evidence, a second staff role reviews | Cheap; a determined staff member can still use an outside address |
| B (recommended) | Count email verification as guardian consent only when the address has a source independent of the requesting staff member (guardian-provided at an earlier signup, a verified portal link, or a second staff member confirming it against a record), recorded as provenance; otherwise the state stays "awaiting independent verification" | Needs a provenance field and a rule in `fulfillment_state` (I3-4 database slice); some families need an extra step |
| C | Require a verified portal account for guardians | Strongest; contradicts account-free links for guardians |

Related (D-2): does staff attestation (M16a), in particular `phone_verified`, satisfy "independent guardian participation"? Recommendation: `in_person` may record that the guardian was seen, but neither method by itself completes guardian consent; the guardian's own submission is always required, and `phone_verified` never counts alone (consistent with N6).

## 2. N5: reason codes instead of free text
**Impact.** M16a (applied on DEV, 0 attestation rows): column `intake_guardian_attestations.reason text` (1 to 1000 characters) and the `p_reason text` parameter of `intake_attest_guardian`. M16b: **no impact**; it stores and accepts no free text and does not replace that function or table. The M15 staff override (`intake_record_minor_determination`, `p_reason`) and legal-hold reasons are also free text but are not guardian attestations.

**Proposed change (M16a.1, a forward migration, not authored yet):** preflight refuses if any attestation row exists; replace `reason` with `reason_code text not null` limited to `identity_document_checked`, `known_to_studio`, `seen_with_student`, `call_back_to_number_on_file` (list to be confirmed; deliberately no "other"); drop the old function signature and create the new one with `p_reason_code`; the audit may then carry the code (allowlist key `reason_code` exists); marker `nsi-body:m16a.1`, which the M16b guards accept in either order; rollback restores the M16a bytes and is refused once a row exists. Suite, DEV-safe suite, lifecycle, replay and review as usual; DEV apply only by its own request (N2). Recommended question for the same pass: apply the same treatment to the minor-override reason.

## 3. O9 and N4: retention options and legal questions (O9 stays open; nothing is inferred as approved)
The platform policy function returns NULL for every period, so Gate A cannot open. N4: keeping consumed challenges, attestations and invitations "until erase" is **not approved as a default**.

| Data | Built today | Option A | Option B |
|---|---|---|---|
| Sessions, rate-limit counters | purged after 24 hours | keep | keep |
| Unconsumed challenges, unfinalized invitation requests | purged after expiry (challenges 24 hours after the link ends) | keep | keep |
| Invitations | 90 days after expiry unless referenced | keep | shorten to 30 days |
| Consumed challenges, their invitation and finalized request (keyed hashes only) | until erase | delete with the consent evidence period (`evidence_core_days`) | delete 90 days after the request completes or closes; the audit event and the respondent's assurance keep the fact |
| Guardian attestations | until erase | delete with the consent evidence period | as A, with the reason code only in the evidence core |
| Drafts, answers, respondents' name and email, determinations, consent evidence, audit | policy fields exist, values unset | counsel sets each field | counsel sets each field |

**Proposed documented basis for N4 (for counsel to accept or reject):** challenge, invitation and request rows exist only to show how a guardian's address was verified; after the request closes, the same fact is recorded without them, so minimization supports option B for those rows, and option A for attestations because they are the evidence itself. Either option needs a purge change in a later reviewed migration.

**Questions for counsel.** (1) Which records about minors and guardians must be kept, for how long and under which law, per state where studios operate? (2) What legal basis covers a minor's data and a guardian's contact details, and what notice must the guardian receive? (3) Does consent by emailed code (and by staff-observed attestation) meet any verifiable parental consent standard that applies, particularly under 13? (4) What must survive an erasure request, and who decides? (5) When do retention clocks start (signature, last lesson, studio relationship end, age of majority)? (6) How long may unsigned drafts be kept? (7) Audit and security log periods? (8) Legal-hold requirements and release? (9) Studio versus platform roles (controller, processor) and studio-chosen shorter periods? (10) O12: what safeguards and minimization are required before an under-13 routing class may be collected? (11) O5: is 18 correct in every jurisdiction served?

## 4. N8: impact and rollback package for the DEV branching artifacts (nothing changed)
**Read-only evidence, DEV, 2026-11-26 14:25Z (`sb.sh dev-read`).** Schema `supabase_migrations` holds one table, `schema_migrations` (columns `version`, `statements`, `name`), with exactly one row: version `20261014090519`, name `remote_schema`, 7,680 statements, 2,642,331 characters, md5 `bcf3ca8d588330b5557f048ed53057a0`. **Not verified:** the branching setting itself (not readable by SQL), table privileges and owner, objects depending on the schema.

**Steps proposed (each needs the owner's authorization):** (0) export the row and the table definition, privileges and owner to a local file and check the md5; capture the DEV catalog fingerprint; list dependencies; (1) `supabase branches disable`; (2) read-only recheck; (3) `drop schema supabase_migrations cascade` only if step 0 found no dependency outside the schema; (4) postflight: NSI fingerprint unchanged, application smoke on DEV.

**Impact.** Our hosted SQL path (`sb.sh`) does not read or write this history. Any future `supabase db push` or branch creation on DEV would recreate it. PROD is not touched. Parity checks stop needing the exclusion.

**Rollback.** Step 3: recreate the schema and table from the export, reinsert the row, verify the md5, restore privileges. Step 1: re-enable branching in project settings (this creates a new branch record; the old record is not restored, and any cost of branching applies again).

## 5. N3: I3-4 plan outline (authorized as dark draft work after P1A; starts after M16b is finished)
Database first: session-bound draft save and submit for both audiences with session re-check under the client lock; provenance columns (session, invitation, generation, `staff_minted`); the Option B typed-address check and its attempt bucket; revocation of the old service-role signatures in a separate step; the D-1 and D-2 rules in `fulfillment_state`. Specification and independent security review before SQL. Application routes and UI only after the database slice; no email, flag, hosted apply or `INTAKE_ROOT_SECRET` provisioning.
