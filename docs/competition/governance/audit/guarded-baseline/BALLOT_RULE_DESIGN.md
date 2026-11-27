# Ballot rule for ordinary Scratch and withdrawal: enforcement design (documents only)

DanceFlow Studio/Custom policy (OWNER-DECISIONS.md section 15, branch `claude/comp-audit-owner-decisions` `dee85d066`). No governing-body rulebook was consulted for this document and nothing here is a body rule; the sources listed in section 11 of the Option C design (PR 908) were not re-checked.

**No ballot SQL exists. Nothing was applied, executed, merged or deployed.** Everything below is read from code at PR 877 `8c738c4d8`. Compared with: `BALLOT-ENFORCEMENT-VERIFICATION.md` (`dee85d066`), PR 908 design (`828b13c04`), PR 899 Option D (`60b4edd7e`). Names, slots and error codes are proposals.

## 1. What the code does with a round's ballots

| Fact | Where |
| --- | --- |
| Ballot ranking set: unscratched placements on non-cancelled heats of a published or live version, less No-shows and A5 exclusions | E2 `_compe2_round_heats/_heat_entries/_round_entries`; NS1; A3 |
| Ordinal majority scores one heat; a round with two ballot heats fails closed | `studioOrdinalMajority.ts` V11; readiness blocker `COMP_ORDINAL_MULTI_HEAT` (app only) |
| Callback ballots are round-level over the union of ballot heats; target at or above the eligible count means "not danced" and the ballots are ignored | `_compe2_round_blockers` |
| A heat left with no ranking entry stops being a ballot heat: its ballots leave the evidence and are **not** flagged stale | `_compe2_round_blockers`, `_compf2_evidence` |
| The result input hash lists entries and excluded entries of every current heat of the round | `_compf2_evidence` via `_compf2_round_all_heats` |
| The only engines found are ordinal and callback (none for proficiency) | `results/engines/` |
| Ballots and marks refuse update, delete and truncate (event deletion excepted), so a heat or round holding ballots cannot be deleted | `protect_*_history` triggers |
| Round cancellation and publishing a newer schedule version read no ballots | O1 `cancel_competition_round`; 10D `publish_competition_schedule_version` (`20261111090000:866`) |
| Draft orders hold copies of a round's placements; clearing or editing a draft deletes or moves them | `20261111090000:640-647`, `824-838` |
| Revoking an advancement cancels the Final heats and leaves their placements unscratched | `20270120101000:159-160` |

## 2. Predicate

Ballot = any row of `event_competition_ballots`, any version or source. Ballot drafts do not count. Do **not** build the test on `_compe2_round_*`: those drop cancelled, unpublished and excluded rows, which is how a bypass would hide ballots.

"Placed" means a heat entry whose status is not `scratched`, in a heat of any status or lock, **except** the two below, unless that heat itself carries a ballot (or, for a revoked Final, a mark for E):

- a heat of an existing schedule version whose status is `draft`: otherwise clearing or editing a draft plan would be refused whenever the round has ballots. **Allowed only with the draft guard in section 4** (callback ballots are round-level, so no heat of that round ever "carries" one); without that guard, drop this exclusion. Do not reuse `_comp10d_version_editable`: it is also true for a heat with no version or a missing version (`20261111090000:295-305`);
- a heat cancelled by an advancement revocation: otherwise a couple dropped by a correction stays "placed" and ballots on the replacement Final block it for good.

Published, live, superseded and version-less heats count.

| Scope being removed | Affected when any ballot |
| --- | --- |
| Whole entry E | (1) is in a round where E is placed; or (2) has a mark for E; or (3) is on a heat where E is placed |
| One placement of E, heat H, round R | (1) is in R; or (3) is on H; or (2) has a mark for E **and is in R** |

Rule 3 differs from rule 1 only if a heat's `round_id` changed after ballots were filed.

**Proposed change to PR 908 6A.1.** It applies "any ballot that marks the entry" to the one-heat scope too. A couple advanced from a semifinal has semifinal marks, so unscoped rule 2 would block every one-heat withdrawal in the next round, and would make an A6 Final withdrawal fail on a guard. Limit rule 2 to round R for the one-heat scope. For the whole entry, keep it across rounds.

