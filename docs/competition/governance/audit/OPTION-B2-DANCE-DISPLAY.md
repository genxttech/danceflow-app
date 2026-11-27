# Published results show the recorded dance (bounded change specification; not authorized)

**Status: SPECIFICATION ONLY, unexecuted.** DanceFlow Studio/Custom policy. B2 Q9, requirements 1 and 11 (PR 795 section 18, `364575afc`). It does **not** close the different-dance bypass; R-11 and B2 stay blocked. Companion: [OPTION-B2-DESIGN.md](OPTION-B2-DESIGN.md).

## Today (code reading, `49dbaee1b`)

* The public payload `_compf3_payload` (`20270122090000:292-325`) names round, division and program, no dance. It feeds `competition_event_results_public`, `competition_round_results_public` and `competition_my_results`.
* A result version's immutable evidence lists the dances of its ballot heats as `input -> 'danceIds'`: catalog id, or the key when there is no id (`20270114090000` ~L612-615). No labels.
* For published heats the existing guard refuses inserts, deletes, moves and non-status changes of dance rows (`20261111090000:337-374`; advancement exempt, `20270120090000:1522-1534`). An earlier draft said a row could be moved off a certified heat; that was **wrong**: the older lock trigger checks only the new heat, but this guard also checks the old one.

## Change

1. **Label snapshot.** Append-only table (publication, dance reference, label, recorded at), written by a definer trigger when a result publication row is inserted: one row per entry of that version's `danceIds`, label taken from the matching dance row of the round's certified heats. If any reference has no label, or labels disagree, publication is refused (`COMP_RESULT_DANCE_UNRESOLVED`).
2. **Payload.** `round.dances: [{ref, label}]` from the snapshot only (one pinned replacement of `_compf3_payload`). No snapshot: the page says "Dance not recorded". A current catalog name is never substituted. Hosted approval rows were 0 on 2026-11-26, so no published result should lack one (inference; recheck).
3. **No new guard.** The existing published-heat guard keeps the recorded rows; status-only changes do not change which dances the evidence lists.
4. **App.** Show the dance beside the round on the public and "my results" page (`src/app/events/[slug]/competition/results/page.tsx`) and on the staff results pages. The staff approval screen shows: the recorded dance(s); "This is the scheduled dance on record; the system cannot confirm what was danced"; and whether the division holds rounds for other dances. Any other surface found at implementation shows the same value or none. Public wording beyond the dance name: **Q18**.

## Not changed

Ballots, marks, engines, evidence, input hashes, result versions and rows, approvals, publication rows and history, round names. Labels are display only; **no security decision reads a label** (requirement 8).

## Delivery and tests

Slot `20270301167000` plus one app change; independent of the other B2 steps; rollback restores the payload text and keeps snapshot rows. Tests (to be written): one and several dances listed (several cannot be calculated today); rename of the catalog dance leaves the shown label; missing or conflicting label refuses publication; no snapshot shows "not recorded"; moving a dance row off a published heat stays refused (existing); public, entrant and anonymous visibility unchanged apart from the new field; result bytes other than `round.dances` identical before and after.

Not verified: everything above; other result surfaces (exports, printing, mobile).
