# Option B2: contest identity fixed at publication (design only)

**Status: DESIGN. No code, no migration, nothing applied, nothing executed.** Owner decision 2026-11-26: design B2 (documents only); B1 is not chosen; no interim rule is built. DanceFlow Studio/Custom policy, not a governing-body rule.
Two independent reviews by reading found earlier texts did **not** close what they claimed. The owner then **decided Q8** (PR 795 section 16, `cb13176ad`): section 6A designs it. Two routes stay open (section 8: other dance, Q9; a spare with no ballot on the original, Q1). Review status of this text: see section 14.
Code claims cite files under `src/lib/supabase/migrations/` (short: the timestamp) or `src/`, read on `release/website-embeds`. **Every behavior described for B2 is unexecuted.**

## 1. What B2 must stop

Executed locally (PR 865, section 12a): from a published never-run spare heat installed by fixture, one manager published a self-approved replacement of a corrected result: spare round with the corrected round left alone (NC), cancelled (CS) or independently approved then cancelled (CA), and a spare heat moved to a new round (R). Reading shows the database planner function and publication would accept a spare round; the app planner does not create one (it schedules only the lowest-sequence round per division, `src/lib/competition/floorPlanner.ts:136`).

## 2. Verified facts the design rests on (code reading)

| Fact | Evidence |
|---|---|
| Only two stages can produce a result: a **preliminary** callback round in a `promote_callback` program, and a **final** | callback engine: `20270215090000` ~L223-224 (`round_not_callback`), `results/engines/studioCallbackTally.ts:51`; ordinal engine: `20270215090000:368-369` (`round_type_not_final`) |
| Studio setup shapes a division as one Final, or one preliminary then one Final | `src/lib/competition/scoring/studioSetup.ts:36-41, 185-190` |
| The schema also allows qualifying, quarterfinal, semifinal and other types, but no engine scores them and nothing advances them | `20260620_competition_foundation_v1.sql` ~L92-93; engines above |
| A new running order can still be published while a round holds ballots if no heat has the status staging, active or complete (a heat also counts as danced through an entry placement `danced` or `disqualified`, which this guard does not read) | `20270106090000:284-292`; HL1 `20270119090000` ~L51-64 (`_hl1_heat_is_danced`) |
| `dance_id`, `dance_key` and `dance_label` on a heat are written independently; the foreign key is on (dance_id, event) only | `20260621_competition_heat_planning_v1.sql:85-110` |
| The only advancement is preliminary (sequence n) to Final (sequence n+1) of the same division; target chosen from manager-written type and sequence | `20270120090000:209-233` (`_cf1_callback_successor` / `_source`); writer `apply_competition_round_advancement` L1236; records L100-140 (insert-only, definer-written), plus revocations |
| The Final receives its heat **from advancement**, written into the live order; advancement requires the Final to have no heats | `20270120090000` L1394-1408; `COMP_ADVANCEMENT_FINAL_HEATS_PRESENT` |
| **Multi-dance results cannot be calculated today** (verified): both engines refuse a dance count other than one | `20270215090000:175-176` (shared panel step, called by callback L267 and ordinal L378) and `:244-245`; TypeScript `results/engines/common.ts:298`, `studioCallbackTally.ts:99`; advancement refuses too (`20270120090000:1201, 1349`) |
| The floor planner makes one scoring heat per dance inside the same round for per-dance divisions, so such a round with two or more dances cannot be calculated | `floorPlanner.ts:146-159` with the row above |
| Dance catalog rows are per program, unique only on `dance_key`; the name is free; any event manager may write them; no lock at program publication was found | `20260620_competition_dance_catalog_v1.sql:7-29, 129-137` |
| Result evidence names dances as `coalesce(dance_id, dance_key)` | `20270114090000:613` |
| Publication writes an event snapshot (rounds, dances, entries); publication rows are directly insertable by managers, so they are **not** trusted lineage | `20260620_competition_generation_operations_v1.sql` (table); `20261111090000:866-1055`; insert grant per the Option D review |
| Locked programs freeze a round's type, sequence, division and program only **after** insert; new rounds are inserted freely | `20270116090000:50-85` |
| The floor-plan database function accepts any dance the division offers; managers can also write the dances of an unlocked heat directly (Option D does not guard that table) | `20261111090000:576-581`; `20260621_competition_heat_planning_v1.sql:122-123, 184-208` (later triggers not all read) |
| The public result payload names round, division and program, **not the dance** | `20270122090000:292-325` |
| A manager **or an assigned scorer** may calculate; PR 865 treats only calculator = approver as self-approval | `20270114090000:904`; `20270102090000:709-713`; PR 865 migration ~L82 |
| Advancement refuses a Final that has a non-cancelled heat with no version or in the live version | `20270120090000:1342-1343` |
| One round can hold several heats (capacity split) | `floorPlanner.ts:146-165` |
| Opening a correction (ballot reopen) and cancelling a round are manager actions | `20270102090000:1248`; `20270106090000:439` |
| Actor history that API roles cannot write or rewrite: ballot `submitted_by` (insert only through the definer path); `calculated_by`; correction causes and correction audit events; correction-ballot `actor`; round transition events (a direct status write by an API role is refused). Officials' `user_id` is immutable | `20270102090000:82, 225-227, 890, 964-971`; `20270114090000:105, 729`; `20270120095500:97-209`; `20270106090000:176-216`; `20270101090000` `guard_competition_official` |
| History rows cannot be deleted unless the whole event is | `20261107090000` `protect_competition_history_evidence` |
| The ballots a version used are listed in its evidence snapshot | `20270114090000:620-621` |
| Only a manager can approve | `20270114090000:1040` |

