# Option C: withdrawal from heats that have not started (design only)

Status: DESIGN FOR REVIEW. No SQL or application change is made or authorized. Nothing here is executed or tested.
Authority: owner decisions of 2026-11-26 in `governance/audit/OWNER-DECISIONS.md` (PR 795): section 14 items 8-15 (`3515c5524`) and section 15 requirements 6-8 on ballots (`2190ec923`); section 16 on approvers of replacement or corrected results (`cb13176ad`). Ballot facts also rest on `BALLOT-ENFORCEMENT-VERIFICATION.md` (`dee85d066`; read from code, nothing executed).
Policy label: **everything proposed here is DanceFlow Studio/Custom policy**, not a governing-body requirement or compliance claim.
Read at: live line `49dbaee1b`; Option A as draft PR 877 (`5a8c5456`) and draft PR 878. Both are unapplied and may change.

## 1. Summary

- Option A blocks whole-entry Scratch and withdrawal once any heat of the entry is active, completed, danced or disqualified.
- The default schedule planner puts one entry into a separate heat for each dance in `individual` and `choose_count` divisions (`individual` is also the fallback). Today one of those dances cannot be withdrawn on its own: before any heat starts only the whole entry can be scratched, and afterwards a skipped dance can only end in a No-show.
- **Minimum viable C (recommended): a per-heat withdrawal and reinstatement writer for heats that have not started (section 6), the existing A6 workflow for callback Finals, and a small advance-withdrawal notice for a Final whose callback result is not yet approved (section 5).**
- **Impairment: material for per-dance divisions with more than one dance** (and for any later round not built from a callback result), where advance word about one heat cannot be recorded truthfully. Not material for divisions that run once per round with a callback Final, if the conditions in section 5.3 hold.

- Once affected ballots exist, ordinary Scratch and withdrawal are to be blocked (section 15; **not yet enforced** by drafts 877 or 878). Section 6A designs the only proposed way through before a heat starts: a two-person exception that preserves every ballot.

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
- **Preconditions (before and again under lock):** the entry is pending, confirmed or waitlisted; **the entry keeps at least one other placement that is not scratched, in a non-cancelled heat of the same live (published) schedule version** (superseded and draft copies never count), started or not (so this writer cannot empty an entry; leaving every heat is the whole-entry lifecycle, or A6); heat entry scheduled or checked in; heat `scheduled` and lock open; round not `ballots_locked`, complete or cancelled; **no affected ballot** under the round-wide test of section 6A (a ballot anywhere in the round counts, not only on that heat); with affected ballots only the section 6A exception may proceed; no calculated, approved or published result for the round; not a CF1 callback Final (A6 owns those); a Final keeps at least two eligible couples.
- **Writes:** one append-only row in `event_competition_heat_withdrawals` (event, heat, heat entry, entry, dances of the heat, prior status, reason, actor, role, request id), then that heat entry to `scratched`. The entry row and entry dances are not updated.
- **No silent return:** a guard, like the A6 guard, refuses placing the entry again for those dances of that round, in any schedule version, unless reinstated, and the planner must say why. Schedule versions hold their own copies of placements, so a draft copied before the withdrawal could bring the dance back: publishing must also refuse, or scratch, a copy of a withdrawn placement.
- **Why `scratched`:** engines, ballots, F8 and F10 already handle it with no scoring change. Consequence: where it is the entry's only heat in a round, results label the couple "scratched" for that round. A separate status or wording needs engine and recompute work; owner decision.
- **Idempotency:** same actor, target and reason under the same request id returns the stored row; any other reuse is refused.
- **Reinstatement:** only while the same heat, round, ballot and result preconditions hold; restores the recorded prior status; its own append-only row. Without it a mistaken withdrawal would have no repair.

### 6.1 Concurrency

