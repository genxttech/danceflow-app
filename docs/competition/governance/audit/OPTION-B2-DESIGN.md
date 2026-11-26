# Option B2: contest identity fixed at publication (design only)

**Status: DESIGN. No code, no migration, nothing applied, nothing executed.** DanceFlow Studio/Custom policy, not a governing-body rule. Implementation is not authorized.

**Owner decisions folded in** (PR 795, `OWNER-DECISIONS.md`): B2, design only (section 13); **Q8** independent approval (section 16, `cb13176ad`); **Q1 = option C** (section 17, `0ac792352`); **Q9** show the recorded dance and disclose, **bypass not accepted** (section 18, `364575afc`); **Q14** hide until revalidated (section 19, `2ed7d309e`). Q4 and Q6 are resolved; Q5 for relevant-round cancellers (Q11 stays open). **R-11 and B2 are BLOCKED** while the paths in section 6B stay open.

Earlier texts failed independent review three times (by reading). Review status of this text: section 14. Code claims cite `src/lib/supabase/migrations/` (short: the timestamp) or `src/`, read on `release/website-embeds` (`49dbaee1b`). **Every behavior described for B2 is unexecuted.**

## 1. What B2 must stop

Executed locally (PR 865, section 12a): from a published never-run spare heat installed by fixture, one manager published a self-approved replacement of a corrected result: spare round with the corrected round left alone (NC), cancelled (CS) or independently approved then cancelled (CA), and a spare heat moved to a new round (R). Reading shows the database planner function and publication would accept a spare round; the app planner does not create one (`src/lib/competition/floorPlanner.ts:136`, lowest-sequence round per division).

## 2. Facts the design rests on (code reading)

| Fact | Evidence |
|---|---|
| Only a **preliminary** callback round in a `promote_callback` program and a **final** can produce a result | `20270215090000` ~L223-224, 368-369; `results/engines/studioCallbackTally.ts:51` |
| Studio setup shapes a division as one Final, or one preliminary then one Final | `scoring/studioSetup.ts:36-41, 185-190` |
| Other round types exist; nothing scores or advances them | `20260620_competition_foundation_v1.sql` ~L92-93 |
| The only advancement is preliminary (n) to Final (n+1) of one division; records are insert-only | `20270120090000:100-140, 209-233, 1236` |
| Advancement appends the Final's heat into the live order, and refuses a Final holding a heat with no version or in the live one | `20270120090000:1342-1343, 1394-1408` |
| Multi-dance results cannot be calculated | `20270215090000:175-176, 244-245`; `results/engines/common.ts:298` |
| Writers of heats and heat dances: the two planner functions and the order copy write **draft** versions; advancement writes the live one | `20260621_competition_apply_heat_plan_v1.sql` (draft check); `20261111090000:560-590, 799-830`; `20270120090000:1400-1403, 1593-1596` |
| Managers can write heats and heat dances directly in drafts. For a **published** heat the existing guard already refuses inserts, deletes, moves and non-status changes of dance and entry rows (advancement exempt); status-only changes pass. Option D (draft, not applied) covers the heats and versions themselves | `20260621_competition_heat_planning_v1.sql:122-123`; `20261111090000:337-374`; `20270120090000:1522-1534` |
| `dance_id`, `dance_key`, `dance_label` on a heat are independent | `20260621_competition_heat_planning_v1.sql:85-110` |
| Dance catalog and division offerings are manager-writable; no lock at program publication was found | `20260620_competition_dance_catalog_v1.sql:7-29, 129-139` |
| A new running order cannot be published while any heat is staging, active or complete. A heat also counts as danced through an entry placement, which that guard does not read | `20270106090000:284-292`; `20270119090000:51-64` |
| Ballots lock only when every ballot heat is on the floor, finished or has a danced placement | `20270119090000:15-17` |
| The public result payload does not name the dance | `20270122090000:292-325` |
| Only a manager approves; approval certifies each locked heat through a function that also requires a manager | `20270114090000:1040`, certification loop ~L1093-1099; `set_competition_heat_lock_state` (`20260620_competition_generation_operations_v1.sql`; 10A) |
| A manager or an assigned scorer may calculate | `20270114090000:904`; `20270102090000:709-713` |
| Opening a correction and cancelling a round are manager actions. A separate pre-calculation ballot reopen also exists | `20270114090000:1177-1193`; `20270106090000:439`; `20270102090000:1248` |
| A correction is refused once a later-sequence round of the division has ballots | `20270114090000:1222` |
| A callback `judge_entry_error` correction needs a co-signer (chair or manager, not the opener) | `20270120095500:123-137, 465-530` |
| Actor history API roles cannot write or rewrite: ballot `submitted_by`; `calculated_by`; correction causes, co-signs and audit events; correction-ballot `actor`; round transition events. Officials' `user_id` is immutable | `20270102090000:82, 225-227, 890, 964-971`; `20270114090000:105, 729`; `20270120095500:97-209`; `20270106090000:176-216`; `20270101090000` `guard_competition_official` |
| History rows cannot be deleted unless the whole event is | `20261107090000` `protect_competition_history_evidence` |
| The public readers already distinguish "under review" (no rows) for a withdrawn or no longer live publication; the event list and "my results" readers omit such publications | `20270122090000:259-276, 582-665` |
| A version's evidence lists only the current ballots | `20270114090000:556-562, 620-621` |