## 3. Data model

All new tables: RLS on, **no write privilege for any API role** (select for managers), written only by SECURITY DEFINER functions, UPDATE / DELETE / TRUNCATE refused by `protect_competition_history_evidence`, triggers ENABLE ALWAYS (the A7 pattern).

* `event_competition_contest_slots`: `id, event_id, program_id, division_id, dance_identity text, depth int, created_at, created_by, transaction_id`; **unique (event_id, division_id, dance_identity, depth)**.
  One slot is "this division, this dance, this stage". Depth 0 is the first stage; depth n+1 exists only by advancement.
* `event_competition_contest_slot_rounds`: `slot_id, round_id, event_id, bound_via ('publication'|'advancement'), schedule_version_id, advancement_id, bound_at, bound_by`; unique (round_id, slot_id); **a round's depth is fixed by its first binding** (a later binding at another depth is refused).
* `event_competition_contest_slot_refusals` is not needed: refusals raise.

**One slot per dance**, not per dance set: a round holding Waltz and Tango binds two slots, so a round with an overlapping set cannot escape. Entries are **not** part of the key, so a second entry set in the same division and dance lands in the same slot.

**References:** the slot tables reference only the event (cascade, the same exception as other history). Round and division ids carry no foreign key, so removing a never-run division or round before publication keeps working; under Q1 option B a left-over row is harmless (a round with ballots or results cannot be deleted); under options A and C it **keeps counting**: a cancelled round, or a published never-run round deleted from an unlocked program, occupies the slot permanently.

## 4. Stage comes only from the advancement graph

* **Publication binds depth 0 only, and never binds a callback Final.** For every round with heats in the version being published, one binding per heat dance to the division's depth-0 slot, whatever the round's name or sequence. A round that is shaped as the target of a callback (final, directly after a preliminary, in a `promote_callback` program) is **left unbound**: only advancement may bind it. Reading those labels here can only withhold a binding (unbound is the stricter state), never grant one.
* **Advancement binds depth n+1.** `apply_competition_round_advancement`, in its own transaction, binds the target to the slot at (source depth + 1) for each of its dances, with the advancement id. No other path creates a deeper slot.
  * Source unbound or without a catalog dance: the advancement still succeeds and the target stays unbound (never fail an advancement).
  * Re-advancement after a revocation: an existing identical binding is left as it is; section 6 reads the advancement tables, not the binding's advancement id.
* A round already bound that is republished with another dance, or at a depth that would conflict, **stays unbound for that dance**; publication is never refused for this. Unbound for any of its dances means replacement (section 6).
* Advancement already refuses a Final holding a heat in the live version or without one, so a preliminary and Final published together cannot be advanced today; B2 does not change that. A Final run that way stays unbound.
* So a spare round published by a manager is depth 0 (the same slot as the first round of that division and dance) or unbound.

