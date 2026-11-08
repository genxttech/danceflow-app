# CF1 package A7 — OD-13 correction-ballot integrity (contract for B app, C QA)

Migration `20270120096000_competition_cf1_a7_od13_correction_integrity.sql` (rollback in `rollback/`, suites `sql-tests/test_T_competition_cf1_a7_od13.sql` and `sql-tests/test_T_competition_cf1_a7_concurrency.sh`).
Design: `callback-to-final-advancement-design.md` §4.1 (OD-13 Option R), §4.6 (OD-13b C, OD-13c A, OD-19 D). Closes the scope gap named in `cf1-a0-contract.md` ("Status / not delivered"). Stacked on A0 + A1 + A3 + A5.
Also delivers the P-1 reader inventory: `cf1-p1-reader-inventory.md`.

## What it adds

| Object | Role |
|---|---|
| `event_competition_correction_causes` | One row per correction opening: `cause` (`entry_exclusion` \| `judge_entry_error`), `excluded_entry_ids` (X at open), `baseline_version_id`, `opened_by`, `reason`, `at`, `request_id`, `transaction_id`. Insert-only. Written by trigger `cf1_a7_record_correction_cause` (AFTER UPDATE OF status on rounds, the F2 correction edge). No parameter anywhere lets a caller choose the cause. |
| `event_competition_correction_cosigns` | Insert-only; one per cause (`unique(cause_id)`): `cosigned_by`, `role` (`chair` \| `manager`), `at`, `request_id`, `transaction_id`. |
| `event_competition_ballot_corrections` | Insert-only, one per correction ballot: `ballot_id` (replacement), `supersedes_id` (original), `original_picks`, `replacement_picks`, `diff {removed, added, unchanged}`, `reason`, `actor`, `at`, `cause_id`. |
| `cosign_competition_correction(p_cause_id, p_request_id)` | chair or manager, verified email. Authenticated only. |
| `competition_round_correction(p_round_id)` (A7 extra, read) | chair/manager: cause, co-sign, `restricted`, `restricted_entry_ids` (the live X), correction ballots. B uses it for the correction screens. |
| `_compe2_insert_ballot` (pinned text-replace, 3 single-line anchors) | calls `_cf1_check_correction_ballot` before the ballot INSERT and `_cf1_record_ballot_correction` after the marks INSERT. |
| Deferred constraint triggers `cf1_a7_backstop_ballot` / `_correction` | the same rule re-asserted at commit for any writer. |

All triggers are ENABLE ALWAYS. The three tables have RLS on, no policies, no grants. Internal functions have no grants (U70).

## The rule (callback_yes@1 ballots, round with `correction_open`)

X = (exclusion set now) − (exclusion set of the baseline version), both as the F2 evidence computes them (scratched, NS1 no-show, A5 excluded). The cause row snapshots X at open; the rule reads X **live**.

* **Restricted (Option R)** when the cause is `entry_exclusion` **or** X is not empty: the judge's current ballot must hold a pick in X (`COMP_CORRECTION_BALLOT_NOT_PERMITTED`); the new ballot keeps every other pick, drops every pick in X, adds exactly that many new couples (`COMP_CORRECTION_BALLOT_RESTRICTED`, `detail` lists `removed_other_picks`, `kept_excluded`, `expected_replacements`, `added`). No co-sign is needed.
* **Full (Option F)** otherwise (`judge_entry_error`, X empty): any valid ballot, but only after a co-sign (`COMP_CORRECTION_COSIGN_REQUIRED`) and never by a co-signer (`COMP_CORRECTION_COSIGNER_CONFLICT`; the filer is the submitter, the judge or the entering scorer).
* A **first ballot** (no current ballot) is refused during a correction (`COMP_CORRECTION_BALLOT_NOT_PERMITTED`).
* No cause row while `correction_open` → `COMP_CORRECTION_CAUSE_REQUIRED` (also raised by the trigger if the audit row or a baseline version is missing, aborting the F2 correction).
* Non-callback formats, and rounds not in a correction, are unchanged (no correction row is written).

## Co-sign rules (`cosign_competition_correction`)

Order: auth/role (`COMP_FORBIDDEN`), verified email (`COMP_VERIFIED_EMAIL_REQUIRED`), request id (`COMP_REQUEST_ID_REQUIRED`), event advisory lock, round `FOR UPDATE`, replay (`replayed: true`) / `COMP_REQUEST_REUSED`, cause must be `judge_entry_error` (`COMP_CORRECTION_COSIGN_NOT_REQUIRED`), must be the round's open correction (`COMP_CORRECTION_NOT_OPEN`), not the opener (`COMP_CORRECTION_COSIGN_SAME_PERSON`), not already co-signed (`COMP_CORRECTION_ALREADY_COSIGNED`), not someone who filed a replacement ballot under this correction (`COMP_CORRECTION_COSIGNER_FILED_BALLOT`). Role recorded from `_compe2_round_role` (manager wins if both). Later filers are refused at the ballot insert.