Ballot submission takes the round `FOR SHARE` and no event or heat lock, so the writer must hold a conflicting **round** lock or a ballot can land after its "no affected ballot" check. No single waiting order is safe against the existing writers: heat reopen takes the heat and then the round, while A6, results and advancement take the round first, and the floor advance takes the event lock and heats with no explicit round row lock. Proposed order (shared with the PR 856 ballot-rule design): event lock; the heats `FOR SHARE` in id order (all heats of every entry the transaction covers, before any round lock); affected rounds `FOR NO KEY UPDATE NOWAIT` in id order; the entry `FOR NO KEY UPDATE` (self-conflicting, so two one-heat withdrawals cannot each see the other's placement and empty the entry); the heat entry `FOR UPDATE`; then re-check in a new statement. A busy round refuses and the caller retries. By reading only; it must be reviewed and race-tested before any SQL.

## 6A. Controlled exception: withdrawal before the start, after ballots exist (section 15, requirement 6)

DanceFlow Studio/Custom policy. Not built. Ballots can be filed while heats are still `scheduled`, and today there is no recovery before the start: exclusion needs a danced heat and No-show an active or complete one.

### 6A.1 When it applies

- The scope being withdrawn has **affected ballots** (any version or source; drafts do not count). **Whole entry:** a ballot in a round where the entry is placed, a ballot in any round that marks it, or a ballot on a heat where it is placed. **One heat H of round R** (section 6): a ballot in R, a ballot on H, or a ballot marking the entry **that belongs to R**; marks from an earlier round, such as a semifinal, do not block. "Placed" is an unscratched placement in a heat of any status or lock. Two kinds of heat are excluded **only while the heat itself carries no ballot**: a heat of an existing schedule version whose status is `draft` (version-less heats count), and a heat cancelled by an advancement revocation (for a revoked Final there must also be no mark for the entry). **The draft exclusion is safe only if returning a published order to draft, and moving its heats, are refused once ballots exist**, because round-level callback ballots sit on no heat; that draft guard is proposed in the PR 856 ballot-rule design's own migration (`84a6f9adc`; not written or executed, not re-reviewed). Without it draft placements must count. The database test belongs to the PR 877 / 856 work, which starts from the verification's section B.
- **Pre-start:** every affected heat is `scheduled` or `staging` with lock open, and the Option A block does not apply (whole entry) or the section 6 conditions other than the ballot test hold (one heat). Whether `staging` qualifies is an owner question.
- **Candidate rounds**, whether or not they have a ballot yet, are: for a whole entry, every round where it is placed or marked; for one heat, round R and the round of any ballot on H (an earlier round that only marks the entry is not a candidate); **affected rounds** are the candidates with ballots on file under the test above. All candidates are locked before testing, so a first ballot cannot slip in. Every affected round is `active` with **no calculated, approved or published result**; every other candidate has no result and no started heat. Ballot lock requires every ballot heat to have been danced and calculation requires locked ballots, so a locked or calculated round is not a pre-start case. Anything later belongs to the OD-07 correction workflow or the existing reopen action, never to this exception.
- Callback Finals stay with A6, which refuses once the Final has ballots. Extending this exception to them is not proposed.

### 6A.2 Refused even with approval

| Situation | Why |
| --- | --- |
| Removing the entry empties a ballot heat | its ballots leave the evidence **without** being flagged stale |
| A callback round's remaining couples would be at or below the callback target | the round becomes "not danced" and every ballot is ignored |
| A Final would keep fewer than two available couples | OD-21 |
| Any affected heat has started, finished or is locked or certified | Option A; correction workflows only |
| A judge who holds an affected ballot is no longer active and assigned, or is recorded absent | that ballot could never be replaced and the round could never lock |

### 6A.3 Two steps, two people

1. **Request.** An event manager with a verified email records scope, a substantive reason (as A6: 20-500 characters), how and when the withdrawal was received (may reference a 5.1 notice) and a request id. The request snapshots the affected rounds, heats, current ballot ids and each round's input hash (stored for the stale check; judge identities are not shown, see Confidentiality). It changes nothing.
2. **Decision.** An approver approves or refuses with a reason. Approval re-checks everything under lock and refuses if the snapshot changed (a new or replaced ballot, a heat change), so a stale request must be made again.

**Who may approve.** Section 16 decides who may approve a **replacement or corrected result**. A withdrawal before the start has no result, so **whether section 16 binds this exception is an owner question**. This design proposes to apply it:

- An active user with a verified email holding an appropriate authorized event-level role: the designated chair, or a **separate authorized scorer or official** given an exception-approval designation. A second studio manager is neither required nor sufficient, and a one-manager Studio stays workable when such a separate official exists. The appointment or designation is recorded immutably **before the request**. Whether an appointment made by the requester disqualifies is an owner question: today only managers appoint officials, so disqualifying it would leave a one-manager Studio with no approver.
- **Barred (section 16, which speaks of the result being approved):** whoever calculated that result, opened the associated correction, cancelled the superseded round as part of the replacement, or entered, transcribed or modified a ballot contributing to it, judged over the relevant result lineage. Ballots in unrelated rounds or competitions do not disqualify.
- **Barred (DanceFlow's wider application to this exception):** the same four acts for **any** result, correction or **ballot version** anywhere in the affected rounds or their lineage.
- **Barred (further DanceFlow proposals, not required by section 16; together with the bars above they can leave nobody):** the requester; any judge on the panel of an affected round, whether or not they have submitted (the chair too, whenever on a panel); whoever verified an affected ballot; a participant in, or recorded representative of, the withdrawing entry. The approver may not later enter or verify a replacement ballot for those rounds.
- Independence is decided **by user from immutable server-recorded actors** (ballot submission, result and round-transition events), so a later role change or deactivation removes nothing. Lineage is reliably recorded only in part today (the B2 design is not built): **unknown lineage refuses**.
- With no qualified independent approver the request waits, and the screen records and states that operational limitation. There is no override, and the R-11 initial-approval self-approval exception never applies.

The exception-approval designation, an approval right for a non-manager, and the lineage history do not exist in code; all must be designed. Conflict and recusal records do not exist (OD-05), so interests beyond recorded links cannot be enforced.

### 6A.4 What approval does

One definer transaction, owner-run internal writer, no client execute grant and no client-settable bypass marker. Under the section 6.1 locks it first re-checks the snapshot and approver, and confirms that **every judge holding an affected ballot is active, assigned and not recorded absent**. Then, in this order:

1. **Writes the decision row first**, bound to this transaction and to the exact entry and placements it covers, with actor, authority relied on, reason, time and snapshot.
2. Changes status **to scratched only**, on those placements (for a whole entry also the entry status with its lifecycle audit row). The ordinary ballot guard in the PR 856 design refuses this; its exception hook, which returns false today, is redefined to allow it **only** for a decision row written in the same transaction naming that entry and placement. On approval the hook never allows a delete, a move between heats or an un-scratch; only a reversal (below) restores, under its own decision row.
3. Appends the section 6 withdrawal row for each placement (whole-entry scope too) and puts the no-silent-return guard on them: a restored placement would silently make the original ballots valid again. Refusing a direct un-scratch depends on U18-S, which is applied on the hosted databases but not yet merged into this line.

It **never** updates, deletes, renumbers or re-derives a ballot or mark.

**Invalidation and correction.** The existing round blockers then treat a current ballot that ranks the entry (or a callback ballot that selected it) as stale, and ballot lock is refused until each such judge submits a **new version**; the old one remains. Marks are never closed up automatically. Under OD-11 only the judge can confirm replacement marks, and a paper replacement needs independent verification (OD-12). **Neither is implemented, and this exception must not be activated until both are**: today a scorer's paper entry could stand in for the judge. Callback ballots that did not select the entry stay valid although the pool shrank; whether those judges must re-confirm is an owner question.

**Confidentiality (OD-10).** In a callback round a ballot is stale exactly when it selected the couple, so naming stale judges discloses marks. The request and decision views therefore show only the affected rounds and heats and the number of ballots on file, never which judges are affected or how many would become stale. This does not make marks secret today: managers can already read ballots and marks, and the lock blockers list stale ballots to them afterwards. Closing that is OD-10 work, not designed here.

**Mistakes and recovery.** A reversal restores the recorded prior status, so the original ballots apply again. It needs the same request and independent approval. Its writer is this exception's own, not the section 6 reinstatement (which refuses once ballots are affected): it first writes a **reversal decision row** bound to that transaction, the entry and the named placements, and only that row lets those placements (and the entry status) return to **exactly the recorded prior status** and releases their no-silent-return guard. Its preconditions: **no ballot of any kind filed or replaced in an affected round since the approval**; every affected heat still not started and unlocked; every affected round `active` with no result; and **the entry still available** (registration, payment or refund state and eligibility), so a reversal cannot revive a cancelled registration. It does **not** require the affected judges to be available. **Unsolved, to be covered by one audited recovery design (jointly with the PR 856 design) before any SQL for the ordinary ballot block or this exception:** (a) any state in which a stale ballot cannot be replaced and reversal is unavailable, for example a judge who becomes unavailable after any later ballot or after a heat has started; the round then cannot lock and the only exit is round cancellation, the bypass requirement 4 targets; (b) a placement left in a **cancelled** heat of a round with ballots, which the block counts but this exception cannot take because it needs a scheduled or staging heat.

### 6A.5 Concurrency

Ballot submit and paper entry take an advisory lock on (round, judge) and the round `FOR SHARE`; the draft lifecycle function takes neither, so a check without a round lock can be beaten in either order. **Request, decision and reversal** each use the section 6.1 order: candidate heats `FOR SHARE`, every **candidate** round `FOR NO KEY UPDATE NOWAIT` in id order, then the entry and heat entries, then a re-check in a new statement; a busy round refuses. Judge deactivation takes no round lock, so decision also locks the affected judges' official rows `FOR SHARE` after the rounds and re-checks them; the position of that lock in the order needs the same review. Deadlock and race behaviour must be tested before SQL.

### 6A.6 Refunds and other writers

A refund, cancellation or payment failure is not an ordinary Scratch and must not become a way round the block. Intended outcome (shared with the PR 856 design): the money or registration action completes; participation stays unchanged where affected ballots exist; an exception is recorded; and the affected rounds are held at ballot lock and every later step until it is resolved, since holding publication alone would let lock, calculation, approval and advancement proceed with the refunded couple. **None of this is designed:** there is no exception kind, recorder, resolution, round hold or retry for a busy round (a momentary judge save must not become a permanent exception), and the existing refund exception records nothing for an unstarted heat. **Neither the ordinary ballot block nor this exception can ship before it is designed jointly and shipped with the block.** Who closes an exception, and whether a financial-only case holds rounds, are owner questions.

**Routes that hide ballots** (newer publication, round cancellation, replacement round, direct heat cancellation, return to draft, heat move or delete) are **not** covered by PR 877, which has no ballot SQL. The PR 856 design proposes a draft guard for return to draft and heat moves, leaves server publication needing a guard, and relies on PR 899 (unexecuted) for some client writes. Each route needs one named owner (not yet assigned), and every one, PR 899 included, is an activation gate.

### 6A.7 Negative tests (not written)

A judge deactivated or absent at decision time; restoring a scratched placement without a reversal; reversal after any later ballot, after a heat start or with a result; reversal allowed while the affected judge is unavailable and no later ballot exists; a scorer substituting for a judge; approver designated after the request; requester approving; each section 16 bar, across several ballot contributors and old versions; role change or deactivation after acting; ballots in unrelated rounds not disqualifying; cancel-and-replace not clearing history; one manager plus a separate scorer succeeding; unknown lineage refused; hook refusing a delete, move, un-scratch, another transaction or an unnamed placement; reversal of a refunded or ineligible entry; cancelled-heat placement; panel judge (with or without a ballot), transcriber, verifier, participant or undesignated second manager approving; approver without an authorized event-level role or designation; reversal under another transaction, for an unnamed placement or to a status other than the recorded one; one-heat exception allowed when an earlier completed round marks the entry; ballot submitted, replaced or paper-entered between request and decision and concurrently with it; heat started or locked between the two; locked round; calculated, approved or published result; emptied heat; callback pool at the target; Final below two; unaffected heats and divisions left alone; ordinary Scratch, direct writes, refund and registration sync still refused; every ballot and mark byte-identical afterwards; lock refused until each stale ballot is replaced; replay and reused request id; refused request changes nothing.

### 6A.8 Proposed ship order (agreed by the PR 856 design's author on 2026-11-26 with step 6 made conditional; its own edits are pending)

1. U18-S merged into the release line; then the PR 877 guard.
2. Design the recovery (6A.4) and the refund and registration handling (6A.6).
3. In one migration: the PR 856 predicate, ordinary guard (hook returning false), draft guard, that refund handling and the recovery's exit for cancelled-heat placements; named owners for the other hiding routes.
4. The section 6 withdrawal table and no-silent-return guard (required here even if the one-heat writer is not built).
5. OD-11 judge confirmation and OD-12 verification.
6. The exception-approval designation (6A.3). **Conditional:** B2 result lineage and actor history, a prerequisite only if the owner applies section 16, or the wider lineage-based bars of 6A.3, to this exception (open owner question 11).
7. This exception: its tables, writer, reversal and hook redefinition, with the stranded-round recovery. The ordinary guard's rollback must refuse while the hook is redefined.

Whether step 3 may ship before step 7 is an owner question. Slots are allocated by the coordinator; none is proposed here.

## 7. Effects (requirement 11)

| Area | Notice (5.1) | A6 (existing) | Per-heat writer (6) |
| --- | --- | --- | --- |
| Future heat assignments | none | existing Final heat entry scratched; apply inserts none for a withdrawn couple | that heat only; other heats unchanged |
| Callbacks / advancement | none | no replacement (OD-18/OD-21) | callback target unchanged; behaviour when the pool is at or below the target is **not verified**; a withdrawn pre-start callback couple cannot advance |
| Multi-dance scoring | none | all dances of the Final heat | the dances of that heat only; split rounds are not calculable here (F3); no withdrawal of one dance inside a shared heat |
| Minimum couples | none | refuses below two | refuses below two for a Final; no rule proposed for callback rounds |
| Schedule publication | shown as a flag | roster change on a published version as today | status-only change is allowed by the 10D guard; the couple leaves the floor list, so show "Withdrawn (this heat)"; OD-26 version history applies to reordering, not to this |
| Ballots | none | refused once ballots exist | refused once an affected ballot exists; then only 6A, where R-08 stale ballots are replaced by their judges |
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
- **Negative tests (not written):** non-manager, judge, scorer, other studio, anonymous and service role; unverified email; replay and reused request id; heat staging, active, complete, cancelled, locked, certified; ballot present; approved or published result; callback Final sent to the new writer; the entry's only unscratched placement; two concurrent one-heat withdrawals trying to empty an entry; one-heat withdrawal allowed with ballots only in an earlier round; busy round refuses; calculated result; Final dropping below two; replanning a withdrawn dance; reinstatement after staging or a ballot; concurrent heat start, heat lock, ballot submit, no-show, whole-entry scratch and A6 co-sign; entry status and other heats unchanged byte for byte; no refund, order or registration change; U18-S direct writes still refused; notice changes no ranking or ballot list; results never show a notice as a No-show.

## 10. Coordination (requirement 15)

| Item | Effect on this design |
| --- | --- |
| OD-11 and OD-12 | Replacement ballots after a 6A approval need the judge's confirmation, and paper entry independent verification; neither is implemented. |
| R-11 | Its self-approval exception covers initial result approval only, never a 6A decision. |
| Section 16 (B2 Question 8) | Applied to 6A as a proposal (6A.3); whether it binds is open. |
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
7. Is a No-show acceptable while ballots exist? It removes the couple today with no ballot check once the heat is active, and needs the judges to resubmit.
8. How should refund exceptions behave when ballots exist (6A.6)?
9. Who may approve a 6A exception, and must it exist before any ordinary ballot block ships? Without it a balloted couple cannot be removed until the heat starts. It also cannot be activated before OD-11 confirmation and OD-12 verification exist, and its stranded-round recovery is unsolved.
10. May a `staging` heat use 6A, and must callback judges who did not select the couple re-confirm?
11. Does section 16 bind approval of this withdrawal exception?
12. Does an appointment made by the requester disqualify the approver?
13. Should balloted callback Finals get a pre-start exception, given A6 refuses them?
14. Are round cancellation and republication with ballots refused outright, or allowed through an audited path?

Questions about the ordinary block itself (ineligibility marking, event deletion, server-written disqualification, conservative blocks) belong to the PR 856 design.

## 13. Unverified and review

No SQL, test or UI walkthrough was run for this design. Section 6A rests on a code-reading verification; none of it is executed. By reading, a stale ballot blocks the lock regardless of its judge's attendance or status. An independent review of the first 6A draft was blocking (stranded rounds, mark disclosure, approver holes); a second pass found it not blocking and asked for the reversal preconditions now stated in 6A.4 (that wording is not re-reviewed). The stranded-round recovery (6A.4) and the refund hold (6A.6) are still undesigned. The affected-ballot scopes and lock order were later revised after the PR 856 ballot-rule design raised both; that revision is not re-reviewed. Not established: which formats initial events will use; whether the UI permits a hand-built later round; a one-couple Final after a No-show; callback behaviour when the pool shrinks to the target; lock-order safety; S4/S5 behaviour on a heat-entry scratch.

Independent read-only review: the first draft's impairment conclusion was wrong (it missed per-dance heats) with errors about A6, the finals flag and locking; the second draft's writer precondition refused a skipped dance before any heat had started. A final narrow check found the third draft not blocking and noted that superseded or draft schedule copies must not satisfy the writer precondition or restore a withdrawn dance; the wording added for that has not been re-reviewed.

Section 15 coverage across this design and PR 856: requirements 1, 6 and 7 are partial; 4 is **not met** (hiding routes and event deletion open); 3 rests on code reading; 9 has tests listed and none written; 10 is a separate verification not re-checked here. A combined independent review of both designs (2026-11-26, of `f6e89b418` and `84a6f9adc`) was blocking; this revision responds to its findings for this document and is re-reviewed only if the pull request says so. The recovery design, refund handling, route ownership and agreed ship order remain open.