Stages needing an advancement model before they can have their own slot: qualifying, quarterfinal, semifinal and any multi-round chain. None can produce a result today, so nothing in use is lost. A preliminary in a program that does not advance by callback shares depth 0 with the division's Final: the second of them is in the same slot (effect per Q1).

## 5. Dance identity, locking, deduplication

* `dance_identity` = the catalog dance's `dance_key`, normalized (trim, lower case, spaces and punctuation removed).
* **At running-order publication** (not only at profile lock, which publication does not require): every heat dance must carry a catalog `dance_id` of the round's program; its `dance_key` and `dance_label` must equal the catalog row's; and the program's catalog must have no two rows whose normalized key or name equal each other (key against key, name against name, key against name). Programs locked before B2 are checked here too.
* **Freeze:** a catalog row referenced by any binding or any published heat can no longer change its key or name or be deleted, whatever the program's lock state; after profile lock no dance is added either (new guard).
* A result whose evidence names a dance that does not map to a bound slot gets no single-staff override (fail closed).
* **Residual, stated:** synonyms ("Waltz" and "Slow Waltz") and look-alike or zero-width characters in custom names are different identities to this rule. Closing that needs a fixed taxonomy from the locked rules profile, with custom dances losing the override (owner question Q2).

## 6. The rule

For a round r with a result version V, define **own(r)** as true when any of:
1. r is not bound for **every** dance of V and of its current published heats (unbound = fail closed);
2. another round **of a slot of r** has ever had a ballot or a result version (cancelled or not). Slot membership is the bindings **together with** the dances of currently published heats, so a dance row changed during publication cannot hide a sibling. (Q1 option C widens this to any other round ever bound to the slot.)
3. another round of the **same division** has a ballot or a result version and is **unbound**: it has no binding, or its bindings do not cover every dance on its heats, ballots and results. A round with no binding always counts, including a cancelled one whose heats were cancelled with it (`20270106090000:474-476`);
4. r has depth > 0 and there is no unrevoked advancement into r whose source round is bound to the depth-1 slot, is not cancelled, and whose source version is still that round's approved version.

**replacement(r) = own(r), or replacement(s) for any advancement source s of r, evaluated now, back to depth 0.** Rules 2 and 3 ignore r's own advancement ancestors as "other rounds". Without the transitive part, a manager can build a spare preliminary and Final beside a real single Final, approve the spare preliminary before the real round has ballots, advance it, and self-approve the spare Final.

