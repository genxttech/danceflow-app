# Option C: withdrawal from heats that have not started (design only)

Status: DESIGN FOR REVIEW. No SQL or application change is made or authorized. Nothing here is executed or tested.
Authority: owner decision of 2026-11-26, items 8-15 (`governance/audit/OWNER-DECISIONS.md` section 14, PR 795, `3515c5524`).
Policy label: **everything proposed here is DanceFlow Studio/Custom policy**, not a governing-body requirement or compliance claim.
Read at: live line `49dbaee1b`; Option A as draft PR 877 (`5a8c5456`) and draft PR 878. Both are unapplied and may change.

## 1. Summary

- Option A blocks whole-entry Scratch and withdrawal once any heat of the entry is active, completed, danced or disqualified.
- The default schedule planner puts one entry into a separate heat for each dance in `individual` and `choose_count` divisions (`individual` is also the fallback). Today one of those dances cannot be withdrawn on its own: before any heat starts only the whole entry can be scratched, and afterwards a skipped dance can only end in a No-show.
- **Minimum viable C (recommended): a per-heat withdrawal and reinstatement writer for heats that have not started (section 6), the existing A6 workflow for callback Finals, and a small advance-withdrawal notice for a Final whose callback result is not yet approved (section 5).**
- **Impairment: material for per-dance divisions with more than one dance** (and for any later round not built from a callback result), where advance word about one heat cannot be recorded truthfully. Not material for divisions that run once per round with a callback Final, if the conditions in section 5.3 hold.

## 2. Facts the design rests on (read from code, not executed)

| # | Fact | Source |
| --- | --- | --- |
| F1 | An entry belongs to one division. A competitor in several divisions or contests holds several entries; those whose own heats have not started can still be scratched whole under Option A. | `event_competition_entries.division_id`; S6 refusal is per entry |
| F2 | The planner builds one run unit per dance for `individual` and `choose_count`, and the 10D writer allows one entry in several heats of a round when their music differs. | `floorPlanner.ts` run units; `20261111090000` "placed twice in the same round" check |
| F3 | DanceFlow calculation needs one heat per entry per round (ordinal engine: one heat per run; callback tally: one dance, and V16). A round split into several dance heats can be run but not calculated here. | `studioOrdinalMajority.ts` V11; callback tally spec |
| F4 | A6: two-person withdrawal of an advanced couple from a callback Final. Refused once the Final or any of its heats is staging, active or complete; with ballots; with a non-open lock; during a blocked correction; or if fewer than two eligible couples would remain. The reason must be substantive: 20-500 characters, at least four words of which three differ. Append-only request and withdrawal rows; reinstatement has its own preconditions. | `20270120095000`; `_cf1_reason_is_substantive` |
| F5 | A6 needs an approved callback result (or an applied advancement). Before that a request is refused (`COMP_WITHDRAWAL_NO_APPROVED_RESULT`). A pending request goes stale if the advancement or approved version changes before the co-signature. | A6 precheck and staleness check |
| F6 | The day-of console, its No-show actions, A6 and the Final pages require `COMPETITION_FINALS_ENABLED`. With the flag off those pages do not exist. | `finalsGate.ts`; `day-of/page.tsx`, `day-of/actions.ts` |
| F7 | No-show: per heat entry; only while the round is active and the heat active or complete; manager or chair with a verified email; reason; append-only with void. It does not change the heat-entry status. | `20270115090000` |
| F8 | Results exclude an entry as `scratched` only when all its heat entries in that round are scratched; ballots and heat rosters omit scratched and no-show placements. | `_compf2_evidence`, E2 readers |
| F9 | U18-S accepts a client heat-entry scratch only from the lifecycle workflow (its marker, a scratched or withdrawn parent and an audit row). Owner-run `SECURITY DEFINER` writers are exempt (A6 uses this). | `20270215094000` |
| F10 | The R2 `locked` class ignores a scratched placement in an active or complete heat. Its `certified` class, and the refusal for a locked or certified heat (June body and S6), still count scratched placements. | `_r2_entry_participation_class`; lifecycle RPC |

## 3. Four outcomes that stay distinct (requirement 12)

| Outcome | Scope | When | Writer | Entry status |
| --- | --- | --- | --- | --- |
| Scratch / withdrawal (whole entry) | entry | before any heat starts | lifecycle RPC | scratched / withdrawn |
| Withdrawal from one heat (A6 for callback Finals; section 6 if built) | one not-started heat | before that heat is staging | A6 / new writer | unchanged |
| No-show | one heat entry | heat active or complete, couple absent | NS1 | unchanged |
| Excluded (organizer decision) | round ranking | two-person CF1 A5 | A5 | unchanged |
| Disqualified | stored status only; no DanceFlow writer (OD-20) | n/a | none | n/a |

