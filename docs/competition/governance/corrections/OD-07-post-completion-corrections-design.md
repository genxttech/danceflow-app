# OD-07 design: controlled post-completion corrections of completed competition rounds

Status: **design only (PR-A, docs only). Nothing is implemented, applied, merged, deployed or activated.**
Owner decision: OD-07, 2026-11-23, Option A (controlled post-completion corrections), recorded in the retrospective audit decision list
(PR #795, `docs/competition/governance/audit/OWNER-DECISIONS.md` on `claude/comp-audit-owner-decisions`).
Base: `origin/release/website-embeds` at `49dbaee1b`. Governance: [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md), rule register entries `OD07-*`.

**Bottom line.** (1) Reopening `complete` back to `ballots_locked` is **not safe** (section 3); the design uses an explicit correction
case that leaves the round `complete`. (2) Implementation (PR-B) is **blocked** by unresolved role-mapping and workflow dependencies
(section 9); PR-B was not started. Exact open questions are in section 10.

---

## 1. Owner requirements (traceability)

| # | Requirement (OD-07 decision) | Where addressed |
|---|---|---|
| 1 | No arbitrary time limit; the WSDC 3-day reporting deadline is not a correction cutoff | 2, 4.1 |
| 2 | Explicit reason, authorized initiator, DISTINCT qualified co-signer | 4.2, 5 |
| 3 | Body-specific co-signer roles; no NDCA Chairman = WSDC Chief Judge assumption | 5 |
| 4 | Studio/Custom: independent designated reviewer (DanceFlow policy), no self-approval | 5 |
| 5 | Preserve every prior ballot, version, approval, withdrawal and publication event | 4.3, 4.6 |
| 6 | Corrected results are NEW versions linked to the superseded ones; WSDC availability; external reporting | 4.4, 6 |
| 7 | Computational corrections only; ballot alteration (OD-11) not built | 4.5 |
| 8 | UCWDC Judge Review Board: DanceFlow does not adjudicate external challenges; copy says so | 6.3 |
| 9 | Coordinate with OD-04 and OD-05/06 | 8 |
| 10 | Verify `complete` -> `ballots_locked` safety, prefer an explicit correction workflow | 3 |

## 2. Rule evidence (re-read in the pinned PDFs on 2026-11-23; SHA-256 verified against the source registry)

Page numbers are the document's printed page footers for WSDC and UCWDC; NDCA references are section ids with the PDF page
index in brackets (the NDCA footer numbering differs from the PDF index and the audit's printed-page citations were not re-derived).

| Rule | Source | What it says (own words) | What it does NOT say |
|---|---|---|---|
| WSDC 3.1 item 9 (p.12) | Registry Event Rules 2026.1C, sha256 `140caae7...d3b5` | Contest results (rounds, placements, score reports) must be posted at the event and stay open to all competitors for at least 30 days; judges may be listed anonymously; if results are inaccurate, corrected results must be posted. | No time limit for correcting; no statement that a corrected result restarts the 30 days. |
| WSDC 2.3 (p.9) | same | Event Director and/or Chief Judge verify contest results and contestant counts; results are due at the close and no later than 3 days after the event closes; late submission may carry penalties. | **Resubmission or amendment of already-reported results: NOT SPECIFIED** (searched the pinned text for resubmit, amend, correct; the only "corrected" is 3.1 item 9). The 3 days is a reporting deadline, not a correction cutoff. |
| WSDC 3.4.1 (p.18) | same | Event Director(s)/Owner(s) must not perform Chief Judge, Judge or Scoring functions; extends to spouses/immediate family for Chief Judge/Scoring. | - |
| WSDC 3.4.3 (p.19) | same | Chief Judge and Scoring/Tabulation functions are provided by separate individuals. | - |
| WSDC 3.4.5.b (p.19) | same | Judges decide independently; tampering with or altering contest scores is not allowed. | Does not define a computational-correction process. |
| WSDC 3.4.9.b (p.19-20) | same | Scores are computed by a computerized system; hand scoring only in emergencies. | - |
| UCWDC Couples II.N.1, II.N.3 (p.13) | v1-26-2026, sha256 `8a45ee58...4904` | Decisions of the judges, Contest Coordinator and Event Director are final; a complaint or challenge to a panel's composition or results is made post-event and goes to the Judge Review Board. | The Judge Certification Code of Conduct (referenced) was not provided; whether an organizer may amend a result post-event on its own is **NOT SPECIFIED**. |
| UCWDC Scoring Format Rule #8 part 1 (p.4) | v16.9b, sha256 `44290a06...b02f` | If a tie proof does not hold, a scoring error occurred and the previous rules are re-calculated. | In-contest tabulation check, not a post-event correction rule. |
| NDCA III.E item 2 [PDF p.32] | Rule Book June 2026 Master v1, sha256 `d1b73e1f...daa6` | Organizers retain the original adjudicators' score sheets for 30 days after the close, for a discrepancy in the scrutineers' final markings. | Not a deletion trigger and not a correction cutoff. |
| NDCA V.B.4 [PDF p.38] | same | Competitors accept the adjudicators' markings as final; no appeal except where the markings were incorrectly evaluated. | Does not define who corrects an incorrect evaluation. |
| NDCA IV.C chairman duties, items 5-7 [PDF p.34] | same | The chairman checks marks and transcription, refers a card needing correction to the adjudicator concerned, and decides marking questions finally. | Does not say that the DanceFlow `chair` role equals the NDCA Chairman. |

Findings that matter for the design:

- **No source gives a correction time limit.** WSDC explicitly has none; the owner's no-cutoff policy is consistent with every pinned source.
- **WSDC re-reporting is unspecified.** The product cannot claim WSDC compliance for a resubmission; it must say so (6.2).
- **UCWDC and NDCA both treat judge decisions as final, with a post-event path outside the organizer** (UCWDC: Judge Review Board; NDCA: appeal only for incorrect evaluation). Corrections under those bodies need an organizer-policy classification (Q7).
- Where a rulebook is silent, behavior in this design is labeled **DanceFlow policy** (register entry `OD07-DF-0001`).

## 3. Is `complete` -> `ballots_locked` safe? No (traced on the base branch)

Round status readers and writers, and what a reopen would do to each (all paths relative to `src/lib/supabase/migrations/`):

| Reader / guard | File | Effect of a `complete` -> `ballots_locked` reopen |
|---|---|---|
| O1 `_compo1_guard_round_status` | `20270106090000_competition_o1_day_of.sql:162` | `complete` is terminal (`COMPO1_ROUND_TERMINAL`) and absent from the static edge list; a reopen needs the terminal rule and the edge list changed in a protected, widely-used guard. |
| F2 `_compf2_guard_round_status` | `20270114090000_competition_f2_results_lifecycle.sql:352` | `correction_open` is derived only from calculated/approved/published; a `complete` edge would either leave it false (a normal-looking locked round with a stale approved result) or be extended to set it true. |
| F2 ballot gate (E2 rewrite) | same, section 3 | Ballots are accepted while `ballots_locked AND correction_open`. Setting `correction_open` for a completed round **opens replacement-ballot filing on a finished round** - exactly the ballot-alteration path (OD-11) that OD-07 must not build. |
| A7 `cf1_a7_record_correction_cause`, `cosign_competition_correction` | `20270120095500_...a7_od13_correction_integrity.sql` | The cause trigger fires on the correction edge and raises `COMP_CORRECTION_CAUSE_REQUIRED` if it cannot derive a cause; when satisfied, `judge_entry_error` + co-sign unlocks arbitrary valid replacement ballots. |
| F2 `_compf2_invalidate_versions` | F2 `:661` | Opening a correction turns the approved version `stale`. |
| F3 `_compf3_live` | `20270122090000_competition_f3_publication.sql:259` | A publication is live only while the round is published/complete, `correction_open` is not true and the version is approved: a reopen **hides the published result from entrants and the public** until a new result is approved and published. That conflicts with WSDC 3.1 item 9 (results open at least 30 days; corrected results posted) and leaves a withdrawn result with no way back (a withdrawn version is never republished). |
| F3 `withdraw_competition_round_result` | F3 `:484` | Already allowed on a completed round, with no recovery path today (the OD-07 gap). |
| CF1 `cf1_guard_advancement_correction` | `20270120090000_competition_cf1_callback_final_advancement.sql:1050` | Handles only calculated/approved/published sources; a completed callback round with an applied advancement and a started Final would bypass its checks (`COMP_ADVANCEMENT_FINAL_STARTED`, `..._PUBLISHED_NEEDS_F3`). |
| F2 `open_competition_round_correction` O5 guard | F2 `:1177` | Refuses once a later round of the division has any ballot; a completed earlier round normally has one. |
| E2 `reopen_competition_round_ballots` | E2 `:1233` | Refuses while an approved/published version or any publication exists, so a reopened completed round cannot be moved back to `active` (this part is safe). |
| A5 exclusions | `20270120094000_...a5_exclusion_action.sql:272` | Exclusions are accepted only while `active`/`ballots_locked` and with no current publication, so a reopen would also reopen the exclusion window. |
| O1 `cancel_competition_round` | O1 `:456` | Refuses `complete`; unaffected. |
| CF1/10D heat guards (`cf1_check_final_single_live_heat`, per-version heat uniqueness, floor-plan copy) | CF1 A0 | Key on heat status, lock state and advancement rows, not on the round `complete` status; an explicit case that never touches heats leaves them untouched, a reopen route would be exposed to Final-heat revocation side effects. |
| `complete_competition_round` | F2 `:1109` | Needs `published` and a current publication; after a reopen the whole F2 -> F3 chain must run again, with the live result hidden meanwhile. |

**Conclusion.** Reopening compromises evidence availability (the published result goes dark), enables the unwanted ballot-alteration path, and changes
three protected guards. The design therefore adds an **explicit correction case** and leaves round status `complete`.

## 4. Design: explicit post-completion correction case

### 4.1 State model

The round stays `complete` and `correction_open` stays false. A separate **correction case** carries the workflow:

`opened -> calculated -> approved (co-signed) -> published`, plus `cancelled` (before publish).

- At most one open case per round (partial unique index). No time limit anywhere: nothing keys on elapsed time, event close, the 30-day or 3-day windows.
- Opening needs: event manager (authorized initiator, verified email), reason 1-500 characters, request id (idempotent), and a pre-check set (4.7).
- Existing behavior is unchanged: ballots are still refused on a `complete` round, so the ballot gate cannot be reached.

### 4.2 Roles and separation

- **Initiator**: `can_manage_event_competition`, verified email. Records `initiated_by`.
- **Calculator**: the actor that runs the recalculation (manager or assigned scorer, as F2 today). Records `calculated_by`.
- **Co-signer**: approves the corrected version; must differ from the initiator **and** the calculator; **no calculator-approves-with-override path** (F2's D3 override does not apply to corrections). Body-specific qualification in section 5.
- Every actor action writes one append-only audit row (new result-event kinds `correction_opened`, `correction_calculated`, `correction_approved`, `correction_published`, `correction_cancelled`) in the same transaction as the state change, mirroring F2/F3 writer guards.

### 4.3 Preservation (requirement 5)

No row is updated or deleted except the existing status/stamp columns already allowed by the history-protection triggers:
original ballots and marks (untouched), prior result versions and rows (status moves only, `approved -> superseded` at publish), approvals, withdrawals and
publications (supersede stamp only), audit events. The case table itself is insert-only plus guarded status transitions.

### 4.4 Versions and publication (requirement 6)

- The corrected result is a **new `event_competition_result_versions` row** (`version = max + 1`) carrying a link `corrects_version_id` to the version it supersedes (new nullable column or link table; decided in PR-B). Engine, evidence hash and trace hash rules are the existing ones; the engine pin reader and the PV-1 database recomputation (`_comppv1_verify`) run unchanged, so a caller cannot store fabricated placements.
- The previously approved version and its publication stay **current and live until the corrected version is published**, then the existing F3 supersede mechanics apply atomically (`publication_version + 1`, old row stamped `superseded_by`, one `result_superseded` audit row). Nothing is hidden during the correction (WSDC 3.1 item 9). Whether entrants see a "correction pending" notice depends on OD-22 (Q4).
- A **withdrawn** publication of a completed round is recoverable through the same case: the corrected version may be identical in content when the cause is a re-issue (Q6); otherwise an unchanged recalculation is refused as `COMP_CORRECTION_NO_CHANGE`.
- Publication re-uses every F3 precondition (approved, latest, hash current, no unresolved refund exception, roster eligible, OD-01 body gate).

### 4.5 Computational corrections only (requirement 7)

- The correction recalculates from the **unchanged locked ballots**: the ballot/mark set in the new evidence must equal that of the superseded version (tripwire `COMP_CORRECTION_BALLOTS_CHANGED`).
- No ballot, mark or replacement-ballot write is added; OD-11 (who may correct a judge's ballot, with judge confirmation) stays a separate, undecided item and is **not built**. Copy states that adjudicators' original submissions are protected.
- **Practical scope finding for the owner (Q9).** After completion the recalculation inputs are largely frozen: ballots are closed, A5 exclusions are accepted only while `active`/`ballots_locked` with no current publication, and PV-1 makes the stored placements a pure function of the evidence. The cases that can legitimately yield a different corrected version are therefore (a) a newly pinned engine version that fixes a defect, (b) a re-issue after a publication was withdrawn, and (c) non-ballot evidence that is shown to have changed (to be verified in PR-B). The most common real-world cause, a judge entry or transcription error, needs OD-11. OD-07 alone has narrow practical value until OD-11 is decided.

### 4.6 Audit and evidence

`competition_audit_log` (F2) gains the correction kinds so one timeline reads: original calculation, approval, publication, completion, withdrawal (if any), correction opened / calculated / approved / published. The correction case stores reason, class (`recalculation` | `reissue`), the superseded and new version ids, initiator, calculator and co-signer ids with roles at the time, and external-reporting acknowledgement (6.2).

### 4.7 Pre-checks at opening (fail closed)

Round is `complete`; a current approved version exists; no unresolved `competition_refund_*` exception for the round; **no active advancement from this round** and **no later round of the division with ballots** (O5), otherwise `COMP_CORRECTION_DOWNSTREAM` (callback rounds with an applied Final roster are out of scope, Q5); body gate (5); roster eligibility; event not deleted/archived per OD-04 semantics.

## 5. Co-signer matrix (requirements 2-4)

| Event type (`events.competition_sanctioning`) | Initiator | Calculator | Qualified co-signer | Status |
|---|---|---|---|---|
| `none` / `other` (Studio, Custom) | event manager | manager or assigned scorer | an **independent designated reviewer** (DanceFlow policy): designated at event level by a manager, verified email, a different person from the initiator and the calculator; designation ahead of opening; no self-approval | buildable, but the designation concept does not exist today (Q2) |
| `wsdc` | event manager | the designated **scoring/tabulation operator**; never the Event Director/Owner (3.4.1) and never the Chief Judge (3.4.3) | the **Chief Judge and/or Event Director** (2.3 verification duty), different from the calculator; Event Director/Owner may not score | **blocked**: no Event Owner / Event Director / Chief Judge / scoring-operator designations exist (OD-06 decided to design them, not built; OD-05 holds placeholders) |
| `ndca` | event manager | scorer | the NDCA **Chairman of Adjudicators** duties (IV.C items 5-7) | **blocked**: no approved mapping of the DanceFlow `chair` role to the NDCA Chairman (audit row J-01, OD-06/OD-15); not assumed equal to WSDC Chief Judge |
| `ucwdc` | event manager | scorer | Contest Coordinator / Event Director (decisions final, II.N.1) | **blocked**: no such roles; organizer-initiated post-event amendment itself is unspecified (Q7) |

Until OD-06 designations and an approved role mapping exist, body-declared events fail closed (`COMP_CORRECTION_BODY_ROLES_UNMAPPED`). That is coherent with OD-01
(approval/publication of Studio-scored results is already to be blocked for declared bodies), so no body-declared Studio-scored result needs a correction yet.

## 6. Publication, external reporting and challenges

1. **Availability.** The prior publication is never hidden by a correction; a corrected version supersedes it only on publish. The product never auto-expires or deletes results (consistent with OD-04). Whether a corrected result restarts WSDC's 30-day minimum is **NOT SPECIFIED**; conservative policy: keep the corrected result open at least 30 days from its own posting date (DanceFlow policy, labeled).
2. **External reporting.** DanceFlow does not report results to NDCA, UCWDC or WSDC. For a WSDC-declared event a correction record carries a one-line acknowledgement that the organizer must handle any resubmission with the governing body; the pinned WSDC rules state the 3-day initial reporting duty (2.3) but **no resubmission procedure**, and the copy says that. No compliance claim is made.
3. **Challenges (UCWDC and similar).** Required copy wherever the correction flow is shown: "DanceFlow records corrections made by the event organizer. It does not decide or adjudicate formal challenges or complaints; under UCWDC rules these are made after the event to the Judge Review Board." The flow never accepts or implies a Judge Review Board outcome as an input.

## 7. Failure and recovery

- Calculation refused by PV-1 or the engine pin: the case stays `opened`; cancel or retry; nothing is stored.
- Co-signer refuses or never acts: the case can be cancelled by the initiator with a reason; the prior publication stays live throughout.
- A correction never changes round status, so a crash between steps leaves the round in the same coherent `complete` state.

## 8. Coordination with sibling work

| Item | State read (read-only) | Contract with this design |
|---|---|---|
| OD-04 delete guard | worktree `od04-event-delete-guard`, migration `20270219090000`, evidence-table list `_compod04_evidence_tables()` | Every new table here must be added to that list (its SQL suite fails for an unlisted table reachable from `events`); PR-B must therefore merge after OD-04 or rebase on it. |
| OD-05 conflicts (PR #834, docs) | migration block proposed `20270220090000`-`...096000`; `_compoc_blockers_roles` is an OD-06 placeholder | The correction co-sign reads the **same** OD-06 designation source; it does not create its own parallel role table for bodies. Proposed correction migration block: `20270221090000`-`20270221093000` (to confirm; not reserved). |
| OD-06 role separation | decided, designation design not built | Section 5 depends on it (blocking for body events). |
| OD-01 sanction guard | draft PR in progress | Corrected approval/publish call the same body gate. |
| OD-11 ballot corrections | undecided | Not built; boundary in 4.5. |
| OD-22 withdrawal/hiding | undecided | Section 4.4 assumes "prior publication stays live"; Q4. |

## 9. Unresolved dependencies (why PR-B was not started)

1. **Co-signer role mapping** for every declared body (OD-06 designations, OD-15 credentials, J-01 NDCA Chairman mapping): not built or approved.
2. **Studio/Custom designated reviewer** concept: new, not in OD-06 or OD-05; eligibility rules are policy decisions (Q2).
3. **OD-22 publication visibility** during a correction is undecided and this design departs from the contract text for in-round corrections.
4. **Callback rounds with an applied Final roster**: needs a Final-rework workflow (Q5).
5. **OD-04 merge order** for the evidence-table list, and OD-05/06 shared-guard design.
6. **OD-11** (ballot corrections) determines whether the workflow has meaningful use (Q9).

## 10. Questions for the owner (exact)

- **Q1.** Co-sign at the approval of the corrected version only (recommended), or also at opening?
- **Q2.** Studio/Custom designated reviewer: who designates (manager), and may a reviewer be a judge, chair or scorer of that round (recommended: no), a team member only, always different from initiator and calculator?
- **Q3.** Confirm the first build covers `none`/`other` only and fails closed for declared NDCA/UCWDC/WSDC events until OD-06 designations and the role mapping exist.
- **Q4.** (OD-22) Confirm the prior publication stays live during a post-completion correction (recommended, WSDC 3.1 item 9), with or without a "correction pending" notice to entrants; and confirm the conservative 30-day policy for a corrected result.
- **Q5.** Refuse corrections when a callback round has an applied advancement or a later round holds ballots (recommended), deferring Final-roster rework?
- **Q6.** Allow a re-issue (identical content) after a withdrawal?
- **Q7.** UCWDC/NDCA: classify an organizer-initiated post-event computational correction as organizer policy, or leave those bodies unsupported until the Judge Certification Code of Conduct and body role mapping are available?
- **Q8.** Approve mapping the DanceFlow `chair` role to NDCA Chairman duties for co-signing (needed only for an NDCA profile)?
- **Q9.** Sequence OD-11 (ballot corrections) before or with OD-07? Without it the workflow only covers engine-fix and re-issue cases.

## 11. PR-B plan once Q1-Q6 are answered (not started)

Migration block `20270221...` (new tables: correction cases, designated reviewers, co-sign rows; new event kinds; four writer RPCs; guards; rule-register links) with rollback refusing while any case exists; app guard (`results/contract.ts` edges for the case, `messages.ts` codes, required copy constants); negative tests (self co-sign, calculator = co-signer, no reviewer, body event, active advancement, later-round ballots, ballot change, no-change correction, replay/idempotency, request reuse, concurrent open); lifecycle tests (open -> recalculate -> approve -> publish -> supersede, withdrawal re-issue, cancel); evidence-preservation assertions; independent review by a subagent without these conclusions; rollback verification on an isolated local Postgres under the heavy lock. **Not run for this PR (docs only).**