**Approval** (`approve_competition_round_result`, on top of PR 865's post text md5 `2d178c29177ebf2ec14a46bf510ccc12`): PR 865's initial rule is unchanged. If replacement(r) **or the result is corrected**, the approver must pass section 6A. No override of any kind.

**Open design gap:** a version approved while it was neither (for example self-approved as initial) and failing the re-check at publication has no re-approval path read in the current code. It would need a correction and a new version, whose opener is then barred. To be resolved before B2-6.

**Result publication re-applies the whole test** (`publish_competition_round_result`, `20270122090000:352`; its text md5 is to be pinned at implementation, not yet computed): if the result is a replacement or corrected at publication time, the recorded approver must pass section 6A's independence items as of now, whether the approval was an override or ordinary. This covers a spare approved first and the real round run, corrected or cancelled before publication, and an approver who acts on the lineage after approving.

**Timing and locks.** The test is a check at the moment of approval and of publication, taken under the existing round lock. B2 does **not** add an event lock to ballot filing, calculation or correction (that would redefine pinned E2 and F2 functions with no slot here). A concurrent first ballot in a sibling round is therefore equivalent to that ballot arriving just after: publication re-checks, and what slips past both is exactly the residual "published before the other round had a ballot".

## 6A. Independent approval (Q8, decided)

Owner decision 2026-11-26, DanceFlow Studio/Custom policy. Applies to **replacement** (section 6) and **corrected** (PR 865's history test) results. Initial results are unaffected.

**Lineage L(r)**, the rounds whose history counts:
* r itself;
* every round of the division ever bound to a slot of **any dance r is bound to**, at any depth, cancelled or not, plus rounds sharing a dance through current published heats or ballot evidence;
* r's advancement ancestors (revoked advancements included) and their slot rounds;
* every **unbound** round of the division with a ballot, result or cancellation (it cannot be proven unrelated). If r itself is unbound, the whole division.

This **replaces the earlier division-wide bar**: a round proven bound to other dances is unrelated and disqualifies nobody. A cancelled real Final at another depth stays in the lineage through the shared dance. Under Q9 option (ii) the lineage would have to widen again.

**The approver must not be any of these**, judged by user id from the sources in section 2:

| Item | Barred | Source |
|---|---|---|
| 1 | calculated the version being approved | `calculated_by` |
| 2 | opened a correction of any lineage round | correction causes `opened_by`; correction audit events |
| 3 | cancelled any lineage round (intent is not recorded, so every such cancellation counts: an interpretation, Q11) | round transition events `round_cancelled` |
| 4 | entered, transcribed or modified a **contributing ballot**: a ballot in the version's evidence snapshot and every version it supersedes | ballot `submitted_by`; correction-ballot `actor` |
| 4, extended (interpretations, Q12) | the adjudicator whose card it is (their marks, even when a scorer typed them); contributing ballots of an advancement ancestor that is **itself** a replacement | officials `user_id`; ancestor evidence |

Not barred: someone who entered ballots only for rounds outside the lineage, or for lineage rounds whose ballots do not contribute (item 4 names contributing ballots); the calculator of a superseded version; whoever published or created the replacement round (that option was presented and not chosen).

**Authority.** Independence is not enough: the approver must hold an authorized event-level role **at approval time**. Today only a manager can approve, so this is a new dependency:
* `event_competition_approver_designations`: append-only grant and revocation rows (event, user, official row, basis, designated by, at), written only by a definer function a manager calls; the holder needs an active official row, verified email and no OD-05 conflict. It should be the same concept and table as OD-07's "independent designated reviewer".
* Eligible = manager, or holder of an unrevoked designation. A second manager is **not** required. Which official roles may be designated, who may designate (including a manager who is barred) and by when are Q10.
* The approve function's role gate, the result read functions and grants, and the app screens must admit the designee. Body-declared events stay fail closed until OD-06 roles exist.
* Disqualification is permanent whatever role the person later holds; authority is judged at approval and recorded (`approver_basis`). A later revocation does not undo an approval; a later disqualifying action blocks publication.

**Fail closed.** With no eligible, independent person the result stays calculated and unpublished: no override, waiver or acknowledgement. Refusal code `COMP_NO_INDEPENDENT_APPROVER` names the items that bar the caller; a read function lists, per candidate, whether and why they are barred, so the studio sees the **operational limitation** before it matters. After a correction the earlier publication is no longer live, so the event can be left with **no live result** for that round.

**What this means for a small studio** (assuming the designation exists; until it does, only a second manager can qualify):

| Situation | Who can approve |
|---|---|
| Corrected result: manager opened it (always, today) | never that manager; needs another qualified person who did not calculate or enter |
| One manager + one scorer who enters or calculates, correction or cancellation | **nobody**: a third qualified person is required |
| Judges enter digitally, manager opens and calculates | one designated non-judge |
| Spare beside an approved original that nobody corrected or cancelled; scorer enters and calculates | **the manager**, even if they built the spare (a consequence of Q8 as decided; matters for Q1 and Q9) |
| One person only | nobody |

**Coordination.**
* **OD-07** (post-completion cases, unbuilt): its co-signer rule (not initiator, not calculator, designated reviewer) must also apply items 3 and 4; the initiator counts as "opened". One shared predicate, called by approval, publication and case approval.
* **OD-11** (unbuilt): proposer and applier of a confirmed correction, and the confirming adjudicator, have transcribed or modified. Its reviewer and authorizer are not named by Q8's text (Q13).
* **OD-12** (unbuilt): transcriber is `submitted_by`, so barred. Verification must be complete before approval and publication. The text does not say a verifier is barred (Q13). Its verification rows and OD-11's proposals are append-only sources.
* Any later PR that adds a way to enter or change ballot content must extend the predicate in the same PR, or fail closed.

**What PR 865 lacks for corrected results** (read; PR 865 is not changed):

| Requirement | PR 865 `d5c3bed52` |
|---|---|
| Item 1, calculator | covered |
| Item 2, correction opener | covered for **the same round id only** |
| Item 3, canceller | **missing** |
| Item 4, ballot entry, transcription, modification | **missing** |
| Lineage | **missing**: history is read for one round, so a replacement round looks initial and gets the single-staff override |
| Designated non-manager approver | **missing**: role gate still manager only |
| Re-check at result publication | **missing** (only approval is redefined) |
| Operational-limitation report; app message for the new code | missing |

Not verified: the sources against hosted data; who physically transcribes when another person is signed in; shared or controlled accounts (inherent limits).

## 7. Planner and publication changes

* `publish_competition_schedule_version` (after Option D it is definer and locks the version; pin D's post md5 `abccc653c7c2380c7ec65c97a54526dd`): check catalog dance ids, create missing depth-0 slots, insert bindings, all in the publication transaction. Publication of a version is already refused once any heat has run (`COMPO1_RUN_IN_PROGRESS`).
* Owner question Q1 (section 13) decides what publication does when a slot already has a round. Under option A the refusal lives here, under the event lock, for the same version and across versions; rounds without heats are invisible to it but cannot take ballots without published heats (`20270102090000:413-427`).
* `apply_competition_round_advancement`: add the depth binding (pinned replacement).
* App (separate PR, before the approval change is applied): show who is eligible to approve and why others are barred (section 6A); warn before a publication puts a second round into a slot; map the new code. The app planner needs no behavior change to stay correct.

## 8. Residuals

"Closed" means only: the replacement cannot take the single-staff override and its approver must pass section 6A. It does not mean a second manager, and whoever built the replacement round passes if they did none of the barred things. Every "closed" row assumes the replacement carries the **same dance**.

| Case | Under B2 as designed (Q1 option B) |
|---|---|
| **Spare labelled with another dance the division offers**, same couples | **open** (Q9): different slot, original is bound, so the single-staff override applies. Defeats NC, CS, CA and the two-stage spare; the public result does not show the dance |
| NC, CS, CA with a same-dance spare | closed: same slot, which has ballots |
| R (heat moved to a new round) | closed: the new round is unbound |
| Same-dance spare beside an approved, uncorrected, uncancelled original; scorer enters and calculates; the manager who built it approves | **passes** section 6A (Q8 as decided) |
| Spare preliminary plus Final beside a single Final, real round run before the spare Final is approved or published | closed by the transitive rule |
| Round left with ballots and never calculated, then a spare | closed (ballots count) |
| Legacy or unbound sibling with ballots | closed (rule 3) |
| Spare run first and approved, real round gets a ballot before result publication | closed at publication |
| **Spare approved and published while the original has no ballot**: not yet filed, never filed in the system (paper, floor), or cancelled before any | **open** under B; see Q1 for A and C |
| Second entry set, same division and dance | closed (entries are not in the key) |
| Duplicate catalog records with equal key or name | closed (section 5) |
| Synonym or look-alike dance names | **open** (Q2) |
| A **second division** (or program) with the same people and dance | **open**: nothing trusted distinguishes it from a legitimate category. It has to be in a published order; whether a new order can follow danced heats depends on heat run statuses and on U18 (Q3) |
| **Another event** | **open**, out of scope |
| Direct publication-row inserts, round renaming | not lineage; see Option D's list |
| Database superuser | outside the threat model |

**Legitimate work affected (option B):** once a sibling has a ballot or result, later rounds of that division and dance that are not advancement (flights, re-dance, non-callback preliminary plus Final) need an independent approver; **whichever is approved and published before any sibling has a ballot passes single-handed**. Every round of a division needs one while an unbound sibling with ballots exists (typical for events already running when B2 is applied). Single-person initial approval is unchanged for the only round of a slot, including a Final reached by advancement.

## 9. Already published orders and rollback

* No backfill of history by default: existing rounds are unbound, so they need independent approval until a publication or advancement binds them; an event with a heat in a run status cannot re-publish, so its rounds stay unbound (an event whose heats count as danced only through entry placements can still publish, as far as this guard goes; U18's effect on that path was not re-read). Hosted counts read 2026-11-26: 0 approval rows on DEV and PROD; entry counts were not re-read for this design. Re-check before any apply (Q7).
* Rollback per step restores pinned function texts. Slot tables hold history: rollback keeps them; dropping them is a separate step allowed only when empty. Rolling back the approval step re-opens the four routes. Order: approval and result publication, then designations (rows are history and stay), advancement, publication binding, tables, dance guard; Option D and PR 865 are rolled back only after the steps that pin them.

## 10. Interplay

| Item | Effect |
|---|---|
| PR 865 (R-11) | prerequisite; B2 redefines approval on its pinned text and adds history beside its three sources |
| Option D (PR 899) | prerequisite: bindings mean little if published placement can be rewritten; B2 pins D's publication text |
| U18 (PR 867) | prerequisite for the "no new order after a heat ran" property and so for the bounded second-division residual (otherwise direct danced writes avoid it) |
| OD-07 (PR 838) | a post-completion correction stays in the same round, so same slot; any OD-07 path that creates a replacement round must bind the same slot and count as replacement |
| OD-12 (PR 845) | paper ballots count as ballots; a verification step adds nothing to lineage |
| OD-26 (PR 854) | reorders numbered heats only; bindings do not depend on heat numbers. A future move of an entry or round between published heats must not rebind |
| S3 (PR 864) | panel readiness: none |
| S4 (PR 866) | `r15_guard_version_publish` runs inside the same publication transaction and may refuse first; no shared function redefined |
| S5 (PR 863) | participant age: none |
| S6 | not examined |

## 11. Test matrix (all to be written; none executed)

| # | Case | Expected |
|---|---|---|
| T1-T4 | NC, CS, CA, R replayed from the probe; each also with a scorer calculating and with a relabelled dance | override refused; calculator, opener and canceller refused; a person outside the barred set approves |
| T5 | ballots locked, never calculated, round cancelled, spare run | refused |
| T5b | single Final against a spare preliminary plus Final (spare preliminary approved first) | spare Final refused at approval and publication |
| T5c | legacy or unbound sibling with ballots, spare published after B2 | refused |
| T5d | spare approved by another manager, original then corrected or cancelled by A, publish attempted | refused while the approver is the calculator, opener or canceller |
| T6 | spare first (self-approved), then original with ballots, publish the spare | publication refused |
| T7 | second entry set, same division and dance | same slot, refused |
| T8 | duplicate normalized key or name at publication; rename or delete of a referenced dance, locked or not; heat label differing from the catalog row | refused |
| T9 | free-text heat dance at publication; result with unmapped dance | refused / no override |
| T10 | preliminary to Final by advancement, single manager; Final holding a live-version heat; Final holding only draft-version heats; revoke then re-advance | override allowed on both; live-version heat: advancement refused as today; draft only: advances; publication never binds the Final; re-advance succeeds |
| T11 | Final after the advancement is revoked, or source cancelled or corrected | needs an independent approver |
| T12 | spare "Final" published without advancement after a callback | depth 0: needs an independent approver |
| T13 | separate one-dance rounds for different dances (including a relabelled spare); same couple in two divisions | override allowed (documented open routes: Q9, Q3) |
| T14 | multi-dance round | calculation refused (unchanged) |
| T15 | single round of a slot; correction then self-approval | allowed; then refused by PR 865 |
| T16 | unbound legacy round | needs an independent approver |
| T17 | concurrency: publish vs approve, advancement vs approve, sibling ballot vs approve, two publications | consistent bindings; a sibling ballot racing approval is caught at result publication |
| T18 | history: update / delete / truncate of slots and bindings; API-role writes; event deletion cascade | refused / cascade only |
| T19 | rollback and re-apply per step; md5 pins; ACL unchanged | exact |
| T20 | existing suites (F2, A0 advancement, A3, A5, A6, F3, 10D, O1, R-11, D) before and after | no regression |

Independence matrix (section 6A). Each runs on a corrected result and on a replacement; every refusal is checked at approval **and** publication.

| # | Case | Expected |
|---|---|---|
| I1 | calculator approves; calculator is a scorer later made manager | refused |
| I2 | opener of this round's correction; opener of a correction on a lineage sibling or ancestor | refused |
| I3 | canceller of the superseded round; of a same-dance round at another depth | refused |
| I4 | sole transcriber of the paper ballots; judge entering their own ballot | refused |
| I5 | several contributors: A enters heat 1, B heat 2, C corrects one ballot; each approves | all refused; uninvolved D allowed |
| I6 | entrant of a superseded version of a contributing ballot | refused |
| I7 | adjudicator of a scorer-typed card; entrant of a replacement ancestor's ballots | refused (Q12) |
| I8 | entrant of ballots in another event, another division, or another dance's bound round | **allowed** |
| I9 | canceller or opener on a round proven bound to another dance; same on an unbound round | allowed; refused |
| I10 | calculator of the superseded version only; builder of the spare who did nothing barred | **allowed** |
| I11 | designated scorer or chair, not a manager, independent | **allowed** |
| I12 | undesignated scorer; revoked or inactive designee; conflicted designee | refused |
| I13 | role changes: barred person gains manager role or designation; official deactivated between approval and publication | still barred; approval stands |
| I14 | approver cancels a lineage round or opens a correction after approving, then publication | publication refused |
| I15 | no eligible person; eligibility report | fails closed, report lists reasons; no override accepted |
| I16 | replacement attempts NC, CS, CA, R and two-stage, each with manager, scorer, judge and designee as approver | only an independent, authorized person succeeds |
| I17 | initial result of the only round of a slot, calculator with substantive reason | allowed (unchanged) |
| I18 | direct API writes to every actor source and to designations; concurrency: designate or revoke vs approve | refused; consistent |

## 12. Phased plan (slots `20270301160000`-`169000`)

| Slot | PR | Content | Needs |
|---|---|---|---|
| `160000` | B2-1 | dance catalog identity, dedupe and lock guard | none (independent) |
| `161000` | B2-2 | slot and binding tables, immutability, read functions | B2-1 |
| `162000` | B2-3 | publication binds depth 0 and checks dance identity | Option D, B2-2, U18 |
| `163000` | B2-4 | advancement binds depth n+1 | B2-2, B2-3 |
| `164000` | B2-5 | approver designations, read access, eligibility report | Q10; coordinate OD-05/06/07 |
| no SQL | B2-app | designation, eligibility and planner screens | B2-5; before B2-6 is applied |
| `165000` | B2-6 | lineage and independence predicate; approval and result-publication rule | PR 865, B2-3, B2-4, B2-5, U18 |
| `166000`-`169000` | reserved | follow-ups (backfill, taxonomy, OD sources) | |

The designation (B2-5) must be usable before B2-6 enforces, or one-manager studios lose every corrected result. Items 1 to 4 for same-round corrections need no slots, so they could be shipped earlier as a separate step on PR 865's text; that is a sequencing choice not made here.

Each PR: forward, rollback, SQL suite, local run, independent review. None is authorized yet.

## 13. Owner questions

**Decided:** B2 (design only); **Q8** (section 6A). Q8 also answers **Q5** (a canceller of the superseded round may not approve its replacement) and **Q6** (no self-approval exception: without a qualified independent person it fails closed; one-manager studios keep working only where another authorized person qualifies). Q6's follow-on, which roles qualify, is Q10.

**Open, one at a time:** **Q1** (being put to the owner now), then Q9, Q10, Q11, Q12, Q13, Q4, Q2, Q3, Q7.

### Q1. What happens when a second round of the same division and dance is put into a published running order?

| | **A. Refuse publication** | **B. Allow, rule as designed** | **C. Allow; any other round ever bound to the slot makes each one need an independent approver** |
|---|---|---|---|
| Blocks | any second bound round, same or later version, permanently (a cancelled or deleted one still holds the slot) | single-staff approval only after a sibling has a ballot or result | single-staff approval of **every** round in a slot that ever held two, including the first |
| Same-dance spare published first, original without ballots | closed when both are bound rounds: only one can be in the slot. Does not depend on approver rules | **open** | closed **if** the other round is bound before the spare's result is published; open if it never enters the system, or is published afterwards where the run guard permits; and "closed" is only as strong as section 6A (the builder of the spare can pass) |
| Still lets through | other dance (Q9), callback-shaped Finals (never bound), unbound legacy rounds absent from the new version, second division, another event | the same, plus the row above | as A, plus the condition above |
| Flights as separate rounds, standby or spare rounds, second entry set, non-callback preliminary or semifinal plus Final of one dance | cannot be published. Flights as heats inside one round still work | publishable; first one with no sibling ballot passes alone | publishable; all need an independent approver |
| Round replaced before the event day (published, then deleted or cancelled, new one) | new one **cannot be published, even with two people** | no effect if never balloted | needs an independent approver |
| Re-dance as a new round after heats ran | already refused today (`COMPO1_RUN_IN_PROGRESS`, `20270106090000:284-292`) while a heat has a run status; A refuses it otherwise too | today's guard, then independent approver | same as B |
| Who can approve what the option catches | not applicable to refused rounds | a person passing section 6A; one person alone: nobody | the same, for every round of a doubled slot |
| App's own planner and Studio setup | unaffected in the normal path: the planner schedules one round per division (`floorPlanner.ts:136`) and the callback Final is bound by advancement (`studioSetup.ts:36-41, 185-190`) | same | same |

**Recommendation: C.** It narrows the open case that B leaves without A's permanent dead end. A is stronger where it applies (no timing condition, no dependence on approver rules) at the cost of legitimate publications that no one can override. No option closes Q9.

Dependencies: A largely moots Q4; C makes Q4 "yes". Q7 follows the choice. B and C need the designation of section 6A to be usable by a one-manager studio.

### Remaining questions

* **Q9.** A spare labelled with another offered dance: (i) show the dance on the published result and disclose that the route stays open (recommended; needs a publication-payload change not yet slotted, and does not stop wrong marks under a different dance); (ii) treat any other round of the division with a ballot or result as making it a replacement, which widens the lineage to the division and affects every multi-dance division after its first dance; (iii) disclose only.
* **Q10.** For Studio/Custom, which official roles may be designated to approve (chair; scorer; another verified person with an official row), who may designate (any manager, or only one not barred), and must the designation predate the correction or the replacement's calculation (recommended: yes, as OD-07 proposes; the cost is that a studio that designated nobody cannot fix that mid-event)?
* **Q11.** May a manager who cancelled a lineage round for an unrelated operational reason approve its replacement? Designed: no, because intent is not recorded.
* **Q12.** Beyond the four items' wording, bar (a) the adjudicator whose card was typed by someone else, (b) entrants of an advancement ancestor's ballots when that ancestor is itself a replacement? Designed: both. For an ordinary preliminary feeding a replaced Final, its entrants are **not** barred: confirm.
* **Q13.** May an OD-12 verifier, or an OD-11 reviewer or authorizer, approve the result? The text does not bar them. Barring them raises the minimum staffing by one.
* **Q4.** Must separate non-advancement rounds of one division and dance (flights) all need independent approval? Under B, only those approved after a sibling has a ballot do; "yes for all" is option C.
* **Q2.** Custom dances: accept per-program deduplication (synonyms remain open), or require rules-profile dance identities and withdraw the single-staff override from custom dances (a one-person studio then cannot approve any custom-dance result alone, initial ones included)? Neither stops choosing another real dance (Q9).
* **Q3.** A second division with the same people and dance: accept and disclose (recommended), or refuse identical rosters at publication (would refuse legitimate twins; changing one entry likely avoids it, an inference)?
* **Q7.** Existing published orders: leave unbound, needing independent approval (recommended), or build a reviewed backfill?

## 14. Not verified

Every B2 behavior and every scenario above (reading only, nothing executed); section 6A and the changes made for Q8 until an independent review is recorded here; U18's effect on entry-only danced heats; later triggers on the heat-dance table; the md5 of the result-publication function; whether any other writer creates result-bearing stages or ballot content; the sibling-ballot race; S6; hosted grants and data beyond the 2026-11-26 approval counts.