A notice (section 5.1) is none of these: it is information, and it changes no ranking.

## 4. Entry status and heat participation (requirement 9)

Entry status answers "is this registration still in the competition". Participation is per heat: the heat-entry status plus the append-only records that explain it (lifecycle audit, A6 rows, no-show rows, exclusions). A withdrawal from a later heat never rewrites the entry, an earlier heat entry, a ballot, a placement or attendance.

## 5. Minimum viable design

Three parts: the per-heat writer (section 6, needed because of F2), A6 as it exists, and the notice below.

### 5.1 Advance-withdrawal notice (new, small; not built)

Needed only for a callback Final before its result is approved: no Final heat entry exists yet, so neither A6 nor the writer can act.

- Append-only table, proposed `event_competition_withdrawal_notices`: event, entry, division, target round, reason (3-500), how and when notice was received, recorded_by, request id (unique), created_at. A second table records closure: acted (referencing the **completed** A6 withdrawal row, never a mere request), retracted, or lapsed, with actor and reason. No update or delete.
- One definer writer for each table. Managers of the event with a verified email. `SELECT` for authenticated users, limited to event managers by row security; no insert, update or delete grants.
- Effect: **none** on entry, heat entry, ballot, ranking, advancement, schedule or money. The Registrations page (and the Final page and day-of console when the flag is on) shows "Withdrawal notice received" beside the couple. A notice never triggers A6 by itself.
- It never appears in results and is never worded as a No-show.

### 5.2 Procedure

1. Other entries not yet started: scratch them whole (F1).
2. One heat of an entry that keeps other heats (before or after any has started), not a callback Final: the per-heat writer, before that heat is staging.
3. Callback Final, result approved, not staging: request and co-sign A6. If the advancement is applied between request and co-signature, request again (F5).
4. Callback result not yet approved: record the notice, then step 3 after approval. Do not stage the Final while an open notice has no completed A6 decision (procedure only).
5. A couple absent when its heat runs, with no earlier notice: No-show.

### 5.3 Does the absence of C materially impair initial operations?

| Format | Without any C work |
| --- | --- |
| Per-dance divisions with two or more dances (F2) | **Yes.** Advance word that one dance will be skipped cannot be recorded, whether or not an earlier dance has started: a whole-entry scratch removes every dance and is only allowed before any heat starts, so the skipped dance can only become a No-show when it runs. This fails requirement 10 and conflicts with Option A requirement 4. |
| A later round not built from a callback result (A6 requires a preliminary `promote_callback` source round) | **Yes, if such rounds are used.** Only a No-show once the heat runs. |
| One heat per round with a callback Final | No, if the finals flag is on (F6), two authorized people can co-sign, and staff submit A6 between approval and staging. Advance word before approval is held by hand. |
| Entries with a single heat | No: there is no later heat, and the whole entry can be scratched until that heat starts or is locked. |

Whether initial Studio/Custom events will use per-dance divisions with several dances is an owner and product fact this design does not establish. If they will not, the notice alone (or nothing) is enough for launch.

### 5.4 Cases where the record stays a No-show or nothing, even with this design

| Case | Why |
| --- | --- |
| Withdrawal would leave a Final with fewer than two eligible couples | OD-21 minimum; refused. How a one-couple Final then scores is **not verified** |
| Notice arrives once the heat is staging | treated as committed (OD-26) |
| No A6 co-signer available before staging | two-person rule |
| Leaving partway through one heat that holds several dances | no heat-level mechanism helps; R-08 item 4 stays open |
| Finals flag off | no No-show, A6 or day-of page; how heats then start is **not verified** |

Recording nothing is not a workable substitute where ballots are collected: an absent couple stays on the judges' list until it is scratched or marked No-show. In these cases a later No-show can follow advance notice; a notice preserves that history beside it but does not change the label.

## 6. Per-heat withdrawal writer (part of the minimum; not built)

`withdraw_competition_heat_entry(p_heat_entry_id, p_reason, p_request_id)` and a matching reinstatement function, `SECURITY DEFINER`, authenticated only.