## 3. Data model

All new tables: RLS on, no write privilege for any API role (select for managers), written only by definer functions and triggers, UPDATE / DELETE / TRUNCATE refused, history triggers ENABLE ALWAYS.

* `..._contest_slots`: event, program, division, `dance_identity`, `depth`; unique (event, division, dance identity, depth). Depth 0 is the first stage; depth n+1 exists only by advancement.
* `..._contest_slot_rounds` (the **published running-order history**): program, division, round, dance identity, `slot_id` (null = recorded but unbound), how (publication or advancement), version, actor, time. Rows are only added. A round's depth is fixed by its first bound row.
* `..._result_revalidations` (section 7).

One slot per dance, so a round holding two dances occupies two. Entries are not in the key. The tables reference only the event, so a cancelled round, or a published round later deleted from an unlocked program, **keeps counting**.

## 4. History and stage (requirements 2, 8, 9)

* **Written by the data, not by one function.** ENABLE ALWAYS triggers on heats, heat dances and version status add a row whenever a (round, dance) is, or becomes, part of a published or live version, whoever writes it. A second round cannot enter a published order untracked. Direct non-status writes to a published heat's dance and entry rows are already refused by the 10D guard; heats and versions are Option D's. Status-only changes alter no membership.
* **Publication binds depth 0 only, never a callback Final.** A round shaped as a callback target (final directly after a preliminary in a `promote_callback` program) gets an unbound row. Round labels can only withhold a binding.
* **Only advancement binds depth n+1**, in its own transaction. Source unbound: the advancement still succeeds and the target stays unbound. Re-advancement leaves an identical row.
* A round republished with another dance or a conflicting depth gets a conflict row; publication is never refused (requirement 1).
* **Unbound** means: a round with no bound row, with a conflict row, or with any dance (history, heats, ballots, results) lacking a bound row. A cancelled round with no dance rows counts as unbound.
* So a legitimate multi-stage structure is told apart **only** by advancement lineage. Everything else of one division and dance (flights, standby, spare, replacement, second entry set, non-callback preliminary or semifinal plus Final) shares a slot, whatever its intent. Qualifying, quarterfinal and semifinal chains need an advancement model first; none produces a result today.

## 5. Dance identity

* **Identity is the catalog dance row id**, frozen once it appears in the history. Keys, names and labels are user-typed and are **not** a security boundary (Q9 requirement 8); `dance_identity` in this document means that row id.
* A dance **newly entering** a published order from a draft must have a catalog `dance_id` of the round's program that is an active offering of the heat's division, matching key and label. Advancement's copy of the source dance and memberships carried unchanged into a new version are exempt, so a deactivated offering or legacy row never blocks them. Duplicate or look-alike catalog rows are reported to staff, **not refused** (names are not a boundary, and a refusal could block publication for good once both rows are referenced).
* A referenced catalog row cannot change key or name or be deleted; no dance is added after profile lock.
* A result naming a dance with no bound slot needs independent approval.
* Two rows meaning one dance (synonyms, look-alikes) are different dances to the rule (Q2). Offerings stay manager-writable (section 6B).