## Owner decisions applied after the first A7 review (A7-1, A7-2)

1. **A7-1 — strict design §4.1 rule.** Trigger `cf1_a7_guard_exclusion_during_correction` (BEFORE INSERT on A1's `event_competition_round_exclusions`, ENABLE ALWAYS, definer, round row `FOR UPDATE` first) refuses **every** exclusion row (`exclude_requested`, `exclude_cosigned`, `reverse_requested`, `reverse_cosigned`) while the round's `correction_open` is true: **`COMP_CORRECTION_EXCLUSION_DURING_CORRECTION`** (`P0001`, stable; B maps it). A5's request/co-sign flow is unchanged when no correction is open (A5 holds the round lock already, so the extra lock is re-entrant). The live-X lookup in the rule stays as defence in depth only. This **supersedes departure 1 of the earlier text** (the live set no longer replaces the lifecycle restriction).
   * **Consequence B/QA must know:** A5's window is `active` / `ballots_locked`; a correction opens only from `calculated` / `approved` / `published` and then keeps `ballots_locked` + `correction_open` until recalculation. So after A7-1 an exclusion can no longer be recorded *between* a correction's open and its completion, and A5 refuses it at `calculated` / `approved`. §4.6 route (4) ("open the F2 correction, then record the exclusion") is therefore unavailable; exclusions are recorded in `active` / plain `ballots_locked` (routes 2–3), and a correction's `entry_exclusion` cause arises from scratches / NS1 no-shows / exclusions that exist *before* it opens. Reported to the coordinator.
2. **A7-2 — the opener never files.** `_cf1_a7_rule` raises **`COMP_CORRECTION_OPENER_CONFLICT`** (`P0001`) when the cause's `opened_by` is among the filers (submitter, judge's user, entering scorer's user), in both modes, at the `_compe2_insert_ballot` anchor and in the commit-time backstop. The co-signer prohibition is unchanged.

## Deliberate departures from the design text (flagged for the coordinator)

1. *(Superseded by A7-1 above.)* **Design §4.1 says a new exclusion during an open correction is refused** (`COMP_CORRECTION_EXCLUSION_DURING_CORRECTION`) and the cause is fixed at open. But §4.6 route (4) and §4.7 (A5, shipped) have the manager open the F2 correction **first** (round → `ballots_locked`) and **then** record the exclusion. Refusing it would make route (4) impossible and contradict A5's contract. A7 therefore does **not** add that refusal. To keep Option R intact, the rule reads X live (never looser than the design): an exclusion recorded after the open still restricts ballots, whatever the cause row says. The cause row stays immutable. If the owner prefers the strict refusal, it is a one-trigger addition on the exclusion table, but it removes route (4).
2. **Exclusion reversed during a correction** (X becomes empty while the cause is `entry_exclusion`): every correction ballot is refused (fail closed).
3. `competition_round_correction` (read RPC) is an A7 extra, as A5's `competition_round_exclusions` was.
4. Corrections already open when A7 is applied have no cause row; ballots in them fail with `COMP_CORRECTION_CAUSE_REQUIRED`. None can exist on a hosted database today (CF1 is not deployed); reopen the correction.

## Error codes added (all `P0001` unless noted)

`COMP_CORRECTION_EXCLUSION_DURING_CORRECTION`, `COMP_CORRECTION_OPENER_CONFLICT`, `COMP_CORRECTION_FORMAT_UNSUPPORTED`, `COMP_CORRECTION_CAUSE_REQUIRED`, `COMP_CORRECTION_BALLOT_NOT_PERMITTED`, `COMP_CORRECTION_BALLOT_RESTRICTED`, `COMP_CORRECTION_BALLOT_UNRECORDED` (backstop), `COMP_CORRECTION_COSIGN_REQUIRED`, `COMP_CORRECTION_COSIGNER_CONFLICT`, `COMP_CORRECTION_COSIGN_NOT_REQUIRED`, `COMP_CORRECTION_NOT_OPEN`, `COMP_CORRECTION_COSIGN_SAME_PERSON`, `COMP_CORRECTION_ALREADY_COSIGNED`, `COMP_CORRECTION_COSIGNER_FILED_BALLOT`; reused: `COMP_FORBIDDEN` (`42501`), `COMP_VERIFIED_EMAIL_REQUIRED` (`42501`), `COMP_REQUEST_ID_REQUIRED`, `COMP_REQUEST_REUSED`.

## Interplay with other packages

* A5's trigger `cf1_a5_guard_replacement_ballot_filer` (exclusion co-signers cannot file replacement ballots) stays; A7 adds the correction-co-signer equivalent.
* Existing suites that file callback correction ballots under an open correction (E2/F2/CX1) now meet the rule; see the PR matrix for the runs.
* Rollback: A7 first (before A6/A5/A3 …), refused once any A7 row exists.
