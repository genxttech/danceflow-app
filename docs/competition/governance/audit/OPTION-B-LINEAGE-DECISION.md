# Option B (replacement-result guard): lineage analysis and the owner decision

**Status: DECISION WRITE-UP ONLY. No code, no migration, nothing applied.** Owner conditional approval of 2026-11-26: build B only on a reliable, trusted lineage basis; if lineage cannot be established reliably, stop and present the decision. **This document stops there.**
This is DanceFlow Studio/Custom policy (R-11 approval separation), not a governing-body rule.

## 1. The confirmed problem

PR 865 limits the single-staff override to the initial approval of **a round**. Executed locally on 2026-11-26 (PR 865, R-11-CORRECTION-MIGRATION.md section 12a, one manager, database role `authenticated`): with PR 865 applied, a **published, self-approved replacement over the same couples** was produced for a corrected, never-published result by

* **NC** running a never-run spare round that was already in the published running order (corrected round left alone),
* **CS** the same after cancelling the corrected round,
* **CA** the same after cancelling a corrected round that a second manager had approved,
* **R** moving the spare round's published heat to a newly inserted round by a direct table write.

Limits: the spare heat was installed by fixture (superuser, replica mode). The app planner does not create that state; by code reading the database function `apply_competition_floor_plan` accepts a hand-built plan with a second round and publication accepts it, not executed. R ran after the corrected round had been cancelled. No S3-S6; no API or UI exercised.

**Option D does not close NC, CS or CA.** D (draft, slot 20270301170000) refuses direct writes to published heats, which addresses R only.

## 2. What the database can trust

| Evidence | Mutable by a manager? | Usable |
|---|---|---|
| result version `input` (entries, dance ids, heats, round block), result rows, result events, approvals, correction causes, publications, round transition events, CF1 advancement records | No (insert-only or guarded; written by lifecycle functions) | Yes |
| round name, type, sequence number, division of a newly inserted round | **Chosen by the manager** (frozen only afterwards in a locked program) | No |
| entry rows (a couple's identity inside a division) | A manager can create further entries for the same people | Only as "the same entry" |
| participants / competitor ids | Editable | No |
| dance identity on a heat (`coalesce(dance_id, dance_key)`) | **Chosen by the manager** while the order is a draft; frozen once published | Only as "the same dance record" |

## 3. Conclusion on lineage

A rule must recognise "the same contest again". The only identities held are the **entry** and the **dance record**. They recognise a replacement only when it reuses them. A replacement prepared with a different dance record ("Waltz" / "Waltz 2") or a second set of entries for the same people cannot be told apart from a legitimate second category by anything in the database; matching on people would flag legitimate cases (the same couple in Newcomer and Open). **Lineage is therefore reliable only for a subset, and no rule is implemented.**

Review: an independent reviewer checked a first version against the code and the probe logs and corrected it (planner wording, dance identity, progression exception, B2 slot rules); this text includes those corrections and **was not re-reviewed**.

## 4. B1: exact entry-and-dance rule (narrow)

**Rule (precise).** At approval of a version V of round r (taking the event lock, not only the round lock): the pairs are every entry in V's stored `input.entries` crossed with every dance in `input.danceIds`, with dance identity **normalized** (a catalog id resolved to its dance key; a heat dance without a catalog id, or an empty set, fails closed: no single-staff override). A pair is *taken* when **any version of any other round of the event** contains it, **unless** that other round is the source of an unrevoked advancement into r (`event_competition_round_advancements`: `source_round_id` = that round, `target_round_id` = r, matching source version) and the source round is not cancelled. If any pair is taken, V counts as a replacement: no single-staff override, and the approver must be neither V's calculator nor anyone who opened a correction of, or cancelled, a round holding a taken pair.

**Blocks:** the four executed routes (same entries, same dance), by design; not demonstrated, because B1 does not exist.
**Lets through:** a replacement under a genuinely different dance record or key (`dance_key` is free text, so "Waltz 2" is one) or a second entry set; another event; **a round left with ballots but never calculated** (cancelled or not), followed by the spare; the first self-approval made before the other round has any result.
**Effect on legitimate work:**
* Preliminary to Final: allowed only through a recorded CF1 advancement from that preliminary into that Final.
* Any progression without such a record (manual placement, a callback-to-callback stage, an approved callback row alone): needs a second manager.
* Multi-dance: on this chain PV-1 refuses a round whose dance count is not one, so multi-dance rounds cannot be calculated today and the overlap effect is hypothetical. Separate one-dance rounds for different dances are unaffected.
* Single-manager studio, initial approval: unchanged for the first result of each (entry, dance); a genuine re-dance of the same pair can no longer be approved by one manager.
**Needs:** one follow-up migration redefining `approve_competition_round_result` on PR 865's pinned text; tests for every bullet; app message.

## 5. B2: contest identity fixed at running-order publication

**Rule (precise).** Publishing a running order writes an append-only "contest slot" for each (division, catalog dance ids, stage) and binds every published round to one. **Stage is derived only from the advancement graph**, never from `round_type` or sequence (a round with no advancement edge is the same stage as any other such round over that division and dances). A catalog dance id is required; free-text dances are refused. A round that is unbound (created or re-pointed after publication) gets no single-staff override. The override is available only while no other round of the slot has ballots or results.

**Blocks (by design, if the constraints above hold):** the four executed routes, and a round left with ballots and no result.
**Lets through:** a second catalog dance that is really the same dance (two catalog records locked together are two slots, unless the catalog is deduplicated by rule); a second entry set or new division for the same people; another event.
**Effect on legitimate work:** preliminary to Final preserved through advancement (today only callback to Final exists; every other stage needs an advancement model first, or a second manager); multi-dance would need the dance set in the slot (not calculable today); single-manager initial approval preserved for the first round of each slot; a genuine re-dance needs a second manager.
**Needs:** new table, planner and publication changes, a locked and deduplicated dance catalog, an advancement model for every stage in use, treatment of published orders, then the approval change. A design project.

## 6. Options not recommended

* **Refuse the override in any division with two result-bearing rounds:** flags every preliminary-to-Final and multi-dance division (rejected by the no-broad-heuristic condition).
* **Remove the single-staff override:** single-manager studios could not approve at all (contradicts ratified R-11).

## 7. The decision

1. Choose **B1** (small; closes the four executed routes; stated residuals), **B2** (closes the label and ballot variants too; larger), or **neither** and accept the route with disclosure.
2. If B1: also treat a pair as taken when another round holds ballots but no result? (Closes one residual; refuses more.)
3. Ship **Option D** in any case for the direct-write routes. D's value also depends on **U18** (PR 867): without it a manager can mark couples danced by a direct write, no heat reaches a run status, and a new running order could still be published after results. B1 matches stored result versions and does not depend on U18.

**Engineering recommendation:** B1 including rounds with ballots, plus D and U18, before public activation; revisit B2 with the advancement model.

## 8. Dependencies and interplay

* **PR 865:** B1 redefines the same function and must pin PR 865's post md5 (`2d178c29...`); B2 adds sources next to PR 865's three.
* **PR 867 (U18):** precondition. **Option D:** companion.
* **PR 866 (S4):** its `r15_guard_*` triggers do not decide lineage; **PR 864 (S3):** panel readiness, none.
* **PR 838 (OD-07), PR 845 (OD-12):** add correction history a lineage rule must treat as such; B2's slot is a natural key for OD-07.
* **PR 854 (OD-26):** reorders numbered heats of the live order; contest identity must not depend on heat numbers.
* Slots reserved for B: `20270301160000` to `169000`.