**Scratched placements** do not count under rules 1 and 3 (ballots filed afterwards never included E; marks filed before are caught by rule 2). The verification and 908 wording does not say either way.

### Round-wide scope checked against engine behaviour

| Case | Effect of removing E | Round-wide result |
| --- | --- | --- |
| Callback, E on any ballot heat, selected or not | Eligible set shrinks; ballots that selected E go stale; the round can flip to "not danced" | Block: needed |
| Ordinal, E on the ballot heat | Every current ballot of the heat goes stale; if E was alone, ballots drop out silently | Block: needed |
| Ordinal, two heats, E alone on the other heat | An uncalculable round becomes calculable on the remaining heat | Block: needed |
| Ordinal, two heats, E one of several on the other heat | Ranking of the balloted heat unchanged; round stays uncalculable | Blocks more than needed, only in a configuration that cannot be scored |
| E is No-show or excluded in the round | Ranking set unchanged; recorded exclusion reason would change | Block: conservative |
| E placed only in a cancelled or superseded heat of the round (not an advancement revocation) | Current evidence unchanged | Block: conservative until section 5 items 3-4 exist (cancel or republish, then Scratch, is the bypass) |
| E only in a draft copy, or in a revoked Final heat, with no ballot there | None | Not blocked |
| Proficiency | No engine to verify against | Block: fail closed |
| Another round or division, no mark for E | None found | Not blocked |

Conclusion: the round-wide scope is right, with the two exceptions in "Placed". Apart from the two conservative rows, no case was found where a scorable configuration blocks because of an unrelated heat.

## 3. Serialization with ballot submit and paper entry

Both writers use `_compe2_insert_ballot`: advisory lock (round, official), then the round row `FOR SHARE`; the insert trigger `_compe2_guard_ballot_insert` takes the same `FOR SHARE`, so any inserter does. The 877 lifecycle takes heats `FOR SHARE` and the entry `FOR NO KEY UPDATE`: no conflict with either, so a check alone can be beaten in both orders.

Existing orders conflict with each other: heat reopen locks the heat `FOR UPDATE` and then waits for the round `FOR SHARE` (`20261107090000:944-946`, HL1); A5, A6, results and advancement take the round first. Floor advance takes the event lock and heats but no round row lock (PR 908 6.1 and 6A.5 say it matches a heat-then-round order). No single waiting order is safe against both. Proposed:

1. unlocked refusals (as S6 today);
2. associated heats `FOR SHARE`, id order (unchanged). A writer covering several entries (R2, sync) locks **all** heats of **all** its entries here, before any round lock;
3. affected rounds `FOR NO KEY UPDATE NOWAIT`, id order;
4. entry `FOR NO KEY UPDATE`;
5. re-check class and ballots in new statements; write.

- `NO KEY UPDATE` conflicts with the ballot `FOR SHARE` and with the other writers' `FOR UPDATE`, not with foreign-key `KEY SHARE`.
- `NOWAIT` means this path never waits on a round, so it adds no round wait edge to any cycle. By reading only; race tests must prove it.
- Busy raises a retryable `COMP_BALLOT_CHECK_BUSY` (`55P03`). Cost: a Scratch fails while a judge is saving in that round, and two Scratches in one round collide; the app retries once, then says so.
- Ballot waiting behind a Scratch: it resumes, re-reads the roster and is refused (`COMP_BALLOT_UNKNOWN_ENTRY`) if it names E. No ballot-path change needed.
- The S6 race script expects some callers to wait; with this step some get "busy". Adapt in a separately named copy.
- **For PR 908 6A.5:** use the same order, `NO KEY UPDATE`, and `NOWAIT` instead of waiting `FOR UPDATE`. A one-placement writer also takes the entry `FOR NO KEY UPDATE`, not `FOR SHARE`: otherwise two withdrawals in different rounds can each pass "keeps another placement" and empty the entry. PR 908 (`01c28f036`) reports both adopted.
- Why the multi-entry order matters: a writer that keeps one entry's round lock while waiting for the next entry's heat can deadlock with a reopen that holds that heat and waits for the round.
- Residual: a new placement of E added to a further round while the Scratch is running is not locked in step 3. The guard (section 4) catches it only if the placement update sees it. Placing a scratched entry is not guarded today.