## 6. The rule (option C)

**own(r)** is true when any of:
1. r is not bound for every dance of its result and of its published heats;
2. a slot of r has **ever** held another round: published, cancelled or deleted, with or without ballots or a result;
3. another round of the **same division** is **unbound** (section 4) and has a history row, a ballot, a result or a cancellation;
4. r has depth > 0 and no unrevoked advancement into r has a source bound at depth-1, not cancelled, whose source version is still that round's approved version.

5. **(proposed, Q16)** r is **amended**: its (round, dance row) memberships in any published version differ from the division's **baseline**, the memberships recorded by the first publication holding a heat of that division. A round bound by advancement with its source's dances is not amended.
6. **(proposed, Q22)** another round of the division has a recorded correction or cancellation.

**multi(r) = own(r), or multi(s) for an advancement source s of r.** Rules 2 and 3 ignore r's own advancement ancestors.

A result is **affected** when multi(r), amended(r) (if Q16 adopts it), rule 6 holds (if Q22 adopts it) or it is corrected (PR 865's history test). Rules 1-4 define own(r); 5 and 6 are proposals. For an amended result the lineage is the **whole division**, because the history cannot say which contest it replaces. Section 7's conditions apply to amended results as to multi ones. An affected result needs section 8's independence: at approval, at revalidation and at result publication. This includes **the first round**, from the moment the history holds a second one (requirements 2, 3). A result that is not affected keeps PR 865's initial rule, including the single-manager override with a substantive reason (requirement 7). No override exists for an affected result.

## 6B. Different-dance replacement (Q9): what is decided, evaluated and open

**Decided:** published results show the recorded dance ([OPTION-B2-DANCE-DISPLAY.md](OPTION-B2-DANCE-DISPLAY.md)); no blanket division-wide independence merely because a division has several dances; one-manager initial results stay; **the bypass is not accepted for activation**. Which cases option C already catches is being verified separately (requirement 5); no result of that is claimed here.

**Evaluation (requirements 6-7).** Everything is derived from the published history; no user flag, label or name decides (requirement 8).

| After the division's baseline publication | Independence under rule 5 | Legitimate cost | What it cannot see |
|---|---|---|---|
| A dance not in the baseline is added | yes | adding a forgotten dance needs an independent person | a spare already in the baseline |
| A spare or standby round is repurposed (its dances change, or a heat moves between rounds) | yes, for each round whose memberships changed; changing back does not clear it | fixing a wrong assignment after publication | a spare first published under that dance |
| A published dance assignment changes by a new running order | yes (any version differing from the baseline); direct changes to published heats or dances are refused | the same | draft edits before the baseline |
| A new round for a dance already present | already option C | | |
| An offering is added | no restriction by itself; counts once a round using it is published (first row above) | none | an offering added before the baseline |

* **Controlled amendments.** The history itself identifies an amendment. A recorded amendment step with a reason is OD-26's domain; the restriction does not depend on it. Requiring a second person **at scheduling time** was evaluated and is not proposed: it adds a workflow and protects nothing that the approval restriction does not.
* **Timing variant (Q16).** Apply rule 5 from the baseline (proposed), or only to changes after the division's first danced heat (cheaper; by reading it then covers only placement-only danced heats and future controlled changes, because a new running order is refused after a run status).
* **Coordination.** Option D guards published heats and versions; the existing 10D guard covers their dance and entry rows. Q8: amended results need section 8 with division lineage. OD-12: a verification record should store the dance row id shown to the verifier, and a later membership change should void it.

**Still open after option C and rule 5 (R-11 and B2 BLOCKED):**
* a spare included in the **baseline** under a dance row with no other round (any label), including one planned in drafts, or a duplicate or synonym row: self-approvable;
* any baseline round whose stated dance is not what was really danced: the system records the schedule, not the floor;
* a second division or event (Q3).

**Candidate closures for the owner (Q17; none adopted):**
1. Make **OD-12 independent paper verification** (already decided, unbuilt) a prerequisite of activation. By reading its design, one person can then not create typed ballot content alone: the verifier must differ from the transcriber and the adjudicator; digital ballots are the judge's own. Remaining: collusion or controlled accounts, and one person still approves. Recommended.
2. Require independence when the approver typed contributing ballots **and** the division has another round in the history. Closes the typed one-person path without OD-12, but restricts one-manager multi-dance studios that type their own ballots, close to what requirement 2 declined.
3. Division-wide independence: declined by requirement 2.

## 7. Timing, revalidation and publication (requirements 3-5)

| Timing | Outcome |
|---|---|
| Second round in the history before the first result is approved, with or without ballots | closed: approval needs independence |
| Approved alone, second round enters before that result is published | closed: publication refused until independently revalidated |
| Approved and **published** alone, second round enters later | the published result goes to **Awaiting Revalidation** (below); further multi-round publication refused until revalidated |
| The other round **never** enters the system | **open (Q15)**: nothing recorded differs from a genuine single-round initial result |

When can a second round enter after a result exists? A result needs danced heats. A new running order is refused while any heat has a run status, so by reading it is possible only when heats were danced through entry placements alone (U18's effect not re-read; whether a run status can be undone not checked), through advancement (another depth), or through a future controlled change (OD-26). The history triggers cover all of them.

**Revalidation.** `revalidate_competition_result(version, reason)`: the caller passes section 8 and is authorized to approve; the version is approved, current and unchanged (input hash). It adds an append-only row (version, person, reason, lineage snapshot, time). **The original approval row is never changed.** Several rows may exist. A version is **qualified** when its approver or any revalidator passes section 8 now.

**Result publication** (`publish_competition_round_result`, `20270122090000:352`; text md5 to be pinned, not computed) of an affected result requires: (a) that version is qualified. When multi(r), also: (b) every other **live** publication of a round in L(r) that is itself multi rests on a qualified version; (c) the source version of every **unrevoked** advancement into r, back to depth 0, is qualified where that source is multi. "Live" means the existing `_compf3_live` test: a corrected publication stays current but is not live. Refusal `COMP_REVALIDATION_REQUIRED` names the rounds. A withdrawn publication is not live (existing withdrawal; its history stays). With nobody eligible it fails closed.

Revalidation is also the way out when an approval stops qualifying (an approver who later cancels a lineage round), without a correction, which may be refused (`20270114090000:1222`).

### Awaiting Revalidation (Q14, decided)

When an authorized, validated change introduces another round that makes an already published, unqualified result require independence, that publication is held. The result, its approval, the publication and all history are unchanged.

* **Record.** Append-only hold rows (publication, causing history rows, actor, time), written under the event lock in the same transaction as the change. A publication is awaiting revalidation when it is current (not withdrawn or superseded) and has a hold with no later revalidation of its version. Only revalidation releases it; withdrawal or supersession ends it with history kept. Nothing is updated or deleted.
* **Who can trigger it.** Only the definer functions for running-order publication, advancement and any future controlled amendment (OD-26) write holds, after their own checks. The history triggers never do; drafts never do; direct writes to published placement are refused (Option D, B2-3). Anonymous, entrant and service-role callers have no path.
* **Validation and denial of service.** The added round must have at least one non-scratched entry and an offered dance; only results in that round's slots or advancement chain are held (and, if Q16 adopts rule 5, the division's results an amendment makes affected); an already qualified result is never held; the publishing manager sees the results that will be hidden and confirms; actor and cause are audited. **Remaining abuse:** an authorized manager can hide a published result, and with no eligible independent person it stays hidden (**Q19**).
* **Display.** A neutral notice, "This result is awaiting revalidation", with round and dance and **no placements, names, reasons or actors**, on the round reader, and a placeholder entry in the event list and "my results" readers (which today would omit it). Staff see the full result, the cause and who may revalidate. This is a pinned reader change; the live test (`_compf3_live`) is not changed, so condition (b) still counts the held publication. Other consumers of publications (exports, completion, later features) are **not yet inventoried**.
* A later disqualification of a revalidator does not by itself hold the result again (**Q20**); section 7's publication conditions still apply.
* The optional ban on new running orders after a placement is marked danced was presented with Q14 and is not part of the decision.

**Locks.** Approval, revalidation and result publication take the per-event lock that running-order publication takes, then the round lock (the order of round cancellation, `20270106090000` ~L439-443). Approval takes only the round lock today. **Opening a correction** locks only its round and later-sequence rounds (`20270114090000` ~L1204-1216), so it must take the event lock first too, or an approver could act on the lineage while a publication or revalidation passes. Order across advancement and result publication is **unverified**. Ballot timing no longer matters to rule 2.

## 8. Independent approval (Q8; requirement 6)

**Lineage L(r):** r; every round with a bound row in a slot of any dance r holds, at any depth, cancelled or not; rounds sharing a dance through published history or ballot evidence; advancement ancestors (revoked ones too) and their slot rounds; every unbound round of the division counted by rule 3. If r is unbound, the whole division. A round proven bound only to other dances is outside the lineage for items 4 and the publication conditions; **items 2 and 3 cover the whole division**.

The approver or revalidator must **not** have, judged by user id from section 2's sources:

| | Barred | Source |
|---|---|---|
| 1 | calculated the version | `calculated_by` |
| 2 | opened a correction of **any round of the division** (a replacement labelled with another dance cannot be told from its original by dance; reading of "associated": Q11) | causes `opened_by`; audit events |
| 3 | cancelled **any round of the division** (the superseded round may carry another dance; an unrelated reason is Q11) | `round_cancelled` events |
| 4 | entered, transcribed or modified a contributing ballot: each ballot in the evidence **and every ballot on its `supersedes_id` chain** | `submitted_by`; correction-ballot `actor` |
| Q12 (designed, not decided) | the adjudicator whose card it is; ballot contributors of an advancement ancestor that is itself multi | officials `user_id`; ancestor evidence |

Not barred as designed: contributors only to rounds outside the lineage or to non-contributing ballots; the calculator of a superseded version (so a correction that changes nothing, recalculated by someone else, lets the earlier calculator approve identical rows); the builder or publisher of the extra round (offered in Q8 and not chosen); correction co-signers, exclusion or judge-absence recorders and a pre-calculation ballot reopener (Q13). The publication-time re-check of later acts is a design choice.

**Current approval supports managers only** (requirement 10). So today only a **manager who did none of the above** is eligible: the studio's one manager can qualify when others did that work; otherwise a second manager is needed. A further qualified-approver role is designed separately in [OPTION-B2-APPROVER-ROLE.md](OPTION-B2-APPROVER-ROLE.md); nothing here depends on it being built, and without it a one-manager studio fails closed whenever that manager is barred.

**Fail closed.** The result stays unapproved or unpublished: no override, waiver or acknowledgement. `COMP_NO_INDEPENDENT_APPROVER` names why the caller is barred; a read function reports eligibility per candidate. After a correction the earlier publication is no longer live, so a round can be left with no live result.

| Situation, affected result | Today's roles (managers only) | If the separate role existed |
|---|---|---|
| One manager, any number of scorers and judges | nobody when the manager is barred (always, for corrections and cancellations) or calculated or entered; **the manager** when none of those apply, e.g. a spare they built, scored and entered by others | a designee who did none of the barred things |
| Two managers | the one who did none | either source |
| One person | nobody | nobody |

**Other designs** (all unbuilt): OD-07's co-signer must also pass items 3 and 4, through one shared predicate. OD-11's proposer, applier and confirming judge have modified; its reviewer and authorizer are Q13. OD-12's transcriber is barred and verification must precede approval and publication; its verifier is Q13. A later PR adding a way to change ballot content extends the predicate in the same PR or fails closed.

**What PR 865 (`d5c3bed52`) lacks** (read; not changed): covered are item 1, and item 2 for the same round id only. Missing: item 3; item 4; lineage; any multi-round test, so an extra round looks initial and gets the override; revalidation; a re-check at result publication; the event lock; an eligibility report; app messages for new codes.

## 9. Residuals

"Closed" means no single-staff override, and the approver or revalidator passes section 8. **It does not mean a second manager in every case**: whoever built the extra round passes if they did nothing barred. Rows assume the **same dance** unless stated.

| Case | Under option C as designed |
|---|---|
| NC, CS, CA | closed, ballots or not |
| R (heat moved to a new round) | closed: new round unbound |
| Cancelled original, or a published one later deleted, that never had a ballot | closed (rule 2; unbound legacy: rule 3). A draft never published or cancelled leaves nothing, and deleting writes no cancellation, so a deleter is not barred |
| Spare plus Final beside a single Final | closed (transitive) |
| Placement-only danced heats: a new version swaps a heat inside one round, dropping its ballots | open (inference, unexecuted); no second round exists for the rule to see |
| Spare approved before the original has ballots, or before it is calculated | closed when both are in the history; otherwise section 7 |
| Extra round enters after a self-approved publication | published result hidden as Awaiting Revalidation; further publications blocked |
| Original never in the system | open (Q15) |
| Second entry set | closed |
| **Spare labelled with another dance** | Escapes option C only while that dance has no other round of the division in the history. Rule 5 (proposed) further requires independence when it is added or repurposed after the baseline. With another round of that dance it needs independence, and the division's openers and cancellers are barred. Rule 6 (proposed, Q22) also catches it when the original was corrected or cancelled. **Open** for a spare in the baseline beside an untouched original (section 6B) |
| Duplicate catalog rows | equal normalized rows refused as hygiene; synonyms are different dances to the rule (Q2, section 6B) |
| Second division or program with the same people | open (Q3) |
| Another event; superuser; direct publication-snapshot rows; round renaming | outside this rule |

## 10. Legitimate work

* Initial result of the only round of a slot, including a callback Final reached by advancement, and a preliminary whose Final is bound by advancement or has no published heat: unchanged, one manager.
* Flights as separate rounds, standby rounds with published heats, second entry sets, non-callback preliminary or semifinal plus Final: publishable; **every** affected round needs a person who passes section 8 (today a manager who did not calculate it, open a correction or cancel in its lineage, or enter its ballots). Flights as heats inside one round are unaffected.
* A standby round with no published heat is not in the history and cannot take ballots.
* A division with an unbound sibling counted by rule 3 (typical for events already running when B2 is applied) needs independence for all its rounds.
* **Replacement after dancing:** today a new running order is refused once a heat has a run status, so an authorized replacement round after dancing (requirement 1) needs a controlled path that B2 does not build (OD-26 or OD-07).

## 11. Existing data, rollback, interplay

* No backfill by default (Q7): rounds are unbound until publication or advancement records them. Hosted approval rows on 2026-11-26: 0 (DEV and PROD).
* Rollback restores pinned texts; history tables are kept. Rolling back the rule re-opens the routes. Reverse order of section 13; Option D and PR 865 roll back only after the steps pinning them.
* PR 865 and Option D (PR 899; pin its publication post md5 `abccc653c7c2380c7ec65c97a54526dd`) and U18 (PR 867) are prerequisites.
* **OD-26** (PR 854, requirement 9): number reordering changes no history. Any controlled change that adds a round, heat or dance to a published order is recorded by the triggers and must not bypass the guards; direct table manipulation is refused (Option D for heats and versions, B2-3 for heat dances).
* OD-07: a post-completion correction stays in its round; any path creating a replacement round is recorded and counts. S4 (PR 866): `r15_guard_version_publish` runs in the same transaction and may refuse first. S3, S5: none found. S6: not examined.

## 12. Test matrix (to be written; none executed)

Refusals are checked at approval, revalidation and result publication.

| # | Case | Expected |
|---|---|---|
| C1 | first-round timing: spare approved before the original is calculated; before it has ballots; with the original cancelled unballoted or deleted | self-approval refused |
| C2 | approve alone, add second round, publish | refused until revalidated; approval row unchanged |
| C3 | publish alone, add second round, publish either again | refused until every live publication is qualified; earlier one untouched |
| C4 | withdraw the unqualified publication, then publish the other | allowed if itself qualified |
| C5 | flights, standby, second entry set, non-callback preliminary plus Final | publishable; independent person succeeds, calculator or contributor fails, first round included |
| C6 | callback preliminary to Final, one manager; Final with a live-version heat; draft-only heats; revoke and re-advance; two-stage spare | normal path self-approves; advancement refusal unchanged; spare chain refused |
| C7 | direct insert or relabel of a heat or heat dance into a published version; relabel in a draft then publish; rename or delete a referenced dance | refused, or recorded and counted (status-only row changes pass) |
| C8 | relabelled spare: labelled dance with another round; without one; offering added first; other round arriving later | independent; **self-approval passes (open, Q9)**; passes; revalidation required |
| C9 | previously approved results: independent earlier approval; several revalidations; revalidator later disqualified; version stale | counts; any qualifying one counts; stops counting; refused |
| C10 | correction attempts on a single and a multi round; later-round-ballots refusal | independence required; revalidation still available |
| C11 | concurrency: order publication vs approval, revalidation and result publication; advancement; two revalidations | serialized, no unqualified publication |
| C12 | unauthorized: scorer, judge, chair, non-event manager, anon, service role; direct writes to every new table and actor source | refused |
| C13 | canceller or opener of an other-dance original approves a relabelled replacement (with rule 6, and with another round of the label's dance); correction, flights advance, correct and re-advance, then publish the Final; correction concurrent with publication and revalidation; duplicate catalog rows, deactivated offering at advancement, legacy dances on republication | barred; Final publishable; serialized; not blocked |
| I1-I6 | items 1-4: calculator (also after gaining manager); openers and cancellers across lineage; several contributors each refused, uninvolved allowed; superseded ballot chain, including superseded before first calculation | as section 8 |
| I7-I9 | other events, divisions, bound other-dance rounds; calculator of a superseded version; builder who did nothing barred; ordinary preliminary contributor to a multi Final; partly bound round | allowed, except the partly bound round counts |
| I10 | approver later cancels a lineage round; revalidation by another; no eligible person | publication refused; then allowed; fails closed with report |
| R1 | one manager enters and calculates, second manager approves and the first publishes | allowed |
| P1 | several single-dance rounds in one division, all in the baseline; preliminary to Final by advancement; direct Final; republished, renumbered or split heats with unchanged memberships | one manager, self-approval allowed |
| P2 | semifinal plus Final of one dance; re-dance as a second round; flights | independent person required and succeeds; publishing a re-dance after a run status stays refused as today; a multi-dance single round still cannot be calculated |
| B1-B4 | relabelled spare on a dance with other rounds; new dance added after baseline; repurposed standby; dance changed then changed back | independent (B1 by option C; B2-B4 by rule 5) |
| B5-B6 | spare in the baseline under an otherwise unused dance; duplicate dance row in the baseline | **self-approval passes: open, documented** |
| B7 | dance row moved off a certified heat; label rename | refused; shown label unchanged |
| W1 | second round published by the manager after a self-approved publication | hold written in the same transaction; notice shown, no rows or names to public, entrant or anonymous; staff see it; result, approval, publication rows unchanged |
| W2 | revalidation by an eligible person; by a barred one; withdrawal; supersession | released; refused and still held; hold moot, history kept |
| W3 | draft, direct write, non-manager, anon, service role, empty round, unrelated slot, already qualified result | no hold |
| W4 | publisher confirmation missing; no eligible person (per Q19); revalidator later disqualified (per Q20); concurrency of publish and revalidate | refused; per answer; per answer; serialized |
| H1 | history immutability; event deletion cascade; rollback and re-apply; pins; ACL; existing suites before and after | refused / exact / no regression |

## 13. Phased plan (slots `20270301160000`-`169000`)

| Slot | PR | Content | Needs |
|---|---|---|---|
| `160000` | B2-1 | dance identity, offering and dedupe guard | none |
| `161000` | B2-2 | slot, history tables, read functions | B2-1 |
| `162000` | B2-3 | history triggers, publication binding, newly entering dance check, baseline (rules 5-6 if adopted) | Option D, B2-2, U18 |
| `163000` | B2-4 | advancement binding | B2-3 |
| `164000` | B2-5 | lineage, independence predicate, eligibility report (no authority change) | B2-4 |
| no SQL | B2-app | eligibility, revalidation, warnings, messages | before B2-6 |
| `165000` | B2-6 | revalidation; holds and reader notice; approval and result-publication rule; event lock | PR 865, B2-5, U18 |
| `166000` | reserved | approver role, only if separately authorized, and never before B2-6 enforces items 1-4 | Q10 |
| `167000` | B2-D | recorded-dance display (separate specification) | none |
| `168000`-`169000` | reserved | follow-ups | |

**Slot conflict:** the steps from `162000` need Option D (`20270301170000`), so a filename-order replay would run them first. The ranges need reassignment (proposal: B2 moves to `180000`-`189000`); until then the table is order of work, not final names.

Each PR: forward, rollback, SQL suite, local run, independent review. None is authorized.

## 14. Owner questions and what is not verified

Resolved: Q1 (C), Q4, Q6, Q8, Q9 (display and disclose; bypass not accepted), Q14, and Q5 for relevant-round cancellers. Open (owner decisions are now consolidated into one package, section 19): Q2, Q3, Q7, Q10-Q13, Q15-Q22.

* **Q15.** The other round never enters the system: (i) accept and disclose (recommended; requirement 7 preserves single-manager initial results); (ii) require independence for every result, which reverses requirement 7.
* **Q16.** After the baseline publication, should an added dance, a repurposed spare or a changed assignment require independent approval (rule 5)? (i) yes, from the baseline (recommended; every later edit of that kind costs a one-manager studio self-approval for those rounds); (ii) only for changes after the first danced heat; (iii) no.
* **Q17.** How is the remaining baseline-spare path closed before activation: OD-12 verification as a prerequisite (recommended), the typed-ballot restriction, both, or another adjudication?
* **Q18.** Is the dance name enough public disclosure, with the "scheduled, not confirmed as danced" notice for staff only?
* **Q22.** Should a correction or cancellation anywhere in a division make its other results require independence (rule 6)? It closes a relabelled replacement of a corrected or cancelled original; a one-manager studio then loses self-approval for the division's other results after any such act.
* **Q19.** Should a change that would hide a published result be refused when no one other than the publisher could revalidate it?
* **Q20.** Should a released result be hidden again if its revalidator later becomes disqualified?
* **Q21.** Must a replacement round be publishable after dancing has started (no controlled path exists) before activation?
* **Q10.** Which roles may approve besides managers, who grants them and by when (separate document).
* **Q11.** May a manager who cancelled a lineage round for an unrelated operational reason approve? Is a correction opened anywhere in the lineage "associated"? Designed: no, and yes.
* **Q12.** Bar the adjudicator of a card typed by someone else, and contributors to a multi ancestor's ballots? Designed: both; ordinary ancestors' contributors are not barred.
* **Q13.** May an OD-12 verifier, OD-11 reviewer or authorizer, correction co-signer, exclusion or absence recorder, or pre-calculation reopener approve? The decisions do not name them; barring any raises minimum staffing.
* **Q2.** Identity is the frozen dance row, so two rows meaning one dance differ to the rule. (i) Accept, with name dedupe as hygiene only (recommended together with Q17); (ii) let only dances with a rules-profile identity (existence not verified) bear a self-approvable result, all others needing independence.
* **Q3.** Second division with the same people and dance: accept and disclose (recommended) or refuse identical rosters?
* **Q7.** Existing published orders: leave unbound (recommended) or reviewed backfill?

**Not verified:** every B2 behavior and scenario (reading only); this text since its last review; U18 on placement-only danced heats; reversal of heat run statuses; later triggers on heat dances; the result-publication md5; lock order; other writers of results or ballot content; S6; hosted grants and data beyond the approval counts.
