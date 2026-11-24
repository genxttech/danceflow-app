# OD-12 design: independent verification of paper-ballot transcription

Status: **design only (docs only). Nothing is implemented, applied, merged, deployed or activated.**
Owner decision: OD-12, 2026-11-23, Option A (mandatory independent verification for ALL Competition OS events), as relayed by the Competition coordinator.
Base: stacked on the OD-11 design PR (#843, branch `claude/od11-ballot-corrections`), which is on `origin/release/website-embeds` at `49dbaee1b`.
Governance: [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md); register entries `OD12-*`. Shares **one version and audit model** with
[OD-11](OD-11-ballot-corrections-design.md): read that document's section 12 (normative) first.

**Bottom line.**
1. Today one scorer (or a manager) transcribes a paper ballot and it counts immediately. No second person ever compares it to the paper original (section 3).
2. Design: a **verification record** per paper ballot **version**, written by a different authorized person, blocks round lock, calculation, approval and publication until every
   paper ballot's current version is verified (or its discrepancy is resolved through OD-11). Only ids, counts and reason codes are ever reported.
3. Body roles: WSDC = Chief Judge or a scoring-team member approved by the Chief Judge; NDCA = the Chairman's transcription duty with original sheets restricted; **a generic scorer or manager is never assumed to qualify** for NDCA/WSDC; Studio/Custom and silent rules = DanceFlow policy.
4. A discrepancy never edits the ballot: it routes to OD-11 class (a) (judge-confirmed). Directly authenticated judge submissions are a different thing and need no verification.
5. Implementation is not started; dependencies and negative tests are in sections 5-6; owner questions in section 9.

---

## 1. Owner requirements (traceability)

| # | Requirement | Where |
|---|---|---|
| 1 | Every paper ballot verified by a DIFFERENT authorized individual against the paper original before it can contribute to finalized or published results | 4.1, 4.4 |
| 2 | WSDC: Chief Judge or scoring-team member approved by the Chief Judge | 4.3 |
| 3 | NDCA: Chairman's transcription duty, restricted access to originals; generic scorer/manager not assumed | 4.3 |
| 4 | Studio/Custom and silent rules: DanceFlow policy; UCWDC: say what is found | 2, 4.3 |
| 5 | Block finalization while unverified; report WHICH entries need attention without exposing ballot information | 4.4, 4.6 |
| 6 | Record transcriber, verifier, time, source ballot version, discrepancies/corrections | 4.2 |
| 7 | Alteration of actual marks uses OD-11's judge-confirmed process; preserve versions | 4.5 |
| 8 | Organizer retention checklist naming NDCA 30 days; never claim DanceFlow retains paper or deletes evidence | 4.7 |
| 9 | OD-10 confidentiality and OD-06 designations; no generic manager access by default | 4.3, 4.6 |
| 10 | Digital judge submissions separate from paper verification | 4.8 |

## 2. Rule evidence (re-read in the pinned PDFs on 2026-11-23; SHA-256 verified against the source registry)

| Rule | What it says (own words) | What it does not say |
|---|---|---|
| WSDC 3.4.9.b.i (Registry Event Rules 2026.1C, PDF p.20) | Transfer of judges' paper score sheet results into the computerized system must be audited by the Chief Judge and/or a scoring team approved by the Chief Judge, i.e. verified by a person other than the score person inputting. | Does not say when the audit happens or what the record contains. Covers all WSDC Jack and Jill contests (3.4.9). |
| NDCA IV.C item 5 (June 2026 Rule Book, PDF p.34, printed p.27) | The Chairman inspects marks after each heat and verifies they were correctly transcribed. | Does not provide for a scorer or manager to substitute (silent); does not define the record. |
| NDCA III.D.16 (PDF p.28) | Only the Chairman and the Scrutineer have direct access to the original marking sheets until the end of the competition. | A generic DanceFlow scorer is not stated to be the Scrutineer. |
| NDCA III.E item 2 (PDF p.32) | Organizers keep the original adjudicators' score sheets for at least 30 days after the close of the event, for a discrepancy in the scrutineers' final markings. | Not a deletion trigger. The 30 days is a minimum retention, not a verification or correction deadline. |
| NDCA IV.C items 6-7, IV.B.6, IV.D.1.c(10) | See OD-11 section 2. | |
| UCWDC Couples and ProPro/ProAm (v1-26-2026) | **No paper-ballot transcription or verification rule found.** Searches for score sheet, mark sheet, paper, transcri-, verif-, audit found nothing relevant (II.N finality and Judge Review Board text only, see OD07-UCWDC-0001 on PR 838). | The Judge Certification Code of Conduct was not provided and may contain one. **Unconfirmed.** |
| UCWDC Scoring Format v16.9b | In-contest tie-proof checks only ("a scoring error has occurred"); nothing on paper transcription. | |

Classification: WSDC verification is a **body requirement**; NDCA transcription check is a **body requirement on the Chairman** (the software supports the Chairman's duty, it does
not perform or replace it); everything else is **DanceFlow policy**, including the mandatory second-person verification for Studio/Custom, UCWDC and `other` events, the block at lock, the
hash fingerprint and the checklist acknowledgement. No governing body is cited for those.

## 3. What the code does today (traced on the base branch; paths in `src/lib/supabase/migrations/`)

- `enter_competition_paper_ballot` (`20270102090000_competition_e2_ballots.sql` ~L1009): manager or assigned scorer enters a ballot for any active judge on the panel; calls `_compe2_insert_ballot` with `source = 'scorer_paper'`, `submitted_by = actor`, `entered_by_official_id` = the scorer's officials row (**null when a manager enters it**).
- No second-person check, no record that a paper original exists, no discrepancy record. The transcriber's marks count immediately; `lock_competition_round_ballots` and `_compe2_round_blockers` (L721) check only completeness.
- `calculate_competition_round` (F2 `20270114090000...` L874; blockers read at L935) refuses when `_compe2_round_blockers` is non-empty; `approve_competition_round_result` (L1020) and `publish_competition_round_result` (F3 `20270122090000...` L352) have no paper check.
- Ballot read policies expose marks to all managers and assigned scorers (OD-10 is changing that). Audit rows carry an unsalted md5 fingerprint (see OD-11 section 12 finding 3).
- No retention or paper-original concept exists anywhere.

## 4. Design

### 4.1 Rule

A ballot needs verification iff its **current version** (the one nothing supersedes) has `source = 'scorer_paper'`. Verification belongs to **(ballot id, version)**, never to a judge or a heat in general: a new
version (OD-11) is new unverified input. A round with any unverified current paper version cannot be locked, calculated, approved or published.

### 4.2 Verification record (insert-only; one coherent audit model with OD-11)

`event_competition_paper_verifications`: `id`, `event_id`, `round_id`, `heat_id` null, `official_id`, `ballot_id`, `ballot_version`, `transcriber_user_id`, `verifier_user_id`, `verifier_basis` (`wsdc_chief_judge`, `wsdc_scoring_team`, `ndca_chairman`, `designated_verifier`, `dance_flow_policy`), `outcome` (`verified_match` / `discrepancy`), `discrepancy_codes text[]` and `discrepancy_count` (codes such as `mark_differs`, `missing_entry`, `extra_entry`, `wrong_heat`, `illegible_original`; **never mark values**), `paper_original_ref` (retention locator, no marks), `marks_hash` (the OD-11 canonical SHA-256 with a server nonce, so the log cannot be brute-forced), `verified_at` (server time), `request_id` unique.

- **Transcriber** for version 1 is `ballots.submitted_by` (plus the entering official's user); for version >= 2 applied through OD-11 class (a) it is the **proposer** of the staged marks (the applier only presses apply, supplies no marks).
- The verifier must differ from every one of those identities (compared by `auth.uid()`, across any officials rows) and from the adjudicator whose card it is (a judge verifying their own card is a different, OD-11 judge confirmation, not an independent verification; Q2).
- `discrepancy` is **terminal for that version**: nobody can then "shop" for a friendlier verifier. The ballot becomes verified only by a **new version** created through OD-11 class (a), whose reviewer step is itself written as a verification row (same table, same rules), plus the judge's confirmation.
- This table and the OD-11 proposal/confirmation tables are the one audit trail; events are written to the shared OD-11 events table with kinds `paper_verified`, `paper_discrepancy`.

### 4.3 Who may verify (role mapping; nothing is assumed from DanceFlow roles)

| Event body | Authorized verifier | Notes |
|---|---|---|
| WSDC | The designated Chief Judge (OD-06 designations, PR #834 section 6A) or a **scoring-team member the Chief Judge approved** (a new designation kind `scoring_team_member`, an addition requested of OD-06: designation row carries the approving Chief Judge) | Never the score person who input the data (3.4.9.b.i). Never the Event Owner/Director or their family (3.4.1, 3.4.1.a). WSDC 3.4.3 separates Chief Judge from scoring/tabulation: a Chief Judge verifying is an audit duty, not scoring; Whether a Chief Judge verifying is an audit duty rather than scoring is an interpretation: PR 834 6A.8 lists 3.4.9.b.i as out of scope, so this design is its first design (Q6, Q8). |
| NDCA | The event's `chair` official as Chairman; additional persons only when the owner approves a Chairman delegation (Q3) | The Scrutineer has no DanceFlow role; **not assumed**. Access to original sheets (III.D.16) limits who can physically compare; the software records the Chairman's act, it does not perform it. A generic scorer or manager never qualifies. NDCA-declared events fail closed until the J-01 mapping is approved (as OD-07/OD-11). |
| UCWDC, Studio/Custom, `other` (silent or no body) | **DanceFlow policy:** a person with a verifier designation or a scorer/chair different from the transcriber and the adjudicator | A manager is not a verifier by default (OD-10); a manager may be designated verifier at event level by an explicit, audited designation (Q4). |

All verifiers must pass: verified email, active status, the OD-05 conflict checks for that round (not a competitor/relative of entries in the contest, per OD-05), OD-06 designations where the event is WSDC-declared.

### 4.4 Blocking (requirement 5)

- `_compe2_round_blockers` (E2 L721) gains `COMP_PAPER_UNVERIFIED`: one blocker item **per ballot** with `ballot_id`, `heat_id`, `judge_letter`, `version` and a reason code (`unverified`, `discrepancy_open`, `stale_version`), never marks. That function already feeds the lock RPC (E2 L769/817) and `calculate_competition_round` (F2 L935), so lock and calculation stop; the status board shows it.
- Defense in depth: `approve_competition_round_result` and `publish_competition_round_result` re-check the same predicate and refuse with the same code (a corrected ballot under OD-11 creates a new unverified version after a calculation exists).
- No override, no waiver, no "approve with acknowledgement". The only exits are verification, or, for a `discrepancy`, an OD-11 class (a) replacement that the judge confirms and a verifier verifies.
- Rounds with **no** paper ballots are unaffected; so are ballots whose current version is `judge_web`.

### 4.5 Discrepancy and correction (requirement 7)

A discrepancy writes the verification row and an event; it **does not change the ballot**. The transcriber (or another scorer) opens an OD-11 `transcription_error` proposal from the paper original; an independent verifier (not the proposer) reviews it against the paper (that review **is** the new version's verification row); the chair authorizes; the **original adjudicator confirms** (OD-11 level-2 authentication); then apply. Original, replacement versions, reasons, identities and timestamps are preserved. If the judge never confirms, OD-11's hold applies and the round stays blocked (OD-11 Q2).

### 4.6 What the report shows, and to whom (requirement 5, 9)

`competition_round_paper_verification_status(round_id)` returns counts (`needs_verification`, `verified`, `discrepancy_open`) and per-ballot rows `{ballot_id, heat label, judge letter, version, state_code}`; no marks, no transcriber free text, no nonce. Readers: manager, chair and the round's scorers (they already know the heat/judge identities); entrants and public: nothing. A verifier sees the **ballot's marks** only through the OD-10 audited retrieval RPC with purpose `paper_verification` (they need them to compare), restricted to OD-10-authorized readers: **no generic manager access**. Verification tables have no `SELECT` grants; reads only through RPCs.

### 4.7 Organizer retention checklist (requirement 8)

An organizer-facing checklist shown on the round and event pages and stored as acknowledgements (`event_competition_paper_retention_acks`: `event_id`, optional `round_id`, `acknowledged_by`, `acknowledged_at`, `retain_until` date, `storage_note` with no marks; insert-only). Items: (1) keep the **original signed** judges' sheets for every round that used paper; (2) NDCA-declared events: organizers are required to keep them for at least **30 days after the close of the event** (III.E item 2); other bodies: no period found, organizer policy, organizer sets the date; (3) restrict access to the originals (III.D.16 for NDCA); (4) record the retention locator used in `paper_original_ref`; (5) do not destroy while any OD-11 proposal, hold or challenge is open. Copy states: **DanceFlow does not store, scan or retain paper originals and never deletes evidence automatically**; the acknowledgement is the organizer's statement, not proof. Whether acknowledgement is a blocker (default: **advisory**, because DanceFlow cannot verify physical retention) is Q5. OD-04's no-automatic-deletion rule is unaffected.

### 4.8 Digital judge submissions stay separate (requirement 10)

`judge_web` ballots are authenticated acts of the adjudicator; they need no transcription verification and never appear in the paper blocker. A paper ballot later replaced by the judge's own authenticated submission through OD-11 (class b) carries `source = 'judge_web'` and the OD-11 confirmation; the paper verification of the older version stays as history. Mixed rounds (some judges on paper, some digital) are supported.

## 5. Exact SQL dependencies (design level; nothing written)

| Object | Change |
|---|---|
| New tables (all with `event_id`, insert-only, history triggers, RLS on, **no grants**) | `event_competition_paper_verifications`, `event_competition_paper_retention_acks` |
| New RPCs (security definer, pinned `search_path`, request-id idempotent, `authenticated`) | `verify_paper_ballot(ballot_id, outcome, discrepancy_codes, paper_original_ref, request_id)`, `competition_round_paper_verification_status(round_id)`, `acknowledge_paper_retention(event_id, round_id, retain_until, note, request_id)` |
| Helpers (no grants) | `_cf12_needs_verification(ballot_id)`, `_cf12_may_verify(ballot_id)` (role basis + separation + OD-05/06), `_cf12_round_unverified(round_id)` returning ids/codes |
| `_compe2_round_blockers(uuid)` (E2 L721) | Pinned redefinition adding the `COMP_PAPER_UNVERIFIED` items; the same function is read by lock (E2) and calculate (F2), so no separate change there. Pin md5 from the applied chain. |
| `approve_competition_round_result` (F2 L1020), `publish_competition_round_result` (F3 L352) | Pinned one-line anchor calling `_cf12_round_unverified`; refuse with `COMP_PAPER_UNVERIFIED`. |
| `enter_competition_paper_ballot` (E2 ~L1009) | Optional parameter `p_paper_original_ref` (new overload, a declared signature change) so the transcriber records the locator at entry; first entries are unverified by definition. |
| OD-11 objects | `review_ballot_correction` (class a) also writes the verification row; the OD-11 events kinds list gains `paper_verified`, `paper_discrepancy`. |
| Backstop | A deferred constraint trigger on `event_competition_paper_verifications`: verifier differs from `ballots.submitted_by`, the entering official's user, the OD-11 proposer, and the adjudicator; the ballot version is current when the row is written. |
| OD-04 | New tables added to `_compod04_evidence_tables()` (pinned redefinition; each table has `event_id`). |
| OD-10 | Reuse its reader predicate and audited retrieval RPC; the status RPC returns no marks. |
| OD-06 | Request: a `scoring_team_member` designation kind (approved-by Chief Judge) on `event_competition_role_designations`. |
| `ballots` table | **No column added.** |
| Rollback | Drops in reverse; refuses while any verification or acknowledgement row exists; restores the E2/F2/F3 function text first (md5-checked). |

Migration block (proposed, not reserved): `20270223090000` (tables, RLS, triggers), `20270223091000` (RPCs and helpers), `20270223092000` (blocker redefinitions, depends on OD-11 s0-s3). Existing claims: OD-04 `20270219...`; OD-05/06 `20270220...`; OD-07 `20270221...`; OD-11 `20270222090000-093000`. This **supersedes OD-11 section 9's** line that an OD-12 migration touching ballots must land first: this design adds no column to `event_competition_ballots`, so OD-12 lands **after** OD-11 s0-s3 and OD-05/06; hard order: OD-04, OD-05/06, OD-10, OD-11, OD-12.

## 6. Negative-test requirements (SQL suite on an isolated Postgres under the heavy lock when built; none run now)

1. Transcriber verifies own ballot: refused (including a manager who entered it with null `entered_by_official_id`, one user holding two officials rows (for example scorer and chair); one human with two separate accounts cannot be detected (residual), and the OD-11 proposer for a replacement version).
2. The adjudicator verifies their own paper card as "independent verification": refused.
3. Generic manager and generic scorer on WSDC/NDCA events: refused; WSDC Event Owner/Director and their family (3.4.1/3.4.1.a): refused; the WSDC score person who input the data: refused; Chief Judge and an approved scoring-team member: allowed (positive controls); an unapproved designation: refused.
4. Round lock, calculation, approval and publication each refused while any current paper version is unverified or in `discrepancy`; allowed when only `judge_web` ballots exist; lock allowed after verification; a new OD-11 version re-blocks.
5. `discrepancy` is terminal for that version: a second verifier cannot flip it; only a new version through OD-11 can clear it; replay (same `request_id`) is idempotent, a different request on the same version is refused.
6. Status report: contains no mark values, free text or nonce (canary mark searched in the RPC output, in `competition_audit_log` and in the new tables' readable output); a non-authorized manager gets ids and codes only; entrants/anon get nothing; direct `SELECT` on every new table is denied to authenticated, anon and service_role.
7. Verification of a stale version (superseded meanwhile) refused; verification of a `judge_web` ballot refused (not applicable).
8. Retention acknowledgement: insert-only, no marks accepted in `storage_note` (length and format checks only; app copy warns), no code path deletes or expires anything; `retain_until` cannot be earlier than the NDCA 30-day minimum for an NDCA-declared event once the close date is known.
9. NDCA-declared event without the approved Chairman mapping: verification fails closed; Studio/Custom with a designated verifier: allowed.
10. Mixed rounds, paper plus digital, calculate correctly once the paper is verified; hash recomputation equals the stored `marks_hash`.
11. Rollback refusal and schema fingerprint; A7/OD-11/E2/F2/F3 regression suites unchanged in outcome.

## 7. NDCA requirements versus DanceFlow policy

- **NDCA text relied on:** IV.C.5 (Chairman verifies transcription), III.D.16 (original sheets: Chairman and Scrutineer only until the competition ends), III.E.2 (30 days retention).
- **WSDC text relied on:** 3.4.9.b.i (Chief Judge/approved team verification by a separate person).
- **DanceFlow policy, not a body rule:** mandatory verification for Studio/Custom/UCWDC/other, verification per ballot version, terminal discrepancy, blocking at lock/calculate/approve/publish, hash fingerprint, retention checklist acknowledgement and its advisory status.
- **Not found:** any UCWDC paper-transcription rule (unconfirmed, the Code of Conduct is missing).

## 8. Rule register entries (this PR)

`OD12-WSDC-0001` (3.4.9.b.i), `OD12-NDCA-0001` (IV.C.5 and III.D.16), `OD12-NDCA-0002` (III.E.2 retention), `OD12-UCWDC-0001` (silent, unconfirmed), `OD12-DF-0001` (baseline policy). All design only, none verified compliant. TRACKER row added.

## 9. Questions for the owner (exact)

- **Q1.** Confirm that unverified paper blocks **lock** (earlier than the minimum owner wording, and consistent with the Chairman checking after each heat) and not only approval/publication.
- **Q2.** May the adjudicator who marked the paper card serve as the independent verifier of its transcription? (Recommended: no; the judge's role is OD-11 confirmation.)
- **Q3.** For NDCA-declared events may the Chairman delegate verification to a named person (the Scrutineer has no DanceFlow role), and who approves that delegation?
- **Q4.** For Studio/Custom may a manager be designated verifier, and may a verifier also be the round's chair?
- **Q5.** Is the retention acknowledgement advisory (recommended) or a blocker before publication?
- **Q6.** Approve the OD-06 addition: a `scoring_team_member` designation approved by the Chief Judge.
- **Q7.** If the paper original is lost or never kept, a ballot cannot be verified: should such a round stay blocked (this design), or is there an owner-defined exception? (No bypass is designed.)

## 10. Not verified / not done

Docs only; no SQL written or run, no test run, no hosted state read. OD-10 had no design published; OD-04's migration is local; PRs #834/#838/#843 may change. The UCWDC Judge Certification Code of Conduct was not provided. NDCA page numbers are PDF indexes.

## 11. Independent review (fresh reviewer, no sight of the conclusions): findings and resolutions

The reviewer checked the design against E2/F2/F3/A7, OD-04's local migration, PRs #834/#838, OD-11 and the pinned PDFs. A first reviewer run died on a network error and was re-run. **Section 11 is normative: it overrides sections 3-6 where they differ.**

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | blocker | Adding a key to `_compe2_round_blockers` does not stop lock: `lock_competition_round_ballots` (E2 ~L1193-1217) raises only on fixed keys and never reads `ready`; calculate reads only `ready` (F2 L935-938). The cited E2 L769/817 are not lock callers (F2 L769/817 are status readers; lock is E2 L1193; status board E2 L1353). | The new key is folded into the `ready` expression **and** a pinned anchor in the lock RPC raises `COMP_PAPER_UNVERIFIED`; md5 pinned to the post-OD-11-s3 text (OD-11 s3 also redefines `_compe2_round_blockers`). Negative test: lock refuses when `ready` is false only because of paper. `src/lib/competition/ballots/status.ts` (consumer of blocker keys) is an app dependency. |
| 2 | blocker | The OD-11 review step cannot be "the new version's verification row": the version does not exist until apply, so a review-time row cannot carry its ballot id/version, and the base-version alternative collides with "discrepancy is terminal". Two sources of truth with OD-11 4.11. | Verification rows get a nullable `proposal_id` and `staged_marks_hash`; an OD-11 class (a) review verifies the **proposal** (staged-marks hash). The applied version counts as verified only when its recomputed canonical hash equals the verified staged hash (checked in the apply path and by the backstop); otherwise a fresh post-apply verification is required. OD-11 4.11's proposal columns for verifier identity/time are **dropped**: the verification table is the single source of truth (OD-11 4.11 amended in this PR). |
| 3 | major | Circular ordering with OD-11 (OD-11 section 9 said OD-12 first and "s3 does not ship" without it; OD-12 said it lands after). | Split: **OD-12 tables and helpers (s0-s1) land before OD-11 s1**; OD-12's blocker and lock/approve/publish anchors (s2) land **after OD-11 s3**. OD-11 section 9 and 4.11 are amended in this stacked PR. Order: OD-04, OD-05/06, OD-10, OD-12 s0-s1, OD-11 s0-s3, OD-12 s2. Migration numbering across the two blocks is for the coordinator to confirm before PR-B (not reserved). |
| 4 | major | "Discrepancy terminal" can block a round deliberately or by mistake; the only exit is an OD-11 proposal, which fails if a no-op change is refused or the judge is unavailable. | Add a recorded **verifier-error route**: a second independent verifier plus the chair record `discrepancy_withdrawn_as_error` (new event; no mark change; both identities audited; the original discrepancy preserved). The person who recorded the discrepancy cannot be the second verifier. Negative tests for each. |
| 5 | major | No lock order for `verify_paper_ballot`; "version current when written" is meaningless for a deferred trigger. | Order: `_compe2_lock_pair`, then round `FOR SHARE`; never event or round `FOR UPDATE` after the pair lock (OD-11 order). The RPC re-checks "current version" and round status (`active`, or `ballots_locked` with `correction_open`) after the locks; the backstop states "current at commit". Race test: verification versus a new version on the same pair. |
| 6 | major | "Needs verification" not defined against what calculation uses; ballots on scratched or cancelled heats, or void callback ballots, must not block forever. | The predicate is over exactly the ballots `_compf2_evidence` consumes, the same set as lock's `covered_ballots` (E2 ~L1224-1227); heat-less callback ballots included. Tests: scratched heat, not-danced callback round, heat-less ballot. |
| 7 | major | The claim that OD-06 6A allows a Chief Judge to verify is false (6A.8 puts 3.4.9.b.i out of scope); `secondary_chief_judge` omitted; designees may be name-only; `scoring_team_member` vs `scoring_operator`. | Claim corrected in 4.3. The Secondary Chief Judge is a candidate basis (new Q8). Verifier designations must carry a non-null `user_id`. The requested kind stays distinct from `scoring_operator` (the person inputting), who can never verify what they input. |
| 8 | major | NDCA III.D.16 limits direct access to originals to the Chairman and Scrutineer until the end of the competition; delegation to "a named person" conflicts. | Q3 now asks only whether a named person can be modelled as the **Scrutineer**; no free delegation. The restriction runs "until the end of the competition". |
| 9 | minor | WSDC 3.4.9 covers all WSDC Jack and Jill contests; related 3.4.5 (judges and scorekeepers take no other roles in that contest). | Corrected in section 2; a panel judge cannot act as the scoring-team verifier in the same contest (3.4.5). |
| 10 | minor | NDCA IV.C.5 "does not allow" overstated; the check is "after each heat" while the design blocks at round lock. | Reworded "does not provide for". Q1 states the heat-versus-round-lock difference; an NDCA heat-level checkpoint is offered as an alternative. |
| 11 | minor | UCWDC II.B.1.b names a Scrutineer and a Scoring Director as officials. | Recorded as unmapped roles with no verification duty stated. My search and the reviewer's of Couples and ProPro/ProAm found no transcription rule. |
| 12 | minor | OD-11 4.11 says a destroyed original allows class (b) or "stay as is"; Q7 said blocked with no bypass. | Reconciled: class (b), the judge re-authoring the ballot digitally under OD-11, **is** a legitimate exit (the judge's own authenticated act), not a bypass. |
| 13 | minor | Test 1 incoherent (two accounts of one uid). | Fixed: one user with two officials rows; one human with two accounts is an undetectable residual. |
| 14 | minor | `stale_version` undefined; approve/publish already refuse a changed ballot set via the input hash (F2 ~L1069). | `stale_version` removed; the approve/publish re-check is kept only for unverified current versions. |
| 15 | nit | Pin must use the post-OD-11-s3 md5; OD-04's suite fails on unclassified event-reachable tables. | Noted in section 5. |

New owner question **Q8:** may the Secondary Chief Judge (WSDC Definitions) verify, as the Chief Judge's delegate?