## 4. Where to enforce

One internal predicate (definer, no client execute) and one backstop guard that fires for **every** writer, owner-run functions included:

| Guard | Fires on | Scope |
| --- | --- | --- |
| heat entries | status to `scratched`; change of heat, entry or event; delete. Only where the old placement counts as "placed" (section 2) | one placement |
| entries | status to `scratched` or `withdrawn`; delete | whole entry |
| heats (draft guard), once the round has any ballot, for a heat not in a draft version | delete; change of version (including to none) or round | the round |
| schedule versions (draft guard), once a round with heats in it has any ballot | status back to `draft`; delete of a version that is not a draft | those rounds |

The draft guard is what keeps a published placement from being turned into an excluded draft one and then scratched; it ships with the predicate and does not rely on Option D. When a heat is deleted its placements cascade after the heat row is gone, so the heat guard must decide that case and the placement guard skips a placement whose heat no longer exists.

Each locks the affected rounds (`NOWAIT`), then tests in a new statement; refusal `COMP_BALLOTS_ON_FILE`; delete is allowed only in the cascade of a deleted event. Messages name no judge, mark or count per judge (OD-10). The lifecycle RPC also checks explicitly (both before and after locking, including the repeat-call cascade) so the user gets the right refusal first.

Exception hook: the guard asks an internal function that returns false. PR 908 later redefines it to accept only a decision row written in the same transaction. No setting or marker a client can set.

**The guard cannot ship before refund and registration handling exists** (same migration), or it breaks both paths. That handling is **not designed**, and the existing exception path cannot be reused as it is:

- `_r2_record_refund_exception` returns nothing unless a heat is locked, danced or on the floor (R2 `20270103090000:615-627`), so a balloted couple in an unstarted heat would record no scope. The kinds are limited to locked and certified (R2:204), the sync records only those classes (R2:1447-1456), and an open exception affects entry availability and publication. A ballot case needs its own kind, recorder, resolution and publication rule, agreed with PR 908 6A.6.
- `participation_outcome` is stamped once and never re-applied (R2:705, 734-736). **Busy must not be treated as affected**: it would turn a momentary judge save into a permanent exception. Busy needs a pending state and something that retries it.
- The sync withdraws and scratches in one statement. It needs a per-entry loop: all heats first, then rounds, then check each entry, withdraw the unaffected ones and record the others.
- Intended outcome: the money or registration action completes; participation stays unchanged for affected couples.

A6 needs no change if the placement scope is as in section 2 (it already refuses a Final with ballots). Owners of the R2 and sync functions must agree the changes.

## 5. Coverage and remaining gaps

| Route | Covered by | Left open |
| --- | --- | --- |
| Change or delete a ballot or mark; delete its heat or round | Existing history triggers | Event deletion |
| Client changes placement columns of a published-order heat (round, status, version); client publish, unpublish, delete of a version | Option D (899; not executed; relies on U18) | Return of a published order to draft, and heat moves, are in this design's draft guard (section 4) |
| Client changes entry status | S6 (877) | Definer writers |
| Client removes a placement in a started heat; un-scratch | S6, U18-S | Placements in unstarted heats |
| 1. Ordinary Scratch or withdrawal, direct placement writes, R2, sync | **This design (section 4)** | |
| 2. Spare-round replacement | Nothing here (Option B) | Open |
| 3. Server publish of a newer version (old ballot heats drop out) | Nothing | Needs a guard |
| 4. `cancel_competition_round`, then a replacement round | Nothing | Needs a guard |
| Heat entry dances, round sequence, heat configuration, publication rows, truncate of placement tables | Nothing | Option D lists these as open; not assessed against this rule |
| Client change of `eligibility_status` (app `updateCompetitionEntryEligibilityAction`) makes a balloted couple unavailable for advancement | Nothing; S6 does not guard that column | Owner question |
| No-show with ballots (removes E from the ranking set) | Nothing, and it is not a Scratch | Owner question |

For items 3 and 4 use triggers on version and round status, **not** a text change to the publication function: Option D pins that function's body before and after.