- **Authority:** event managers (`can_manage_event_competition`, which includes organizer staff) with verified email. Whether OD-26's "explicit event-level scheduling permission" should apply instead is an owner decision. Judges and scorers never.
- **Preconditions (before and again under lock):** the entry is pending, confirmed or waitlisted; **the entry keeps at least one other placement that is not scratched**, started or not (so this writer cannot empty an entry; leaving every heat is the whole-entry lifecycle, or A6); heat entry scheduled or checked in; heat `scheduled` and lock open; round not `ballots_locked`, complete or cancelled; no ballot for the heat; no calculated, approved or published result for the round; not a CF1 callback Final (A6 owns those); a Final keeps at least two eligible couples.
- **Writes:** one append-only row in `event_competition_heat_withdrawals` (event, heat, heat entry, entry, dances of the heat, prior status, reason, actor, role, request id), then that heat entry to `scratched`. The entry row and entry dances are not updated.
- **No silent return:** a guard, like the A6 guard, refuses placing the entry again for those dances of that round, in any schedule version, unless reinstated, and the planner must say why.
- **Why `scratched`:** engines, ballots, F8 and F10 already handle it with no scoring change. Consequence: where it is the entry's only heat in a round, results label the couple "scratched" for that round. A separate status or wording needs engine and recompute work; owner decision.
- **Idempotency:** same actor, target and reason under the same request id returns the stored row; any other reuse is refused.
- **Reinstatement:** only while the same heat, round, ballot and result preconditions hold; restores the recorded prior status; its own append-only row. Without it a mistaken withdrawal would have no repair.

### 6.1 Concurrency

Ballot submission takes only a round `FOR SHARE` lock, with no event or heat lock, so the writer must lock the **round `FOR UPDATE`** or a ballot can land after its "no ballot" check. Proposed order: event lock (as A6 and O1), the heat `FOR SHARE` (conflicts with start and lock transitions), the round `FOR UPDATE`, the entry `FOR SHARE` (as A6, so a concurrent whole-entry change cannot pass the status check), the heat entry `FOR UPDATE`; re-check under lock. Heat then round matches the floor advance; No-show locks the round only. The order must be reviewed and race-tested before any SQL is written.

## 7. Effects (requirement 11)

| Area | Notice (5.1) | A6 (existing) | Per-heat writer (6) |
| --- | --- | --- | --- |
| Future heat assignments | none | existing Final heat entry scratched; apply inserts none for a withdrawn couple | that heat only; other heats unchanged |
| Callbacks / advancement | none | no replacement (OD-18/OD-21) | callback target unchanged; behaviour when the pool is at or below the target is **not verified**; a withdrawn pre-start callback couple cannot advance |
| Multi-dance scoring | none | all dances of the Final heat | the dances of that heat only; split rounds are not calculable here (F3); no withdrawal of one dance inside a shared heat |
| Minimum couples | none | refuses below two | refuses below two for a Final; no rule proposed for callback rounds |
| Schedule publication | shown as a flag | roster change on a published version as today | status-only change is allowed by the 10D guard; the couple leaves the floor list, so show "Withdrawn (this heat)"; OD-26 version history applies to reordering, not to this |
| Ballots | none | refused once ballots exist | refused once the heat has a ballot; R-08 stale-ballot rule is then not reached |
| Eligibility | none | reinstatement re-checks it | unchanged; withdrawal needs no clearance |

## 8. Refunds (requirement 13)

- Nothing is automatic: no refund, credit restore, fee change or reversal of participation, for a notice, A6 or section 6.
- Allocations are per order item (entry), not per heat. Show staff a read-only breakdown (heats danced, withdrawn, remaining); any amount stays a manual R2 refund with a reason.
- A partly danced entry is `locked` in R2 terms. A refund request with the scratch box raises the official-decision exception and does not scratch.
- **Finding to resolve under Option A, independent of C:** the exception resolution `withdrawn_after_unlock` requires the entry to be withdrawn or scratched. With a started or finished heat Option A forbids that, so the resolution is unreachable for such entries (it remains usable for a locked heat that never ran, after unlock). Officials must use `keep_entry` or another resolution; wording and options need review.
- Whether a partial refund is owed is organizer policy. DanceFlow proposes no formula, and no rule book requirement is claimed.

**Other open findings under Option A** (from the independent review; not fixed by this design):

- The refund page still offers "Request scratch (official decision required)" for started or danced entries. By reading, it raises an exception and scratches nothing. The owner should say whether that counts as offering a withdrawal.
- A leftover scheduled placement of an already scratched or withdrawn entry cannot be cleared in the app. Draft PR 878 stops offering "Mark no-show" on it (a withdrawal is not a No-show), so a heat holding one needs a correction before its ballots can complete.

## 9. Authorization, audit, rollback, tests (requirement 14)