## 6. Which change goes where

| Change | PR | Proposed slot |
| --- | --- | --- |
| Lifecycle definer and S6 guards | 877, unchanged; no ballot SQL | `20270301140000`, `141000` |
| Predicate, placement, entry and draft guards, hook, lifecycle lock step, R2 and sync handling (still to be designed, section 4) | New PR stacked on 877 | `20270301150000` |
| Version and round status guards (items 3-4) | New PR after Option D | after `170000`, e.g. `171000` |
| Error codes, preflight, offer wording, retry; refund page must not offer an ordinary Scratch | 878 | none |
| Exception request, approval, writer, hook redefinition | 908 line, later | later than `150000` |
| Spare-round replacement | Option B | its own |

No pushed branch uses `150000` or `171000` (checked in the 60 most recently updated remote branches); unpushed claims unknown. The `150000` lifecycle change must pin the 877 body. 877 alone does **not** meet section 15; public activation should wait for `150000`, items 3-4 and 878.

## 7. Tests to write (none exist)

Each refusal asserts the expected code and that ballots, marks, placements, entry, audit and refund rows are unchanged.

1. Refused with ballots: whole entry Scratch and withdrawal; repeat-call cascade; direct placement scratch, delete and move; callback couple not selected; ordinal heat mate; ordinal couple alone on a second heat; ballot on a cancelled heat; superseded version; heat moved to another round (rule 3); paper ballot; older superseded ballot version only.
2. Allowed: drafts only; ballots only in another round or division with no mark for E; advanced couple removed from one heat of an unballoted next round; placement scratched before the first ballot, then whole entry (no other affected round); A6 Final withdrawal with semifinal ballots only; reinstatement paths.
3. R2 and sync: refund and registration cancellation succeed; participation unchanged for affected couples with a resolvable ballot exception; unaffected entries of the same registration still withdrawn; busy stays pending and is applied later.
4. Planner: clear, edit and copy a draft order while the round has ballots succeed; with callback ballots, return to draft, move to no version or another version or round, and delete of a published heat or version are each refused, and Scratch stays refused afterwards; a couple in a revoked Final with no ballot there is not blocked.
5. Hook: no client can execute the predicate or hook; no setting bypasses the guard; hook returns false.
6. Races, both orders, synchronized in the database: ballot submit and paper entry against Scratch; correction against Scratch; two Scratches in one round; floor advance, heat reopen, A6 cosign, calculation and advancement against Scratch, and a multi-entry refund against a heat reopen (no deadlock; busy where expected).
7. Mutations: drop each rule, the round lock, `NOWAIT` handling and the new-statement re-check; each must fail for its named check.
8. Rollback, reapply, preflight refusal on changed pinned bodies; event deletion still works.

## 8. Owner questions

1. Until the 908 exception exists, a balloted couple cannot be removed before the heat starts. May the block ship first? (908 question 9.)
2. Should `disqualified` through a server writer also be tested? Section 15 names Scratch and withdrawal; this design tests only those.
3. No-show with ballots on file: allowed as today? (908 question 7.)
4. Round cancellation or republish with ballots: refuse outright, or an audited path?
5. Event deletion erases ballots: acceptable?
6. Accept the two conservative blocks in section 2?
7. A `staging` heat: outside the Option A block today; covered by this rule once ballots exist.
8. May a manager still mark a balloted couple ineligible?

## Review and unverified

One independent read-only review of the first draft raised eight points: the refund and sync exception path, busy handling, draft planning, a multi-entry deadlock, revoked Final placements, the eligibility bypass, floor-advance locks and the publication function reference. All are reflected above; **the revision has not been re-reviewed**. A later comment from the PR 908 author (`01c28f036`) added the draft-guard condition, the correct meaning of the editable test and the entry lock for one-placement writers; those edits are not reviewed either. The first review found no ordinary single-entry race that lets a ballot pass the round lock, apart from the residual in section 3. Its search for writers was not exhaustive.

Not verified: runtime behaviour; hosted grants and applied migrations; whether any app screen writes placements directly; A7 and U66 internals; additional row locks in A5 and A7 ballot triggers; deadlock freedom; the shape of the refund exception record.