- **Audit:** append-only tables with delete and update protection (as `protect_competition_history_evidence`), actor, role, reason, time, request id. No medical detail is required or invited.
- **Rollback:** app first, then SQL. The SQL rollback refuses once any notice or withdrawal row exists, as A6 does; evidence is never dropped.
- **Negative tests (not written):** non-manager, judge, scorer, other studio, anonymous and service role; unverified email; replay and reused request id; heat staging, active, complete, cancelled, locked, certified; ballot present; approved or published result; callback Final sent to the new writer; the entry's only unscratched placement; calculated result; Final dropping below two; replanning a withdrawn dance; reinstatement after staging or a ballot; concurrent heat start, heat lock, ballot submit, no-show, whole-entry scratch and A6 co-sign; entry status and other heats unchanged byte for byte; no refund, order or registration change; U18-S direct writes still refused; notice changes no ranking or ballot list; results never show a notice as a No-show.

## 10. Coordination (requirement 15)

| Item | Effect on this design |
| --- | --- |
| OD-07 corrections | Nothing here edits a completed round; completed participation is corrected only through the OD-07 workflow. |
| OD-08 | The NDCA last-place treatment is a future NDCA profile only; no Studio placement is invented. |
| OD-21 | Two-couple Final minimum and no backfill preserved. |
| OD-26 | Only not-started heats; staging treated as committed; permission model open. |
| R-08 | Scratch and No-show stay excluded and never placed last; per-dance scope still open. |
| R-12 | Exclusion stays two-person and separate; refund-driven withdrawal never touches danced entries; publication holds unchanged. |
| Guards | U18 and U18-S: new writers are definer-owned, client writes stay refused. OD-17: scratching is exempt. S4/S5 act on placement, not removal (to confirm by execution). S6: entry status never written. A6 guard: untouched because callback Finals are refused. 10D: status-only change. |

## 11. Rule sources consulted

Files matched the SHA-256 in `governing-body-source-registry.md` and the cited passages were read from text extraction on 2026-11-26. Other passages and bodies' supporting policies were **not** reviewed; absence below means a keyword search found nothing, not that no rule exists.

| Body, edition | Section | Substance (paraphrased) | Treatment |
| --- | --- | --- | --- |
| NDCA Rule Book, June 2026 (`d1b73e1f…`) | III.D.30 | After a final begins, a couple forced out by injury or illness is placed last in dances not danced. | Not implemented; future NDCA profile (OD-08). July 2026 edition not compared. |
| same | III.D.31 | Chairman may replace a couple withdrawing between rounds, at discretion. | Not implemented (OD-21). |
| UCWDC Couples, 2026 v1-26-2026 (`8a45ee58…`) | section P (Competitor Check-in and Staging), item 3.a | Failing to report or answer calls for a heat disqualifies from that dance category. | Not implemented; a Studio No-show is not this. How it treats advance notice: not established. |
| UCWDC Teams, 2026 v1-26-2026 (`7e71fdce…`) | check-in and staging section, item 2.a (R-08 cites II.O.2.a) | Failing to report or answer calls for a heat leads to being "scratched (disqualified)" from that dance category. | Not implemented. The text joins two words Studio keeps distinct; a future profile must not reuse the Studio Scratch for it. |
| WSDC Registry Event Rules, 2026.1C (`140caae7…`) | none found | No withdrawal clause located by keyword search. | Nothing claimed. |

Section numbering follows the audit's citations; page numbers and effective dates beyond the edition labels were not re-checked.

## 12. Owner decisions needed before any build

1. Will initial Studio/Custom events use per-dance divisions with several dances? This decides whether the writer is needed for launch (5.3).
2. Build the minimum (writer with reinstatement, notice, A6 procedure)? Recommendation: all three if the answer to 1 is yes; otherwise the notice only.
3. Writer permission: all event managers, or an explicit scheduling permission (OD-26)?
4. Accept the "scratched" label for a heat withdrawal, or require separate wording and the engine work it needs?
5. Accept No-show in the cases of 5.4? This is where Option A requirement 4 cannot be fully met.
6. The two open Option A findings and the refund resolution finding in section 8.

## 13. Unverified and review

No SQL, test or UI walkthrough was run for this design. Not established: which formats initial events will use; whether the UI permits a hand-built later round; a one-couple Final after a No-show; callback behaviour when the pool shrinks to the target; lock-order safety; S4/S5 behaviour on a heat-entry scratch.

Independent read-only review: the first draft's impairment conclusion was wrong (it missed per-dance heats) with errors about A6, the finals flag and locking; the second draft's writer precondition refused a skipped dance before any heat had started. This version addresses those findings.
